import { describe, expect, it, vi } from "vitest";
import { mockDeep, type MockProxy } from "vitest-mock-extended";
import { z } from "zod";

import { Ros, type MessageCallback } from "../src/ros";
import { ROS2TFClient } from "../src/tf-client";
import { Transform } from "../src/types";

/**
 * The /tf and /tf_static topics are the same wire schema, so the client
 * subscribes the same callback to both. This helper builds a single TF
 * message payload — caller picks which topic to deliver it on.
 */
function tfMessage(
  ...transforms: Array<{
    parent: string;
    child: string;
    x?: number;
    y?: number;
    z?: number;
    qx?: number;
    qy?: number;
    qz?: number;
    qw?: number;
  }>
): Record<string, unknown> {
  return {
    transforms: transforms.map((t) => ({
      header: { stamp: { sec: 0, nanosec: 0 }, frame_id: t.parent },
      child_frame_id: t.child,
      transform: {
        translation: { x: t.x ?? 0, y: t.y ?? 0, z: t.z ?? 0 },
        rotation: {
          x: t.qx ?? 0,
          y: t.qy ?? 0,
          z: t.qz ?? 0,
          w: t.qw ?? 1
        }
      }
    }))
  };
}

const translationSchema = z.object({ x: z.number(), y: z.number(), z: z.number() });

/**
 * Pull `result.current` off the first call to a TF subscriber spy and return
 * its parsed translation. Using zod here keeps the test type-safe without an
 * `as` assertion against the loosely-typed `mock.calls`.
 */
type TFCallback = (transform: Transform) => void;

function firstDeliveredTranslation(cb: ReturnType<typeof vi.fn<TFCallback>>): {
  x: number;
  y: number;
  z: number;
} {
  const call = cb.mock.calls[0];
  if (!call) throw new Error("expected the subscriber to have been called at least once");
  const transform = call[0];
  return translationSchema.parse({
    x: transform.translation.x,
    y: transform.translation.y,
    z: transform.translation.z
  });
}

/** Spy `Ros` that records subscribe/unsubscribe calls and lets tests deliver TF messages. */
function makeRos(): {
  ros: MockProxy<Ros>;
  deliver: (topic: "/tf" | "/tf_static", msg: Record<string, unknown>) => void;
} {
  const handlers = new Map<string, MessageCallback>();
  const ros = mockDeep<Ros>();
  ros.subscribeTopic.mockImplementation((topic, _messageType, callback) => {
    handlers.set(topic, callback);
  });
  return {
    ros,
    deliver: (topic, msg) => {
      const cb = handlers.get(topic);
      if (!cb) throw new Error(`no handler registered for ${topic}`);
      cb(msg);
    }
  };
}

describe("ROS2TFClient — construction", () => {
  it("subscribes to /tf and /tf_static with the TFMessage schema on construction", () => {
    const { ros } = makeRos();
    new ROS2TFClient({ ros, fixedFrame: "world" });
    expect(ros.subscribeTopic).toHaveBeenCalledWith(
      "/tf",
      "tf2_msgs/msg/TFMessage",
      expect.any(Function)
    );
    expect(ros.subscribeTopic).toHaveBeenCalledWith(
      "/tf_static",
      "tf2_msgs/msg/TFMessage",
      expect.any(Function)
    );
  });

  it("defaults fixedFrame to 'world' and strips a leading slash if provided", () => {
    const { ros, deliver } = makeRos();
    const client = new ROS2TFClient({ ros, fixedFrame: "/world" });
    const cb = vi.fn<TFCallback>();
    client.subscribe("/world", cb);
    // Self-frame resolves to identity, so the leading-slash normalization is
    // observable as an immediate identity-transform delivery rather than
    // failing the equality test against the stored fixedFrame.
    expect(cb).toHaveBeenCalledTimes(1);
    expect(firstDeliveredTranslation(cb)).toEqual({ x: 0, y: 0, z: 0 });

    // And TF messages keyed by the same name (with no slash) resolve correctly.
    deliver("/tf", tfMessage({ parent: "world", child: "child", x: 5 }));
    const cb2 = vi.fn<TFCallback>();
    client.subscribe("child", cb2);
    expect(firstDeliveredTranslation(cb2)).toEqual({ x: 5, y: 0, z: 0 });
  });
});

