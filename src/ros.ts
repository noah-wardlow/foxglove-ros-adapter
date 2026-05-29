/**
 * Ros class — drop-in replacement for roslib's ROSLIB.Ros.
 *
 * Manages the WebSocket connection to foxglove_bridge and maintains
 * a registry of available channels (topics) and services. Higher-level
 * classes (Topic, Service, Action) use this to subscribe, publish, and call.
 */

import { parse as parseRosMsgDefinition } from "@foxglove/rosmsg";
import { MessageReader, MessageWriter } from "@foxglove/rosmsg2-serialization";

import {
  FoxgloveProtocolClient,
  type ServiceCallResponse,
  type ServiceCallFailure,
  type ParameterValue
} from "./protocol";
import type { FoxgloveChannel, FoxgloveService } from "./types";

type RosEventName = "connection" | "error" | "close";
// roslib emits "connection" / "close" with no args and "error" with an Error.
// Split callback types so each `on()` overload type-checks at the call site
// without the caller having to widen `e` to `unknown` and narrow back.
type RosLifecycleCallback = () => void;
type RosErrorCallback = (error: Error) => void;

/** Callback for incoming topic messages (deserialized to JS objects). */
export type MessageCallback<T = unknown> = {
  bivarianceHack(message: T): void;
}["bivarianceHack"];

/**
 * Normalize a ROS message/service type string to canonical `pkg/msg/Name` or
 * `pkg/srv/Name` form. Accepts and corrects:
 *   - leading slash (`/std_msgs/msg/String` → `std_msgs/msg/String`)
 *   - ROS 1 style (`std_msgs/String` → `std_msgs/msg/String`)
 *   - already-canonical forms (left untouched)
 */
function normalizeRosType(type: string, kind: "msg" | "srv" = "msg"): string {
  const trimmed = type.replace(/^\/+/, "");
  if (trimmed.includes(`/${kind}/`)) {
    return trimmed;
  }
  const slash = trimmed.indexOf("/");
  if (slash === -1) {
    return trimmed;
  }
  return `${trimmed.slice(0, slash)}/${kind}/${trimmed.slice(slash + 1)}`;
}

/**
 * Translate roslib-style parameter names (`/node:param`) to the `/node.param`
 * form foxglove_bridge expects so callers written against rosbridge keep working.
 */
function toFoxgloveParamName(name: string): string {
  return name.replaceAll(":", ".");
}

/** Pending service call awaiting a response. */
interface PendingServiceCall {
  resolve: (response: Record<string, unknown>) => void;
  reject: (error: Error) => void;
  responseReader: MessageReader | null;
}

/** Active topic subscription. */
interface ActiveSubscription {
  subscriptionId: number;
  channelId: number;
  callbacks: Set<MessageCallback>;
  reader: MessageReader;
}

/** Pending subscriber waiting for a channel to be advertised. */
interface PendingSubscriber {
  topic: string;
  messageType: string;
  callback: MessageCallback;
}

/** Client-advertised channel for publishing. */
interface ClientChannel {
  clientChannelId: number;
  topic: string;
  schemaName: string;
  // Wire encoding agreed with the server at client-advertise time. CDR is the
  // hot path (matches the binary encoding used for subscribe traffic); JSON is
  // the fallback when we can't build a CDR writer because the schema isn't on
  // any server-advertised channel (e.g. startup race, or a type the ROS
  // interface registry hasn't surfaced yet).
  encoding: "cdr" | "json";
  // Non-null only when encoding === "cdr".
  writer: MessageWriter | null;
}

export class Ros {
  private readonly protocol = new FoxgloveProtocolClient();
  private readonly connectionListeners = new Set<RosLifecycleCallback>();
  private readonly closeListeners = new Set<RosLifecycleCallback>();
  private readonly errorListeners = new Set<RosErrorCallback>();

  // Channel/service registries populated by foxglove_bridge advertisements
  private readonly channels = new Map<number, FoxgloveChannel>(); // channelId → channel
  private readonly channelsByTopic = new Map<string, FoxgloveChannel>(); // topicName → channel
  private readonly services = new Map<number, FoxgloveService>(); // serviceId → service
  private readonly servicesByName = new Map<string, FoxgloveService>(); // serviceName → service

  // Subscription state
  private readonly subscriptions = new Map<number, ActiveSubscription>(); // subscriptionId → sub
  private readonly subscriptionsByTopic = new Map<string, ActiveSubscription>(); // topic → sub
  private readonly pendingSubscribers: PendingSubscriber[] = [];

