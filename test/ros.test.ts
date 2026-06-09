import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ProtocolEvents } from "../src/protocol";
import type { FoxgloveChannel } from "../src/types";
import { Ros } from "../src/ros";

type ProtocolHandlers = Partial<{
  [K in keyof ProtocolEvents]: ProtocolEvents[K];
}>;

const protocolState = vi.hoisted(() => ({
  handlers: {} as ProtocolHandlers
}));

vi.mock("../src/protocol", () => ({
  FoxgloveProtocolClient: class {
    on<K extends keyof ProtocolEvents>(event: K, callback: ProtocolEvents[K]): void {
      protocolState.handlers[event] = callback;
    }

    close(): void {}
  }
}));

function channel(overrides: Partial<FoxgloveChannel> = {}): FoxgloveChannel {
  return {
    id: 1,
    topic: "/chatter",
    encoding: "cdr",
    schemaName: "std_msgs/msg/String",
    schemaEncoding: "ros2msg",
    schema: "string data",
    ...overrides
  };
}

describe("Ros", () => {
  beforeEach(() => {
    protocolState.handlers = {};
  });

  it("emits channelsChanged when channel advertisements change", () => {
    const ros = new Ros();
    const listener = vi.fn();
    ros.on("channelsChanged", listener);

    protocolState.handlers.advertise?.([channel({ id: 5, topic: "/foo" })]);
    expect(listener).toHaveBeenCalledTimes(1);

    ros.off("channelsChanged", listener);
    protocolState.handlers.unadvertise?.([5]);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("removes channelsChanged listeners with removeAllListeners", () => {
    const ros = new Ros();
    const listener = vi.fn();
    ros.on("channelsChanged", listener);
    ros.removeAllListeners("channelsChanged");

    ros.emit("channelsChanged");

    expect(listener).not.toHaveBeenCalled();
  });
});