describe("ROS2TFClient — subscribe / unsubscribe", () => {
  it("delivers the current transform immediately when the chain is already resolvable", () => {
    const { ros, deliver } = makeRos();
    const client = new ROS2TFClient({ ros, fixedFrame: "world" });
    deliver("/tf", tfMessage({ parent: "world", child: "a", x: 1 }));

    const cb = vi.fn<TFCallback>();
    client.subscribe("a", cb);
    expect(cb).toHaveBeenCalledTimes(1);
    expect(firstDeliveredTranslation(cb)).toEqual({ x: 1, y: 0, z: 0 });
  });

  it("defers delivery when the chain cannot yet be resolved, then delivers when the parent arrives", () => {
    const { ros, deliver } = makeRos();
    const client = new ROS2TFClient({ ros, fixedFrame: "world" });

    const cb = vi.fn<TFCallback>();
    client.subscribe("child", cb);
    // No transforms known yet, so no callback.
    expect(cb).not.toHaveBeenCalled();

    deliver("/tf_static", tfMessage({ parent: "world", child: "child", x: 2 }));
    expect(cb).toHaveBeenCalledTimes(1);
    expect(firstDeliveredTranslation(cb)).toEqual({ x: 2, y: 0, z: 0 });
  });

  it("supports multiple subscribers per frame and removes only the targeted one on unsubscribe", () => {
    const { ros, deliver } = makeRos();
    const client = new ROS2TFClient({ ros, fixedFrame: "world" });
    const cb1 = vi.fn<TFCallback>();
    const cb2 = vi.fn<TFCallback>();
    client.subscribe("a", cb1);
    client.subscribe("a", cb2);

    client.unsubscribe("a", cb1);
    deliver("/tf", tfMessage({ parent: "world", child: "a", x: 9 }));
    expect(cb1).not.toHaveBeenCalled();
    expect(cb2).toHaveBeenCalledTimes(1);
  });

  it("unsubscribe(frame) with no callback drops every subscriber for that frame", () => {
    const { ros, deliver } = makeRos();
    const client = new ROS2TFClient({ ros, fixedFrame: "world" });
    const cb1 = vi.fn<TFCallback>();
    const cb2 = vi.fn<TFCallback>();
    client.subscribe("a", cb1);
    client.subscribe("a", cb2);

    client.unsubscribe("a");
    deliver("/tf", tfMessage({ parent: "world", child: "a", x: 1 }));
    expect(cb1).not.toHaveBeenCalled();
    expect(cb2).not.toHaveBeenCalled();
  });

  it("composes transforms across multiple parents in the chain", () => {
    const { ros, deliver } = makeRos();
    const client = new ROS2TFClient({ ros, fixedFrame: "world" });
    deliver(
      "/tf",
      tfMessage(
        { parent: "world", child: "base", x: 1 },
        { parent: "base", child: "tool", y: 2 }
      )
    );
    const cb = vi.fn<TFCallback>();
    client.subscribe("tool", cb);
    // Identity rotations, so the chain compose just adds translations.
    expect(firstDeliveredTranslation(cb)).toEqual({ x: 1, y: 2, z: 0 });
  });

  it("resolves a frame that is an ancestor of the fixed frame (mobile-base tree)", () => {
    // mj_world → map → world (the reference frame sits below map/odom).
    const { ros, deliver } = makeRos();
    const client = new ROS2TFClient({ ros, fixedFrame: "world" });
    deliver(
      "/tf",
      tfMessage(
        { parent: "mj_world", child: "map", x: 10 },
        { parent: "map", child: "world", x: 3 }
      )
    );

    // map is an ancestor of world: pose of map in world is the inverse of
    // world's pose in map (translation +3), i.e. x = -3.
    const cb = vi.fn<TFCallback>();
    client.subscribe("map", cb);
    expect(firstDeliveredTranslation(cb)).toEqual({ x: -3, y: 0, z: 0 });
  });

  it("resolves a frame in a sibling branch via the common ancestor", () => {
    // root → world (x:1) and root → sensor (x:5). Pose of sensor in world is x:4.
    const { ros, deliver } = makeRos();
    const client = new ROS2TFClient({ ros, fixedFrame: "world" });
    deliver(
      "/tf",
      tfMessage(
        { parent: "root", child: "world", x: 1 },
        { parent: "root", child: "sensor", x: 5 }
      )
    );

    const cb = vi.fn<TFCallback>();
    client.subscribe("sensor", cb);
    expect(firstDeliveredTranslation(cb)).toEqual({ x: 4, y: 0, z: 0 });
  });

  it("composes rotation correctly across the common ancestor (sibling branch)", () => {
    // root → world rotated 90° about +Z, and root → sensor at +X 2m.
    // In world's frame, root's +X axis points along world's -Y, so a point at
    // root +X=2 lands at world y = -2 (after accounting for the inverse).
    const h = Math.SQRT1_2;
    const { ros, deliver } = makeRos();
    const client = new ROS2TFClient({ ros, fixedFrame: "world" });
    deliver(
      "/tf",
      tfMessage(
        { parent: "root", child: "world", qz: h, qw: h },
        { parent: "root", child: "sensor", x: 2 }
      )
    );

    const cb = vi.fn<TFCallback>();
    client.subscribe("sensor", cb);
    const t = firstDeliveredTranslation(cb);
    expect(t.x).toBeCloseTo(0, 6);
    expect(t.y).toBeCloseTo(-2, 6);
    expect(t.z).toBeCloseTo(0, 6);
  });

  it("returns null when the fixed frame's own chain cycles without reaching the target", () => {
    // sensor is an orphan (no parent); the fixed frame "a" sits in a cycle
    // a→b→a. Resolving exercises the cycle guard on the fixed-frame-side walk.
    const { ros, deliver } = makeRos();
    const client = new ROS2TFClient({ ros, fixedFrame: "a" });
    deliver("/tf", tfMessage({ parent: "b", child: "a" }, { parent: "a", child: "b" }));
    deliver("/tf", tfMessage({ parent: "root", child: "sensor" }));

    const cb = vi.fn<TFCallback>();
    client.subscribe("sensor", cb);
    expect(cb).not.toHaveBeenCalled();
  });

  it("returns null (and never delivers) when the chain contains a cycle", () => {
    const { ros, deliver } = makeRos();
    const client = new ROS2TFClient({ ros, fixedFrame: "world" });
    // a → b → a — never reaches `world`, and the cycle guard returns null.
    deliver("/tf", tfMessage({ parent: "b", child: "a" }, { parent: "a", child: "b" }));
    const cb = vi.fn<TFCallback>();
    client.subscribe("a", cb);
    expect(cb).not.toHaveBeenCalled();
  });

  it("ignores TF messages whose payload does not match the TFMessage schema, warning once", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { ros, deliver } = makeRos();
    const client = new ROS2TFClient({ ros, fixedFrame: "world" });
    const cb = vi.fn<TFCallback>();
    client.subscribe("a", cb);
    // Missing `transforms` array — zod safeParse rejects, handler should no-op.
    deliver("/tf", { not: "a tf message" });
    deliver("/tf", { still: "bad" });
    expect(cb).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });
});