  // Publishing state
  private readonly clientChannels = new Map<string, ClientChannel>(); // topic → client channel

  // Service call correlation
  private readonly pendingServiceCalls = new Map<number, PendingServiceCall>(); // callId → pending

  // Splitting onValues/onClose lets callers distinguish "param missing"
  // (resolve null) from "WebSocket closed before reply" (reject).
  private readonly pendingParamRequests = new Map<
    string,
    {
      onValues: (params: ParameterValue[]) => void;
      onClose: () => void;
    }
  >();
  private nextParamRequestId = 1;

  // Compiled reader/writer caches keyed by the canonical schema name plus the
  // full schema text. The full text is the only collision-free identity:
  // schema.length alone collides for equal-length schemas, and schemaName alone
  // collides across distros that share a type name but evolve its fields.
  // MessageReader / MessageWriter internally pre-compile per-type decode paths
  // from a MessageDefinition list, so we reuse them across messages instead of
  // re-parsing the schema on every topic/service hit.
  private readonly readerCache = new Map<string, MessageReader>();
  private readonly writerCache = new Map<string, MessageWriter>();

  isConnected = false;

  constructor(options?: { url?: string }) {
    this.setupProtocolHandlers();
    if (options?.url) {
      this.connect(options.url);
    }
  }

  connect(url: string): void {
    this.protocol.connect(url);
  }

  close(): void {
    this.protocol.close();
    this.isConnected = false;
  }

  on(event: "error", callback: RosErrorCallback): void;
  on(event: "connection" | "close", callback: RosLifecycleCallback): void;
  on(
    ...args:
      | [event: "error", callback: RosErrorCallback]
      | [event: "connection" | "close", callback: RosLifecycleCallback]
  ): void {
    const [event, callback] = args;
    switch (event) {
      case "connection":
        this.connectionListeners.add(callback);
        break;
      case "close":
        this.closeListeners.add(callback);
        break;
      case "error":
        this.errorListeners.add(callback);
        break;
    }
  }

  off(event: "error", callback: RosErrorCallback): void;
  off(event: "connection" | "close", callback: RosLifecycleCallback): void;
  off(
    ...args:
      | [event: "error", callback: RosErrorCallback]
      | [event: "connection" | "close", callback: RosLifecycleCallback]
  ): void {
    const [event, callback] = args;
    switch (event) {
      case "connection":
        this.connectionListeners.delete(callback);
        break;
      case "close":
        this.closeListeners.delete(callback);
        break;
      case "error":
        this.errorListeners.delete(callback);
        break;
    }
  }

  /**
   * roslib-compatible bulk listener removal. Tests use this to reset the
   * module-level mock Ros between cases; production code does not call it.
   */
  removeAllListeners(event?: RosEventName): void {
    if (event === undefined) {
      this.connectionListeners.clear();
      this.closeListeners.clear();
      this.errorListeners.clear();
      return;
    }

    switch (event) {
      case "connection":
        this.connectionListeners.clear();
        break;
      case "close":
        this.closeListeners.clear();
        break;
      case "error":
        this.errorListeners.clear();
        break;
    }
  }

  emit(event: "error", error: Error): void;
  emit(event: "connection" | "close"): void;
  emit(event: RosEventName, error?: Error): void {
    switch (event) {
      case "connection":
        this.emitLifecycle("connection", this.connectionListeners);
        break;
      case "close":
        this.emitLifecycle("close", this.closeListeners);
        break;
      case "error":
        this.emitError(error ?? new Error("ros emit('error') called without an error"));
        break;
    }
  }

  private emitLifecycle(
    event: "connection" | "close",
    listeners: Set<RosLifecycleCallback>
  ): void {
    for (const cb of listeners) {
      try {
        cb();
      } catch (e) {
        console.warn(`Error in Ros "${event}" handler:`, e);
      }
    }
  }

  private emitError(error: Error): void {
    for (const cb of this.errorListeners) {
      try {
        cb(error);
      } catch (e) {
        console.warn('Error in Ros "error" handler:', e);
      }
    }
  }

  // ─── Channel/Service Lookups ────────────────────────────────────────────

  getChannel(topic: string): FoxgloveChannel | undefined {
    return this.channelsByTopic.get(topic);
  }

  getServiceByName(name: string): FoxgloveService | undefined {
    return this.servicesByName.get(name);
  }

