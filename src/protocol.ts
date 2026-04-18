/**
 * Foxglove WebSocket protocol client.
 *
 * Implements the Foxglove WebSocket protocol for communicating with
 * foxglove_bridge. Handles channel advertisements, subscriptions, service
 * calls, and parameter operations.
 *
 * Two subprotocol negotiation strings exist in the wild with the same wire
 * format: `foxglove.websocket.v1` (legacy websocket_server-based builds) and
 * `foxglove.sdk.v1` (newer foxglove-sdk-cpp-based builds, including the
 * ros-humble-foxglove-bridge 3.2.x apt package). We advertise both so either
 * server accepts the handshake.
 *
 * Control-plane JSON messages (the server→client traffic handled here) are
 * validated via the zod schemas in `./wire-schemas` at the transport edge
 * so the rest of the adapter can work with properly typed values without
 * resorting to `as` casts. The authoritative wire format still lives in the
 * (archived) foxglove/ws-protocol spec, which is what ros-foxglove-bridge
 * 3.2.x continues to implement.
 */

import type { FoxgloveChannel, FoxgloveServerInfo, FoxgloveService } from "./types";
import { serverMessageSchema } from "./wire-schemas";

// ─── Binary opcodes (server → client) ────────────────────────────────────────
const OP_MESSAGE_DATA = 0x01;
const OP_SERVICE_CALL_RESPONSE = 0x03;

// ─── Binary opcodes (client → server) ────────────────────────────────────────
const OP_CLIENT_MESSAGE_DATA = 0x01;
const OP_CLIENT_SERVICE_CALL_REQUEST = 0x02;

export interface ProtocolEvents {
  serverInfo: (info: FoxgloveServerInfo) => void;
  advertise: (channels: FoxgloveChannel[]) => void;
  unadvertise: (channelIds: number[]) => void;
  advertiseServices: (services: FoxgloveService[]) => void;
  unadvertiseServices: (serviceIds: number[]) => void;
  message: (subscriptionId: number, timestamp: bigint, data: Uint8Array) => void;
  serviceResponse: (response: ServiceCallResponse) => void;
  parameterValues: (id: string, params: ParameterValue[]) => void;
  open: () => void;
  close: (event: CloseEvent) => void;
  error: (error: Event) => void;
}

export interface ParameterValue {
  name: string;
  value: unknown;
  type?: string;
}

export interface ServiceCallResponse {
  serviceId: number;
  callId: number;
  encoding: string;
  data: Uint8Array;
}

/**
 * One Set of handlers per event name. Keying the storage with a mapped type
 * over `ProtocolEvents` lets `add` / `delete` / iteration stay fully typed,
 * which is how we dispatch handlers in `emit` without a type assertion.
 */
type ProtocolEventHandlers = {
  [K in keyof ProtocolEvents]: Set<ProtocolEvents[K]>;
};

export class FoxgloveProtocolClient {
  private ws: WebSocket | null = null;
  private readonly handlers: ProtocolEventHandlers = {
    serverInfo: new Set(),
    advertise: new Set(),
    unadvertise: new Set(),
    advertiseServices: new Set(),
    unadvertiseServices: new Set(),
    message: new Set(),
    serviceResponse: new Set(),
    parameterValues: new Set(),
    open: new Set(),
    close: new Set(),
    error: new Set()
  };
  private nextSubscriptionId = 1;
  private nextCallId = 1;
  private nextClientChannelId = 1;

  connect(url: string): void {
    this.close();
    // Convert http/https URLs to ws/wss
    const wsUrl = url.replace(/^http/, "ws");
    this.ws = new WebSocket(wsUrl, ["foxglove.sdk.v1", "foxglove.websocket.v1"]);
    this.ws.binaryType = "arraybuffer";

    this.ws.onopen = () => this.dispatch(this.handlers.open, (h) => h(), "open");
    this.ws.onclose = (event) =>
      this.dispatch(this.handlers.close, (h) => h(event), "close");
    this.ws.onerror = (event) =>
      this.dispatch(this.handlers.error, (h) => h(event), "error");
    this.ws.onmessage = (event) => this.handleMessage(event);
  }

  close(): void {
    if (this.ws) {
      this.ws.onopen = null;
      this.ws.onclose = null;
      this.ws.onerror = null;
      this.ws.onmessage = null;
      this.ws.close();
      this.ws = null;
    }
  }

  get isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  // ─── Subscriptions ──────────────────────────────────────────────────────

  subscribe(channelId: number): number {
    const id = this.nextSubscriptionId++;
    this.sendJson({
      op: "subscribe",
      subscriptions: [{ id, channelId }]
    });
    return id;
  }

  unsubscribe(subscriptionId: number): void {
    this.sendJson({
      op: "unsubscribe",
      subscriptionIds: [subscriptionId]
    });
  }

  // ─── Publishing ─────────────────────────────────────────────────────────

  advertiseClientChannel(topic: string, encoding: string, schemaName: string): number {
    const id = this.nextClientChannelId++;
    this.sendJson({
      op: "advertise",
      channels: [{ id, topic, encoding, schemaName }]
    });
    return id;
  }

  unadvertiseClientChannel(channelId: number): void {
    this.sendJson({
      op: "unadvertise",
      channelIds: [channelId]
    });
  }

