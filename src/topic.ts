/**
 * Topic class — drop-in replacement for roslib's ROSLIB.Topic.
 *
 * Provides subscribe/unsubscribe/publish matching the roslib API.
 * Internally delegates to the Ros class which manages foxglove subscriptions.
 */

import { Ros, type MessageCallback } from "./ros";

export interface TopicOptions {
  ros: Ros;
  name: string;
  messageType: string;
  /**
   * Minimum milliseconds between delivered messages. Matches rosbridge's
   * `throttle_rate`: leading-edge fire, no trailing catch-up. Enforced client-side
   * because foxglove_bridge does not expose a per-subscription rate limiter —
   * rosbridge delivered the rate cap on the server, foxglove_bridge delivers every
   * message published.
   *
   * `0` / `undefined` → no throttle; the hot path takes zero extra work.
   */
  throttle_rate?: number;
  // roslib compatibility fields. foxglove_bridge negotiates transport-level
  // concerns on its own, so the adapter accepts and ignores these to keep the
  // public API stable.
  compression?: string;
  queue_size?: number;
  queue_length?: number;
  latch?: boolean;
  reconnect_on_close?: boolean;
}

export class Topic<T = Record<string, unknown>> {
  ros: Ros;
  name: string;
  messageType: string;

  /**
   * Throttle window in ms. `0` disables throttling — in that case `subscribe`
   * skips the throttling code path entirely and registers an unwrapped callback
   * so the per-message hot path has no throttle-related work.
   */
  private readonly throttleMs: number;

  /**
   * Original user callback → wrapped MessageCallback registered with Ros.
   * Keyed as `object` (all JS functions are objects) so `Topic<T>` stays
   * variance-friendly for callers that pass a `Topic<Foo>` into a slot typed
   * as `Topic<unknown>` — otherwise T ends up invariant through this field
   * and blocks assignments that are safe at runtime.
   */
  private readonly wrappedCallbacks = new Map<object, MessageCallback>();

  constructor(options: TopicOptions) {
    this.ros = options.ros;
    this.name = options.name;
    this.messageType = options.messageType;
    // Non-finite / negative / zero → no throttling.
    const rate = options.throttle_rate ?? 0;
    this.throttleMs = Number.isFinite(rate) && rate > 0 ? rate : 0;
  }

  /**
   * No-op advertise/unadvertise for roslib compatibility. The foxglove adapter
   * advertises lazily the first time `publish()` is called, so explicit
   * registration has no effect on the wire.
   */
  advertise(): void {
    // Intentional no-op — the foxglove adapter advertises lazily on first publish().
  }
  unadvertise(): void {
    // Intentional no-op — the foxglove adapter manages client channel lifetimes.
  }

  subscribe(callback: (message: T) => void): void {
    if (this.wrappedCallbacks.has(callback)) {
      // Idempotent: subscribing the same callback twice is a no-op rather
      // than a silent leak of the prior wrapped registration.
      return;
    }

    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- Roslib-API boundary: `T` is a caller-supplied nominal type for the decoded ROS message; the CDR reader delivers `Record<string, unknown>` whose shape already matches `T` at runtime because the ROS schema drove the decode.
    const cast = callback as MessageCallback;

    let wrappedCb: MessageCallback;
    if (this.throttleMs === 0) {
      // Fast path: no throttle requested. Register the user callback directly so
      // the hot path costs nothing beyond the existing Ros-level fan-out.
      wrappedCb = cast;
    } else {
      // Leading-edge throttle. `lastFiredAt` lives in the closure (one slot per
      // subscription) so there is no Map lookup, Set access, or object
      // allocation on the hot path — just a clock read, a subtract, and a
      // compare. `performance.now()` is monotonic and immune to wall-clock
      // changes, which matters for long-running UIs.
      const windowMs = this.throttleMs;
      let lastFiredAt = -Infinity;
      wrappedCb = (msg) => {
        const now = performance.now();
        if (now - lastFiredAt < windowMs) return;
        lastFiredAt = now;
        cast(msg);
      };
    }

    this.wrappedCallbacks.set(callback, wrappedCb);
    this.ros.subscribeTopic(this.name, this.messageType, wrappedCb);
  }

  unsubscribe(callback?: (message: T) => void): void {
    if (callback) {
      const wrapped = this.wrappedCallbacks.get(callback);
      if (wrapped) {
        this.ros.unsubscribeTopic(this.name, wrapped);
        this.wrappedCallbacks.delete(callback);
      }
      return;
    }
    // No callback given — unsubscribe every wrapped callback we registered.
    for (const wrapped of this.wrappedCallbacks.values()) {
      this.ros.unsubscribeTopic(this.name, wrapped);
    }
    this.wrappedCallbacks.clear();
  }

  publish(message: T): void {
    this.ros.publishTopic(this.name, this.messageType, message);
  }
}