  /**
   * Return every advertised topic whose schema matches `messageType`. Matches
   * roslib's `Ros#getTopicsForType(type, success, fail)` callback API so
   * existing callers (e.g. `useImageTopics`) can use this adapter unchanged.
   */
  /**
   * The roslib signature also accepts an `onError` callback. Foxglove resolves
   * synchronously from the in-memory channel registry, so the failure path is
   * unreachable; we drop the parameter to keep lint clean. Callers that pass
   * one are unaffected — extra arguments to a JS function are ignored.
   */
  getTopicsForType(messageType: string, onSuccess: (topics: string[]) => void): void {
    const canonical = normalizeRosType(messageType, "msg");
    const topics: string[] = [];
    for (const ch of this.channels.values()) {
      if (normalizeRosType(ch.schemaName, "msg") === canonical) {
        topics.push(ch.topic);
      }
    }
    onSuccess(topics);
  }

  // ─── Topic Subscription ─────────────────────────────────────────────────

  subscribeTopic(topic: string, messageType: string, callback: MessageCallback): void {
    // If we already have an active subscription for this topic, add the callback
    const existing = this.subscriptionsByTopic.get(topic);
    if (existing) {
      existing.callbacks.add(callback);
      return;
    }

    // If the channel is advertised, subscribe now
    const channel = this.channelsByTopic.get(topic);
    if (channel) {
      this.createSubscription(channel, callback);
    } else {
      // Queue for when the channel becomes available
      this.pendingSubscribers.push({ topic, messageType, callback });
    }
  }

  unsubscribeTopic(topic: string, callback?: MessageCallback): void {
    // A caller may unsubscribe before the channel has been advertised, in
    // which case the callback lives in `pendingSubscribers` and there is no
    // active subscription yet. Drop the matching queued entry/entries first
    // so processPendingSubscribers cannot later wire the dead callback to a
    // fresh subscription once the server's advertise arrives.
    const keep = this.pendingSubscribers.filter(
      (p) => p.topic !== topic || (callback !== undefined && p.callback !== callback)
    );
    if (keep.length !== this.pendingSubscribers.length) {
      this.pendingSubscribers.length = 0;
      this.pendingSubscribers.push(...keep);
    }

    const sub = this.subscriptionsByTopic.get(topic);
    if (!sub) return;

    if (callback) {
      sub.callbacks.delete(callback);
      if (sub.callbacks.size > 0) return; // Other subscribers remain
    }

    // Fully unsubscribe
    this.protocol.unsubscribe(sub.subscriptionId);
    this.subscriptions.delete(sub.subscriptionId);
    this.subscriptionsByTopic.delete(topic);
  }

  private createSubscription(channel: FoxgloveChannel, callback: MessageCallback): void {
    const reader = this.getReader(channel.schemaName, channel.schema);
    const subscriptionId = this.protocol.subscribe(channel.id);
    const sub: ActiveSubscription = {
      subscriptionId,
      channelId: channel.id,
      callbacks: new Set([callback]),
      reader
    };
    this.subscriptions.set(subscriptionId, sub);
    this.subscriptionsByTopic.set(channel.topic, sub);
  }

  // ─── Topic Publishing ───────────────────────────────────────────────────

  publishTopic(topic: string, messageType: string, message: unknown): void {
    let clientCh = this.clientChannels.get(topic);

    if (!clientCh) {
      const schemaName = normalizeRosType(messageType, "msg");
      const writer = this.findWriterForSchema(schemaName);
      // Encoding is fixed at advertise time. Prefer CDR (smaller, faster) when
      // we can find a matching schema; otherwise advertise JSON so
      // foxglove_bridge converts our payload to the ROS message using its own
      // type-registry. JSON keeps subscriber-only / unknown-schema topics
      // working at the cost of a few extra bytes per publish.
      const encoding: "cdr" | "json" = writer ? "cdr" : "json";
      const clientChannelId = this.protocol.advertiseClientChannel(
        topic,
        encoding,
        schemaName
      );
      clientCh = { clientChannelId, topic, schemaName, encoding, writer };
      this.clientChannels.set(topic, clientCh);
    }

    if (clientCh.encoding === "cdr") {
      // The CDR writer is built from a schema on a server-advertised channel.
      // If the schema only became available after this channel was advertised,
      // pick it up lazily here.
      if (!clientCh.writer) {
        clientCh.writer = this.findWriterForSchema(clientCh.schemaName);
      }
      if (!clientCh.writer) {
        // Schema still unknown — should not happen because the encoding was
        // chosen at advertise time, but guard so a serialization failure is
        // loud rather than silent.
        throw new Error(
          `Cannot publish CDR to "${topic}": schema "${clientCh.schemaName}" disappeared from advertised channels.`
        );
      }
      const cdrData = clientCh.writer.writeMessage(message);
      this.protocol.publishMessage(clientCh.clientChannelId, cdrData);
      return;
    }

    // JSON fallback: serialize as UTF-8 JSON; the bridge converts to the ROS
    // message via its type registry on the receiving side.
    const jsonData = new TextEncoder().encode(JSON.stringify(message));
    this.protocol.publishMessage(clientCh.clientChannelId, jsonData);
  }

