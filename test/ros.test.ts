import { beforeEach, describe, expect, it, vi } from "vitest";
import { parse as parseRosMsgDefinition } from "@foxglove/rosmsg";
import { MessageReader, MessageWriter } from "@foxglove/rosmsg2-serialization";

import type { ProtocolEvents } from "../src/protocol";
import type { FoxgloveChannel, FoxgloveService } from "../src/types";
import { Ros } from "../src/ros";

type ProtocolHandlers = Partial<{
  [K in keyof ProtocolEvents]: ProtocolEvents[K];
}>;

const protocolState = vi.hoisted(() => ({
  handlers: {} as ProtocolHandlers,
  calls: [] as Array<{ serviceId: number; callId: number; encoding: string; data: Uint8Array }>,
  subscriptions: [] as Array<{ id: number; channelId: number }>,
  nextCallId: 1,
  nextSubscriptionId: 1
}));

vi.mock("../src/protocol", () => ({
  FoxgloveProtocolClient: class {
    on<K extends keyof ProtocolEvents>(event: K, callback: ProtocolEvents[K]): void {
      protocolState.handlers[event] = callback;
    }

    subscribe(channelId: number): number {
      const id = protocolState.nextSubscriptionId++;
      protocolState.subscriptions.push({ id, channelId });
      return id;
    }

    unsubscribe(): void {}

    callService(serviceId: number, encoding: string, data: Uint8Array): number {
      const callId = protocolState.nextCallId++;
      protocolState.calls.push({ serviceId, callId, encoding, data });
      return callId;
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

function service(overrides: Partial<FoxgloveService> = {}): FoxgloveService {
  return {
    id: 1,
    name: "/fibonacci/_action/send_goal",
    type: "example_interfaces/action/Fibonacci_SendGoal",
    requestSchema: SEND_GOAL_REQUEST_SCHEMA,
    responseSchema: SEND_GOAL_RESPONSE_SCHEMA,
    ...overrides
  };
}

function write(schemaName: string, schema: string, message: unknown): Uint8Array {
  return new MessageWriter(parseRosMsgDefinition(schema, { ros2: true })).writeMessage(
    message
  );
}

function read<T = Record<string, unknown>>(
  schemaName: string,
  schema: string,
  data: Uint8Array
): T {
  void schemaName;
  return new MessageReader(parseRosMsgDefinition(schema, { ros2: true })).readMessage<T>(
    data
  );
}

function flushPromises(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe("Ros", () => {
  beforeEach(() => {
    protocolState.handlers = {};
    protocolState.calls = [];
    protocolState.subscriptions = [];
    protocolState.nextCallId = 1;
    protocolState.nextSubscriptionId = 1;
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

  it("discovers actions from hidden send_goal services", () => {
    const ros = new Ros();
    const received: string[][] = [];

    protocolState.handlers.advertiseServices?.([
      service({ id: 1, name: "/fibonacci/_action/send_goal" }),
      service({ id: 2, name: "/ordinary", type: "std_srvs/srv/Trigger" })
    ]);

    ros.getActionServers((actions) => received.push(actions));

    expect(received).toEqual([["/fibonacci"]]);
  });

  it("reports include_hidden guidance when action endpoints are missing", () => {
    const ros = new Ros();
    const errors: Error[] = [];

    ros.sendActionGoal(
      "/fibonacci",
      "example_interfaces/action/Fibonacci",
      { order: 3 },
      undefined,
      undefined,
      (error) => errors.push(error),
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
    );

    expect(protocolState.calls).toHaveLength(0);
    expect(errors[0]?.message).toContain("include_hidden:=true");
    expect(errors[0]?.message).toContain("/fibonacci/_action/send_goal");
  });

  it("sends an action goal through send_goal then get_result services", async () => {
    const ros = new Ros();
    const results: unknown[] = [];

    protocolState.handlers.advertiseServices?.([
      service({ id: 1 }),
      service({
        id: 2,
        name: "/fibonacci/_action/get_result",
        type: "example_interfaces/action/Fibonacci_GetResult",
        requestSchema: GET_RESULT_REQUEST_SCHEMA,
        responseSchema: GET_RESULT_RESPONSE_SCHEMA
      })
    ]);

    ros.sendActionGoal(
      "/fibonacci",
      "example_interfaces/action/Fibonacci",
      { order: 3 },
      (result) => results.push(result),
      undefined,
      undefined,
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
    );

    expect(protocolState.calls).toHaveLength(1);
    expect(protocolState.calls[0]?.serviceId).toBe(1);

    protocolState.handlers.serviceResponse?.({
      serviceId: 1,
      callId: 1,
      encoding: "cdr",
      data: write(
        "example_interfaces/action/Fibonacci_SendGoal_Response",
        SEND_GOAL_RESPONSE_SCHEMA,
        {
          accepted: true,
          stamp: { sec: 0, nanosec: 0 }
        }
      )
    });

    await flushPromises();

    expect(protocolState.calls).toHaveLength(2);
    expect(protocolState.calls[1]?.serviceId).toBe(2);

    protocolState.handlers.serviceResponse?.({
      serviceId: 2,
      callId: 2,
      encoding: "cdr",
      data: write(
        "example_interfaces/action/Fibonacci_GetResult_Response",
        GET_RESULT_RESPONSE_SCHEMA,
        { status: 4, result: { sequence: [0, 1, 1] } }
      )
    });

    await flushPromises();

    const result = results[0] as { values: { sequence: Int32Array } };
    expect(result).toEqual(
      expect.objectContaining({
        action: "/fibonacci",
        id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        status: 4,
        result: true,
        accepted: true
      })
    );
    expect(Array.from(result.values.sequence)).toEqual([0, 1, 1]);
  });

  it("does not wrap flattened action goal schemas in a goal field", () => {
    const ros = new Ros();

    protocolState.handlers.advertiseServices?.([
      service({
        id: 1,
        name: "/flat_action/_action/send_goal",
        type: "example_interfaces/action/FlatAction_SendGoal",
        requestSchema: FLAT_SEND_GOAL_REQUEST_SCHEMA
      }),
      service({
        id: 2,
        name: "/flat_action/_action/get_result",
        type: "example_interfaces/action/FlatAction_GetResult",
        requestSchema: GET_RESULT_REQUEST_SCHEMA,
        responseSchema: "int8 status\nstring error_message"
      })
    ]);

    ros.sendActionGoal(
      "/flat_action",
      "example_interfaces/action/FlatAction",
      { label: "sample", priority: 3 },
      undefined,
      undefined,
      undefined,
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
    );

    const decoded = read(
      "example_interfaces/action/FlatAction_SendGoal_Request",
      FLAT_SEND_GOAL_REQUEST_SCHEMA,
      protocolState.calls[0]!.data
    );

    expect(decoded).not.toHaveProperty("goal");
    expect(decoded).toMatchObject({ label: "sample", priority: 3 });
  });
});

const UUID_SCHEMA = `uint8[16] uuid`;

const SEND_GOAL_REQUEST_SCHEMA = `unique_identifier_msgs/UUID goal_id
example_interfaces/action/Fibonacci_Goal goal

================================================================================
MSG: unique_identifier_msgs/UUID
${UUID_SCHEMA}

================================================================================
MSG: example_interfaces/action/Fibonacci_Goal
int32 order`;

const SEND_GOAL_RESPONSE_SCHEMA = `bool accepted
builtin_interfaces/Time stamp

================================================================================
MSG: builtin_interfaces/Time
int32 sec
uint32 nanosec`;

const GET_RESULT_REQUEST_SCHEMA = `unique_identifier_msgs/UUID goal_id

================================================================================
MSG: unique_identifier_msgs/UUID
${UUID_SCHEMA}`;

const GET_RESULT_RESPONSE_SCHEMA = `int8 status
example_interfaces/action/Fibonacci_Result result

================================================================================
MSG: example_interfaces/action/Fibonacci_Result
int32[] sequence`;

const FLAT_SEND_GOAL_REQUEST_SCHEMA = `unique_identifier_msgs/UUID goal_id
string label
int32 priority

================================================================================
MSG: unique_identifier_msgs/UUID
${UUID_SCHEMA}`;