describe("ROS2TFClient — reconnect", () => {
  it("re-subscribes to /tf and /tf_static after a rosbridge reconnect", () => {
    const { ros, deliver } = makeRos();
    const client = new ROS2TFClient({ ros, fixedFrame: "world" });
    const tfSubsBefore = ros.subscribeTopic.mock.calls.filter(
      ([t]) => t === "/tf"
    ).length;

    // The foxglove Ros emits "connection" on reconnect after clearing its
    // subscription state; fire the registered listener to simulate that.
    const connectionCall = ros.on.mock.calls.find(([event]) => event === "connection");
    if (!connectionCall)
      throw new Error("expected a connection listener to be registered");
    const onConnection = connectionCall[1];
    if (typeof onConnection !== "function") {
      throw new Error("connection listener is not a function");
    }
    onConnection();

    const tfSubsAfter = ros.subscribeTopic.mock.calls.filter(([t]) => t === "/tf").length;
    expect(tfSubsAfter).toBe(tfSubsBefore + 1);

    // The prior /tf callback is torn down before re-subscribing, so it isn't
    // orphaned (dispose only tracks the latest). Without this the constructor's
    // callback would leak and double-dispatch every message.
    const firstTfCallback = ros.subscribeTopic.mock.calls.find(([t]) => t === "/tf")?.[2];
    expect(ros.unsubscribeTopic).toHaveBeenCalledWith("/tf", firstTfCallback);

    // Dispatching resumes through the freshly registered handler.
    const cb = vi.fn<TFCallback>();
    client.subscribe("a", cb);
    deliver("/tf", tfMessage({ parent: "world", child: "a", x: 1 }));
    expect(firstDeliveredTranslation(cb)).toEqual({ x: 1, y: 0, z: 0 });
  });

  it("removes its connection listener and ignores subscribe after dispose", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { ros } = makeRos();
    const client = new ROS2TFClient({ ros, fixedFrame: "world" });

    client.dispose();
    expect(ros.off).toHaveBeenCalledWith("connection", expect.any(Function));

    const cb = vi.fn<TFCallback>();
    client.subscribe("a", cb);
    expect(cb).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("after dispose"));
    warn.mockRestore();
  });
});