  private findWriterForSchema(schemaName: string): MessageWriter | null {
    const canonical = normalizeRosType(schemaName, "msg");
    for (const channel of this.channels.values()) {
      if (normalizeRosType(channel.schemaName, "msg") === canonical) {
        return this.getWriter(channel.schemaName, channel.schema);
      }
    }
    return null;
  }

  unpublishTopic(topic: string): void {
    const clientCh = this.clientChannels.get(topic);
    if (clientCh) {
      this.protocol.unadvertiseClientChannel(clientCh.clientChannelId);
      this.clientChannels.delete(topic);
    }
  }

  // ─── Service Calls ──────────────────────────────────────────────────────

  callService(
    serviceName: string,
    serviceType: string,
    request: unknown
  ): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      const svc = this.servicesByName.get(serviceName);
      if (!svc) {
        reject(new Error(`Service ${serviceName} not available`));
        return;
      }

      // Normalize so mixed caller formats (e.g. `pkg/Foo` vs `pkg/srv/Foo`)
      // produce the same cache keys. Prefer the sdk.v1 nested schema fields
      // and fall back to the legacy flat form for older bridges.
      const canonicalType = normalizeRosType(serviceType, "srv");
      const requestSchema = svc.request?.schema ?? svc.requestSchema ?? "";
      const responseSchema = svc.response?.schema ?? svc.responseSchema ?? "";
      if (!requestSchema) {
        reject(new Error(`No request definition for service ${serviceName}`));
        return;
      }

      const requestWriter = this.getWriter(canonicalType + "_Request", requestSchema);
      const responseReader = responseSchema
        ? this.getReader(canonicalType + "_Response", responseSchema)
        : null;

      const requestData = requestWriter.writeMessage(request);
      const callId = this.protocol.callService(svc.id, "cdr", requestData);

