import {
  describe,
  it,
  expect,
  vi,
  beforeEach,
  afterEach,
  type MockInstance
} from "vitest";
import { mock } from "vitest-mock-extended";
import { z } from "zod";

import { Topic } from "../src/topic";
import type { Ros } from "../src/ros";

interface TestMessage {
  data: string;
}

function getRegisteredWrapper(ros: ReturnType<typeof mock<Ros>>, index: number) {
  const call = ros.subscribeTopic.mock.calls[index];
  if (!call) throw new Error(`expected a subscribeTopic call at index ${index}`);
  return call[2];
}

describe("Topic", () => {
  const ros = mock<Ros>();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("subscribe without throttle_rate", () => {
    it("registers the user callback directly so the hot path has no wrapper", () => {
      const topic = new Topic<TestMessage>({
        ros,
        name: "/fast",
        messageType: "test_msgs/msg/Fast"
      });
      const cb = vi.fn();

      topic.subscribe(cb);

      expect(ros.subscribeTopic).toHaveBeenCalledTimes(1);
      expect(ros.subscribeTopic).toHaveBeenCalledWith("/fast", "test_msgs/msg/Fast", cb);
    });

    it("treats 0 and non-finite throttle_rate the same as no throttle", () => {
      for (const rate of [0, -10, Number.NaN, Number.POSITIVE_INFINITY]) {
        const topic = new Topic<TestMessage>({
          ros,
          name: `/rate-${String(rate)}`,
          messageType: "test_msgs/msg/Any",
          throttle_rate: rate
        });
        const cb = vi.fn();

        topic.subscribe(cb);

        const call = ros.subscribeTopic.mock.calls.at(-1);
        expect(call?.[2]).toBe(cb);
      }
    });

    it("validates decoded messages with messageSchema before delivering them", () => {
      const messageSchema = z.object({ data: z.string() });
      const topic = new Topic({
        ros,
        name: "/validated",
        messageType: "test_msgs/msg/Validated",
        messageSchema
      });
      const cb = vi.fn<(message: z.infer<typeof messageSchema>) => void>();

      topic.subscribe(cb);
      const wrapped = getRegisteredWrapper(ros, 0);
      wrapped({ data: "ok" });

      expect(cb).toHaveBeenCalledWith({ data: "ok" });
      expect(() => wrapped({ data: 42 })).toThrow();
    });
  });

  describe("subscribe with throttle_rate", () => {
    let nowMs = 0;
    let nowSpy: MockInstance;

    beforeEach(() => {
      nowMs = 0;
      nowSpy = vi.spyOn(performance, "now").mockImplementation(() => nowMs);
    });

    afterEach(() => {
      nowSpy.mockRestore();
    });

    it("delivers the first message immediately and drops messages inside the window", () => {
      const topic = new Topic<TestMessage>({
        ros,
        name: "/bt_status",
        messageType: "test_msgs/msg/Status",
        throttle_rate: 250
      });
      const cb = vi.fn();
      topic.subscribe(cb);

      const wrapped = getRegisteredWrapper(ros, 0);
      expect(wrapped).not.toBe(cb);

      wrapped({ data: "m0" });
      expect(cb).toHaveBeenCalledWith({ data: "m0" });
      expect(cb).toHaveBeenCalledTimes(1);

      nowMs = 100;
      wrapped({ data: "m1" });
      nowMs = 249;
      wrapped({ data: "m2" });
      expect(cb).toHaveBeenCalledTimes(1);

      nowMs = 250;
      wrapped({ data: "m3" });
      expect(cb).toHaveBeenCalledTimes(2);
      expect(cb).toHaveBeenLastCalledWith({ data: "m3" });
    });

    it("does not queue a trailing message", () => {
      const topic = new Topic<TestMessage>({
        ros,
        name: "/no-tail",
        messageType: "test_msgs/msg/Any",
        throttle_rate: 100
      });
      const cb = vi.fn();
      topic.subscribe(cb);
      const wrapped = getRegisteredWrapper(ros, 0);

      wrapped({ data: "m0" });
      nowMs = 50;
      wrapped({ data: "m1-dropped" });
      nowMs = 10_000;

      expect(cb).toHaveBeenCalledTimes(1);
      expect(cb).toHaveBeenCalledWith({ data: "m0" });
    });

    it("throttles each subscriber independently", () => {
      const topic = new Topic<TestMessage>({
        ros,
        name: "/shared",
        messageType: "test_msgs/msg/Any",
        throttle_rate: 100
      });
      const cbA = vi.fn();
      const cbB = vi.fn();
      topic.subscribe(cbA);
      nowMs = 60;
      topic.subscribe(cbB);

      const wrappedA = getRegisteredWrapper(ros, 0);
      const wrappedB = getRegisteredWrapper(ros, 1);

      wrappedA({ data: "a0" });
      wrappedB({ data: "b0" });
      expect(cbA).toHaveBeenCalledTimes(1);
      expect(cbB).toHaveBeenCalledTimes(1);

      nowMs = 110;
      wrappedA({ data: "a1" });
      wrappedB({ data: "b1" });
      expect(cbA).toHaveBeenCalledTimes(1);
      expect(cbB).toHaveBeenCalledTimes(1);
    });
  });

  describe("unsubscribe", () => {
    it("removes the registered wrapper for a given callback", () => {
      const topic = new Topic<TestMessage>({
        ros,
        name: "/u",
        messageType: "test_msgs/msg/Any"
      });
      const cb = vi.fn();
      topic.subscribe(cb);
      const registered = ros.subscribeTopic.mock.calls[0]?.[2];

      topic.unsubscribe(cb);

      expect(ros.unsubscribeTopic).toHaveBeenCalledWith("/u", registered);
    });

    it("unsubscribes every registered wrapper when called with no argument", () => {
      const topic = new Topic<TestMessage>({
        ros,
        name: "/u-all",
        messageType: "test_msgs/msg/Any",
        throttle_rate: 100
      });
      topic.subscribe(vi.fn());
      topic.subscribe(vi.fn());

      topic.unsubscribe();

      expect(ros.unsubscribeTopic).toHaveBeenCalledTimes(2);
    });

    it("subscribing the same callback twice is idempotent", () => {
      const topic = new Topic<TestMessage>({
        ros,
        name: "/dedupe",
        messageType: "test_msgs/msg/Any"
      });
      const cb = vi.fn();

      topic.subscribe(cb);
      topic.subscribe(cb);

      expect(ros.subscribeTopic).toHaveBeenCalledTimes(1);
    });
  });
});