describe("ROS2TFClient — robustness", () => {
  it("normalizes a non-unit quaternion from the wire before delivering it", () => {
    const { ros, deliver } = makeRos();
    const client = new ROS2TFClient({ ros, fixedFrame: "world" });
    // w=2 → norm 2; expect it scaled back to a unit quaternion (0,0,0,1).
    deliver(
      "/tf",
      tfMessage({ parent: "world", child: "a", qx: 0, qy: 0, qz: 0, qw: 2 })
    );

    const cb = vi.fn<TFCallback>();
    client.subscribe("a", cb);
    const call = cb.mock.calls[0];
    if (!call) throw new Error("expected a delivery");
    const r = call[0].rotation;
    expect(r.w).toBeCloseTo(1, 10);
    expect(Math.hypot(r.x, r.y, r.z, r.w)).toBeCloseTo(1, 10);
  });

  it("warns once when a frame is published with conflicting parents", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { ros, deliver } = makeRos();
    const client = new ROS2TFClient({ ros, fixedFrame: "world" });
    // Same child "base" published under two different parents.
    deliver("/tf", tfMessage({ parent: "odom", child: "base" }));
    deliver("/tf", tfMessage({ parent: "platform", child: "base" }));
    deliver("/tf", tfMessage({ parent: "odom", child: "base" }));
    deliver("/tf", tfMessage({ parent: "platform", child: "base" }));

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toContain("multiple parents");
    // last-writer-wins still keeps the frame resolvable.
    expect(client.getFrameIds()).toContain("base");
    warn.mockRestore();
  });
});

describe("ROS2TFClient — frame enumeration", () => {
  it("getFrameIds returns the sorted union of every parent and child frame", () => {
    const { ros, deliver } = makeRos();
    const client = new ROS2TFClient({ ros, fixedFrame: "world" });
    deliver(
      "/tf",
      tfMessage({ parent: "world", child: "base" }, { parent: "base", child: "tool" })
    );
    deliver("/tf_static", tfMessage({ parent: "world", child: "camera" }));

    expect(client.getFrameIds()).toEqual(["base", "camera", "tool", "world"]);
  });

  it("normalizes leading slashes so a frame is not double-counted", () => {
    const { ros, deliver } = makeRos();
    const client = new ROS2TFClient({ ros, fixedFrame: "world" });
    deliver("/tf", tfMessage({ parent: "/world", child: "/base" }));

    expect(client.getFrameIds()).toEqual(["base", "world"]);
  });

  it("invokes a frames listener immediately with the current frame list", () => {
    const { ros, deliver } = makeRos();
    const client = new ROS2TFClient({ ros, fixedFrame: "world" });
    deliver("/tf", tfMessage({ parent: "world", child: "base" }));

    const onFrames = vi.fn<(frames: string[]) => void>();
    client.addFramesListener(onFrames);
    expect(onFrames).toHaveBeenCalledTimes(1);
    expect(onFrames).toHaveBeenLastCalledWith(["base", "world"]);
  });

  it("notifies listeners when new frames appear but not when the same frames re-publish", () => {
    const { ros, deliver } = makeRos();
    const client = new ROS2TFClient({ ros, fixedFrame: "world" });
    const onFrames = vi.fn<(frames: string[]) => void>();
    client.addFramesListener(onFrames);
    // Immediate call with the (empty) starting list.
    expect(onFrames).toHaveBeenCalledTimes(1);

    deliver("/tf", tfMessage({ parent: "world", child: "base" }));
    expect(onFrames).toHaveBeenCalledTimes(2);
    expect(onFrames).toHaveBeenLastCalledWith(["base", "world"]);

    // Re-publishing the same frames must not fire the listener again.
    deliver("/tf", tfMessage({ parent: "world", child: "base", x: 7 }));
    expect(onFrames).toHaveBeenCalledTimes(2);

    // A genuinely new frame fires it once more.
    deliver("/tf", tfMessage({ parent: "world", child: "tool" }));
    expect(onFrames).toHaveBeenCalledTimes(3);
    expect(onFrames).toHaveBeenLastCalledWith(["base", "tool", "world"]);
  });

  it("stops notifying after removeFramesListener", () => {
    const { ros, deliver } = makeRos();
    const client = new ROS2TFClient({ ros, fixedFrame: "world" });
    const onFrames = vi.fn<(frames: string[]) => void>();
    client.addFramesListener(onFrames);
    client.removeFramesListener(onFrames);

    deliver("/tf", tfMessage({ parent: "world", child: "base" }));
    // Only the immediate call from addFramesListener.
    expect(onFrames).toHaveBeenCalledTimes(1);
  });

  it("clears the known frame list on dispose", () => {
    const { ros, deliver } = makeRos();
    const client = new ROS2TFClient({ ros, fixedFrame: "world" });
    deliver("/tf", tfMessage({ parent: "world", child: "base" }));
    expect(client.getFrameIds()).toEqual(["base", "world"]);

    client.dispose();
    expect(client.getFrameIds()).toEqual([]);
  });
});

