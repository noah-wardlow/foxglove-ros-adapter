# foxglove-ros-adapter

A drop-in replacement for [`roslib`](https://github.com/RobotWebTools/roslibjs) that speaks the
[Foxglove WebSocket protocol](https://github.com/foxglove/ws-protocol) to
[`foxglove_bridge`](https://github.com/foxglove/ros-foxglove-bridge) instead of `rosbridge_server`.

Same `Ros` / `Topic` / `Service` / `Param` / `ROS2TFClient` API — your existing code keeps working,
but you get CDR-native messages over the actively-maintained Foxglove bridge.

## Why

- `roslibjs` targets `rosbridge_server`, which is deprecated for ROS 2 and suffers JSON-encoding overhead
  on every message.
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
import { Ros, Topic, Service } from "foxglove-ros-adapter";

const ros = new Ros({ url: "ws://localhost:8765" });

ros.on("connection", () => console.log("connected"));
ros.on("close", () => console.log("disconnected"));

const jointStates = new Topic({
  ros,
  name: "/joint_states",
  messageType: "sensor_msgs/msg/JointState"
});

jointStates.subscribe((msg) => console.log(msg));
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

- `new Ros({ url })` — connect, `on("connection" | "close" | "error")`, `close()`, `getTopicsForType()`
- `new Topic({ ros, name, messageType })` — `subscribe()`, `unsubscribe()`, `publish()`
- `new Service({ ros, name, serviceType })` — `callService()` (callback API)
- `new Param({ ros, name })` — `get()`, `set()`
- `new ROS2TFClient({ ros, fixedFrame })` — `subscribe(frameId, cb)`, `unsubscribe()`
- Both `foxglove.sdk.v1` (ros-humble-foxglove-bridge 3.2.x / foxglove-sdk-cpp) and legacy
  `foxglove.websocket.v1` subprotocols are advertised on the handshake.

## What's different from `roslib`

- Client-side **service advertising** is not supported — `foxglove_bridge` only exposes server-side
  services. The `actionlib` / `ActionClient` APIs are not provided (actions are exposed as services by
  `foxglove_bridge`, so wrap a goal service + feedback topic yourself if you need them).
- `Topic#advertise()` / `Topic#unadvertise()` are accepted but are no-ops — the adapter advertises
  lazily on first `publish()`.
- `compression`, `throttle_rate`, `queue_size`, `queue_length`, `latch`, `reconnect_on_close`
  options on `Topic` are accepted for API compatibility but ignored; `foxglove_bridge` negotiates
  these on its own.

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
resolves `fixedFrame → frameId` by composing transforms along the chain. Cycles in the tree return
`null` rather than crashing, and subscribers receive an updated transform any time a link in their
chain changes.

## License

MIT © Noah Wardlow
