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
  // roslib compatibility fields. foxglove_bridge negotiates these on its own,
  // so the adapter accepts and ignores them to keep the public API stable.
  compression?: string;
  throttle_rate?: number;
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
  }

  /**
   * No-op advertise/unadvertise for roslib compatibility. The foxglove adapter
   * advertises lazily the first time `publish()` is called, so explicit
   * registration has no effect on the wire.
   */
  advertise(): void {}
  unadvertise(): void {}

  subscribe(callback: (message: T) => void): void {
    if (this.wrappedCallbacks.has(callback)) {
      // Idempotent: subscribing the same callback twice is a no-op rather
      // than a silent leak of the prior wrapped registration.
      return;
    }
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- Roslib-API boundary: `T` is a caller-supplied nominal type for the decoded ROS message; the CDR reader delivers `Record<string, unknown>` whose shape already matches `T` at runtime because the ROS schema drove the decode.
    const wrappedCb: MessageCallback = (msg) => callback(msg as T);
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