  publishMessage(channelId: number, data: Uint8Array): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    // Binary format: [opcode:1][channelId:4][data:variable]
    const msg = new Uint8Array(1 + 4 + data.byteLength);
    const view = new DataView(msg.buffer);
    view.setUint8(0, OP_CLIENT_MESSAGE_DATA);
    view.setUint32(1, channelId, true);
    msg.set(data, 5);
    this.ws.send(msg);
  }

  // ─── Services ───────────────────────────────────────────────────────────

  callService(serviceId: number, encoding: string, requestData: Uint8Array): number {
    const callId = this.nextCallId++;
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return callId;

    const encodingBytes = new TextEncoder().encode(encoding);
    // Binary format: [opcode:1][serviceId:4][callId:4][encodingLength:4][encoding:var][requestData:var]
    const msg = new Uint8Array(
      1 + 4 + 4 + 4 + encodingBytes.byteLength + requestData.byteLength
    );
    const view = new DataView(msg.buffer);
    let offset = 0;
    view.setUint8(offset, OP_CLIENT_SERVICE_CALL_REQUEST);
    offset += 1;
    view.setUint32(offset, serviceId, true);
    offset += 4;
    view.setUint32(offset, callId, true);
    offset += 4;
    view.setUint32(offset, encodingBytes.byteLength, true);
    offset += 4;
    msg.set(encodingBytes, offset);
    offset += encodingBytes.byteLength;
    msg.set(requestData, offset);

    this.ws.send(msg);
    return callId;
  }

  // ─── Parameters ─────────────────────────────────────────────────────────

  getParameters(names: string[], requestId?: string): void {
    this.sendJson({
      op: "getParameters",
      parameterNames: names,
      id: requestId
    });
  }

  setParameters(parameters: ParameterValue[], requestId?: string): void {
    this.sendJson({
      op: "setParameters",
      parameters,
      id: requestId
    });
  }

  // ─── Event system ───────────────────────────────────────────────────────

  on<K extends keyof ProtocolEvents>(event: K, callback: ProtocolEvents[K]): void {
    this.handlers[event].add(callback);
  }

  off<K extends keyof ProtocolEvents>(event: K, callback: ProtocolEvents[K]): void {
    this.handlers[event].delete(callback);
  }

  /**
   * Dispatch helper that stays outside TypeScript's distributed-generic
   * limitation. Each caller passes the concrete Set for one event plus a
   * function that invokes a single handler with the right argument shape,
   * so the spread is in a non-generic context and the types line up.
   */
  private dispatch<F>(
    handlers: Set<F>,
    invoke: (handler: F) => void,
    event: string
  ): void {
    for (const handler of handlers) {
      try {
        invoke(handler);
      } catch (e) {
        console.warn(`Error in ${event} handler:`, e);
      }
    }
  }

  // ─── Message handling ───────────────────────────────────────────────────

  private handleMessage(event: MessageEvent): void {
    if (typeof event.data === "string") {
      this.handleTextMessage(event.data);
    } else if (event.data instanceof ArrayBuffer) {
      this.handleBinaryMessage(event.data);
    }
  }

  private handleTextMessage(text: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      console.warn("Failed to parse foxglove text message:", text.slice(0, 100));
      return;
    }

    const result = serverMessageSchema.safeParse(parsed);
    if (!result.success) {
      // Unknown / newer op, or malformed shape. Ignore silently rather than
      // crashing — the protocol evolves and the server may send messages
      // this client does not implement yet.
      return;
    }
    const msg = result.data;

    switch (msg.op) {
      case "serverInfo":
        this.dispatch(this.handlers.serverInfo, (h) => h(msg), "serverInfo");
        break;
      case "advertise":
        this.dispatch(this.handlers.advertise, (h) => h(msg.channels), "advertise");
        break;
      case "unadvertise":
        this.dispatch(this.handlers.unadvertise, (h) => h(msg.channelIds), "unadvertise");
        break;
      case "advertiseServices":
        this.dispatch(
          this.handlers.advertiseServices,
          (h) => h(msg.services),
          "advertiseServices"
        );
        break;
      case "unadvertiseServices":
        this.dispatch(
          this.handlers.unadvertiseServices,
          (h) => h(msg.serviceIds),
          "unadvertiseServices"
        );
        break;
      case "parameterValues":
        this.dispatch(
          this.handlers.parameterValues,
          (h) => h(msg.id ?? "", msg.parameters),
          "parameterValues"
        );
        break;
      case "status": {
        const message = msg.message ?? msg.msg;
        if (msg.level === 0) console.info("[foxglove]", message);
        else console.warn("[foxglove]", message);
        break;
      }
    }
  }

  private handleBinaryMessage(data: ArrayBuffer): void {
    const bytes = new Uint8Array(data);
    if (bytes.length < 1) return;

    const opcode = bytes[0];
    if (opcode === undefined) return;
    const view = new DataView(data);

    switch (opcode) {
      case OP_MESSAGE_DATA: {
        // [opcode:1][subscriptionId:4][timestamp:8][data:variable]
        if (bytes.length < 13) return;
        const subscriptionId = view.getUint32(1, true);
        const timestamp = view.getBigUint64(5, true);
        const msgData = bytes.slice(13);
        this.dispatch(
          this.handlers.message,
          (h) => h(subscriptionId, timestamp, msgData),
          "message"
        );
        break;
      }
      case OP_SERVICE_CALL_RESPONSE: {
        // [opcode:1][serviceId:4][callId:4][encodingLength:4][encoding:var][data:var]
        if (bytes.length < 13) return;
        const serviceId = view.getUint32(1, true);
        const callId = view.getUint32(5, true);
        const encodingLength = view.getUint32(9, true);
        const encoding = new TextDecoder().decode(bytes.slice(13, 13 + encodingLength));
        const responseData = bytes.slice(13 + encodingLength);
        this.dispatch(
          this.handlers.serviceResponse,
          (h) => h({ serviceId, callId, encoding, data: responseData }),
          "serviceResponse"
        );
        break;
      }
      default:
        console.warn(
          `[foxglove] unhandled binary opcode 0x${opcode.toString(16)} (len=${bytes.length})`
        );
    }
  }

  private sendJson(msg: Record<string, unknown>): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }
}