describe("ROS2TFClient — dispose", () => {
  it("unsubscribes both /tf and /tf_static and clears all internal state", () => {
    const { ros, deliver } = makeRos();
    const client = new ROS2TFClient({ ros, fixedFrame: "world" });
    const cb = vi.fn<TFCallback>();
    client.subscribe("a", cb);

    // Pin per-topic callback identity — Topic.unsubscribe keys by reference,
    // so a shared handler would leak /tf_static on dispose.
    const tfSubscribeCall = ros.subscribeTopic.mock.calls.find(
      ([topic]) => topic === "/tf"
    );
    const tfStaticSubscribeCall = ros.subscribeTopic.mock.calls.find(
      ([topic]) => topic === "/tf_static"
    );
    if (!tfSubscribeCall || !tfStaticSubscribeCall) {
      throw new Error("expected subscribeTopic calls for both /tf and /tf_static");
    }
    const tfHandler = tfSubscribeCall[2];
    const tfStaticHandler = tfStaticSubscribeCall[2];
    expect(tfHandler).not.toBe(tfStaticHandler);

    client.dispose();
    expect(ros.unsubscribeTopic).toHaveBeenCalledWith("/tf", tfHandler);
    expect(ros.unsubscribeTopic).toHaveBeenCalledWith("/tf_static", tfStaticHandler);

    // After dispose, the handler map is cleared on the adapter side. Re-deliver
    // via the captured handler reference and confirm the subscriber never fires.
    deliver("/tf", tfMessage({ parent: "world", child: "a", x: 5 }));
    expect(cb).not.toHaveBeenCalled();
  });
});

describe("ROS2TFClient — /tf throttle", () => {
  it("drops /tf updates inside the rate window but always passes /tf_static", () => {
    let nowMs = 0;
    const nowSpy = vi.spyOn(performance, "now").mockImplementation(() => nowMs);
    const { ros, deliver } = makeRos();
    const client = new ROS2TFClient({ ros, fixedFrame: "world", rate: 20 }); // 50ms window
    const cb = vi.fn<TFCallback>();
    client.subscribe("a", cb);

    deliver("/tf", tfMessage({ parent: "world", child: "a", x: 1 })); // leading edge, delivered
    expect(firstDeliveredTranslation(cb)).toEqual({ x: 1, y: 0, z: 0 });

    nowMs = 20; // within 50ms, dropped
    deliver("/tf", tfMessage({ parent: "world", child: "a", x: 2 }));
    expect(cb).toHaveBeenCalledTimes(1);

    nowMs = 60; // past the window, delivered
    deliver("/tf", tfMessage({ parent: "world", child: "a", x: 3 }));
    expect(cb).toHaveBeenCalledTimes(2);

    // A static transform is never throttled, even back-to-back at the same instant.
    const staticCb = vi.fn<TFCallback>();
    client.subscribe("s", staticCb);
    deliver("/tf_static", tfMessage({ parent: "world", child: "s", x: 9 }));
    deliver("/tf_static", tfMessage({ parent: "world", child: "s", x: 9 }));
    expect(staticCb.mock.calls.length).toBeGreaterThanOrEqual(2);
    nowSpy.mockRestore();
  });
});
