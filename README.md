# foxglove-ros-adapter

[npm package](https://www.npmjs.com/package/foxglove-ros-adapter)

A drop-in replacement for [`roslib`](https://github.com/RobotWebTools/roslibjs) that speaks the
[Foxglove WebSocket protocol](https://github.com/foxglove/ws-protocol) to
[`foxglove_bridge`](https://github.com/foxglove/ros-foxglove-bridge) instead of `rosbridge_server`.

Same `Ros` / `Topic` / `Service` / `Param` / `ROS2TFClient` API — your existing code keeps working,
but you get CDR-native messages over the actively-maintained Foxglove bridge.

## Why

- `roslibjs` targets `rosbridge_server`, which speaks the rosbridge JSON protocol and pays
  JSON-encoding overhead on every message.
- `foxglove_bridge` is the recommended ROS 2 web bridge and uses binary CDR framing natively.
- Rewriting every `new Ros()` / `new Topic()` call site in a large app is painful.

This package gives you the Foxglove wire format with the `roslib` API, so the switch is a bundler
alias instead of a refactor.

## Install

```bash
pnpm add foxglove-ros-adapter
# or
npm install foxglove-ros-adapter
# or
yarn add foxglove-ros-adapter
```

`zod`, `@foxglove/rosmsg`, and `@foxglove/rosmsg2-serialization` are peer dependencies — install
alongside the adapter so they dedupe with anything else in your tree:

```bash
pnpm add zod @foxglove/rosmsg @foxglove/rosmsg2-serialization
```

## Usage

### As a direct import

```ts
import { ActionClient, Ros, Topic, Service } from "foxglove-ros-adapter";

const ros = new Ros({ url: "ws://localhost:8765" });

ros.on("connection", () => console.log("connected"));
ros.on("close", () => console.log("disconnected"));
ros.on("channelsChanged", () => {
  ros.getTopicsForType("sensor_msgs/msg/JointState", (topics) => console.log(topics));
});

const jointStates = new Topic({
  ros,
  name: "/joint_states",
  messageType: "sensor_msgs/msg/JointState"
});

jointStates.subscribe((msg) => console.log(msg));
```

Optional runtime validation:

```ts
import { z } from "zod";

const stringTopic = new Topic({
  ros,
  name: "/status",
  messageType: "std_msgs/msg/String",
  messageSchema: z.object({ data: z.string() })
});
```

### As a drop-in alias for `roslib`

If your codebase imports from `"roslib"` in many places, alias the module at build time:

**Vite**

```ts
// vite.config.ts
import { defineConfig } from "vite";

export default defineConfig({
  resolve: {
    alias: {
      roslib: "foxglove-ros-adapter"
    }
  }
});
```

**Webpack**

```js
// webpack.config.js
module.exports = {
  resolve: {
    alias: {
      roslib: "foxglove-ros-adapter"
    }
  }
};
```

Now every `import { Topic } from "roslib"` resolves to this adapter with zero source changes.

## What's supported

- `new Ros({ url })` — connect,
  `on("connection" | "close" | "error" | "channelsChanged" | "servicesChanged")`,
  `close()`, `getTopicsForType()`, `getActionServers()`, `waitForAction()`
- `new Topic({ ros, name, messageType, messageSchema? })` — `subscribe()`, `unsubscribe()`,
  `publish()`
- `new Service({ ros, name, serviceType })` — `callService()` (callback API)
- `new ActionClient({ ros, name, actionType })` — `sendGoal()`, `cancelGoal()`, `waitGoal()`
- `new Param({ ros, name })` — `get()`, `set()`
- `new ROS2TFClient({ ros, fixedFrame })` — `subscribe(frameId, cb)`, `unsubscribe()`,
  `getFrameIds()`, `addFramesListener(cb)`, `removeFramesListener(cb)`
- Both `foxglove.sdk.v1` (ros-humble-foxglove-bridge 3.2.x / foxglove-sdk-cpp) and legacy
  `foxglove.websocket.v1` subprotocols are advertised on the handshake.

## Actions

Foxglove Bridge exposes ROS 2 actions through the standard hidden action
services and feedback topic when the bridge is launched with hidden entities
enabled:

```bash
ros2 launch foxglove_bridge foxglove_bridge_launch.xml include_hidden:=true
```

The adapter maps action goals to:

- `<action>/_action/send_goal`
- `<action>/_action/get_result`
- `<action>/_action/cancel_goal`
- `<action>/_action/feedback`

```ts
const client = new ActionClient({
  ros,
  name: "/fibonacci",
  actionType: "example_interfaces/action/Fibonacci"
});

await ros.waitForAction("/fibonacci", 5000, { requireFeedback: true });

const goalId = client.sendGoal(
  { order: 5 },
  (result) => console.log(result.status, result.values),
  (feedback) => console.log(feedback.values),
  (error) => console.error(error)
);

await client.waitGoal(goalId, 30_000);
```

Some bridges advertise action request/result schemas with the action payload
flattened into the service message instead of nested under `goal` or `result`.
The adapter detects the advertised schema and serializes the request shape the
bridge expects.

## What's different from `roslib`

- Client-side **service advertising** is not supported — `foxglove_bridge` only exposes server-side
  services.
- ROS 2 actions require `foxglove_bridge` to advertise hidden entities. If `include_hidden` is not
  enabled, action endpoint checks and goal sends report the missing hidden services/topics.
- `Topic#advertise()` / `Topic#unadvertise()` are accepted but are no-ops — the adapter advertises
  lazily on first `publish()`.
- `throttle_rate` is enforced **client-side** (leading-edge, minimum ms between delivered messages)
  since `foxglove_bridge` has no per-subscription rate limiter. When unset or `0`, the subscribe path
  registers the user callback directly — no wrapper, no clock read, no branch per message.
- `messageSchema` on `Topic` is adapter-specific and optional. When supplied, decoded messages are
  parsed with the provided Zod schema before subscriber callbacks run.
- `compression`, `queue_size`, `queue_length`, `latch`, `reconnect_on_close` options on `Topic` are
  accepted for API compatibility but ignored; `foxglove_bridge` negotiates transport concerns on its
  own.

## Requirements

- A browser-like environment: the adapter uses `WebSocket`, `TextEncoder`, `TextDecoder`, and
  `DataView` from the global scope. Works in any modern browser and in Node.js 18+ with the built-in
  `WebSocket` (Node 22+) or a polyfill (`ws`, `undici`).
- A `foxglove_bridge` instance on the ROS 2 side:
  ```bash
  sudo apt install ros-$ROS_DISTRO-foxglove-bridge
  ros2 launch foxglove_bridge foxglove_bridge_launch.xml port:=8765
  ```

## TF resolution

`ROS2TFClient` subscribes to `/tf` and `/tf_static`, builds a parent→child transform graph, and
resolves `fixedFrame → frameId` across any connected frames by walking both sides to their lowest
common ancestor, matching RViz-style sibling and ancestor lookups. Cycles in the tree return `null`
rather than crashing, non-unit quaternions are normalized at the subscription edge, and subscribers
receive an updated transform any time a link in their chain changes.

`rate` on `ROS2TFClient` limits `/tf` processing client-side in Hz. `/tf_static` is never throttled
because static transforms are latched and should not be dropped. `getFrameIds()` and
`addFramesListener()` expose the sorted set of parent and child frames seen so far for frame-selection
UIs.

## License

MIT © Noah Wardlow