      this.pendingServiceCalls.set(callId, { resolve, reject, responseReader });
    });
  }

  // ─── Parameters ─────────────────────────────────────────────────────────

  getParam(name: string): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const wireName = toFoxgloveParamName(name);
      const requestId = `param_get_${this.nextParamRequestId++}`;
      this.pendingParamRequests.set(requestId, {
        onValues: (params) => {
          const param = params.find((p) => toFoxgloveParamName(p.name) === wireName);
          resolve(param?.value ?? null);
        },
        onClose: () =>
          reject(new Error(`getParam(${name}): WebSocket closed before response`))
      });
      this.protocol.getParameters([wireName], requestId);
    });
  }

  setParam(name: string, value: unknown): Promise<void> {
    return new Promise((resolve, reject) => {
      const wireName = toFoxgloveParamName(name);
      const requestId = `param_set_${this.nextParamRequestId++}`;
      this.pendingParamRequests.set(requestId, {
        onValues: () => resolve(),
        onClose: () =>
          reject(new Error(`setParam(${name}): WebSocket closed before response`))
      });
      this.protocol.setParameters([{ name: wireName, value }], requestId);
    });
  }

  // ─── Internal: Protocol Event Handlers ──────────────────────────────────

  private setupProtocolHandlers(): void {
    this.protocol.on("open", () => {
      this.isConnected = true;
      this.emit("connection");
    });

    this.protocol.on("close", () => {
      this.isConnected = false;
      this.channels.clear();
      this.channelsByTopic.clear();
      this.services.clear();
      this.servicesByName.clear();
      this.subscriptions.clear();
      this.subscriptionsByTopic.clear();
      this.clientChannels.clear();
      // Bound long-session growth and avoid decoding against a stale schema
      // if the server's definition changes across a reconnect.
      this.readerCache.clear();
      this.writerCache.clear();

      // Reject any in-flight service calls and parameter requests so their
      // promises don't hang forever across a disconnect.
      const closeError = new Error("WebSocket closed before response received");
      for (const pending of this.pendingServiceCalls.values()) {
        try {
          pending.reject(closeError);
        } catch (e) {
          console.warn("Error rejecting pending service call on close:", e);
        }
      }
      this.pendingServiceCalls.clear();

      for (const pending of this.pendingParamRequests.values()) {
        try {
          pending.onClose();
        } catch (e) {
          console.warn("Error completing pending param request on close:", e);
        }
      }
      this.pendingParamRequests.clear();

      this.pendingSubscribers.length = 0;

      this.emit("close");
    });

    this.protocol.on("error", () => {
      // Browser WebSocket error events carry no detail; reason codes come
      // from the close event that follows.
      this.emit("error", new Error("Foxglove WebSocket error"));
    });

    this.protocol.on("advertise", (channels: FoxgloveChannel[]) => {
      for (const ch of channels) {
        this.channels.set(ch.id, ch);
        this.channelsByTopic.set(ch.topic, ch);
      }
      // Process pending subscribers that were waiting for these channels
      this.processPendingSubscribers();
    });

    this.protocol.on("unadvertise", (channelIds: number[]) => {
      for (const id of channelIds) {
        const ch = this.channels.get(id);
        if (ch) {
          this.channelsByTopic.delete(ch.topic);
          this.channels.delete(id);
        }
      }
    });

    this.protocol.on("advertiseServices", (svcs: FoxgloveService[]) => {
      for (const svc of svcs) {
        this.services.set(svc.id, svc);
        this.servicesByName.set(svc.name, svc);
      }
    });

    this.protocol.on("unadvertiseServices", (serviceIds: number[]) => {
      for (const id of serviceIds) {
        const svc = this.services.get(id);
        if (svc) {
          this.servicesByName.delete(svc.name);
          this.services.delete(id);
        }
      }
    });

    this.protocol.on(
      "message",
      (subscriptionId: number, _timestamp: bigint, data: Uint8Array) => {
        const sub = this.subscriptions.get(subscriptionId);
        if (!sub) return;

        try {
          const msg = sub.reader.readMessage<Record<string, unknown>>(data);
          for (const cb of sub.callbacks) {
            cb(msg);
          }
        } catch (e) {
          console.warn("CDR deserialization error:", e);
        }
      }
    );

    this.protocol.on("serviceResponse", (response: ServiceCallResponse) => {
      const pending = this.pendingServiceCalls.get(response.callId);
      if (!pending) return;
      this.pendingServiceCalls.delete(response.callId);

      try {
        if (pending.responseReader) {
          const result = pending.responseReader.readMessage<Record<string, unknown>>(
            response.data
          );
          pending.resolve(result);
          return;
        }
        pending.resolve({});
      } catch (e) {
        pending.reject(e instanceof Error ? e : new Error(String(e)));
      }
    });

    // foxglove_bridge emits this when a service handler raises, the service
    // gets unadvertised mid-call, or the request payload is rejected. Without
    // this branch the corresponding pending Promise would hang forever — the
    // legacy roslib path raised an explicit error callback in the same shape.
    this.protocol.on("serviceCallFailure", (failure: ServiceCallFailure) => {
      const pending = this.pendingServiceCalls.get(failure.callId);
      if (!pending) return;
      this.pendingServiceCalls.delete(failure.callId);
      pending.reject(new Error(failure.message));
    });

    this.protocol.on("parameterValues", (id: string, params: ParameterValue[]) => {
      const pending = this.pendingParamRequests.get(id);
      if (pending) {
        this.pendingParamRequests.delete(id);
        pending.onValues(params);
      }
    });
  }

  private processPendingSubscribers(): void {
    const remaining: PendingSubscriber[] = [];
    for (const pending of this.pendingSubscribers) {
      const channel = this.channelsByTopic.get(pending.topic);
      if (channel) {
        const existing = this.subscriptionsByTopic.get(pending.topic);
        if (existing) {
          existing.callbacks.add(pending.callback);
        } else {
          this.createSubscription(channel, pending.callback);
        }
      } else {
        remaining.push(pending);
      }
    }
    this.pendingSubscribers.length = 0;
    this.pendingSubscribers.push(...remaining);
  }

  private getReader(schemaName: string, schema: string): MessageReader {
    const key = `${normalizeRosType(schemaName, "msg")} ${schema}`;
    let reader = this.readerCache.get(key);
    if (!reader) {
      reader = new MessageReader(parseRosMsgDefinition(schema, { ros2: true }));
      this.readerCache.set(key, reader);
    }
    return reader;
  }

  private getWriter(schemaName: string, schema: string): MessageWriter {
    const key = `${normalizeRosType(schemaName, "msg")} ${schema}`;
    let writer = this.writerCache.get(key);
    if (!writer) {
      writer = new MessageWriter(parseRosMsgDefinition(schema, { ros2: true }));
      this.writerCache.set(key, writer);
    }
    return writer;
  }
}
