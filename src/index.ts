/**
 * foxglove-ros-adapter — Drop-in replacement for roslib.
 *
 * This module exports classes with the same names and API as roslib
 * (ROSLIB.Ros, ROSLIB.Topic, ROSLIB.Service, etc.) but communicates
 * using the Foxglove WebSocket protocol instead of rosbridge v2 JSON.
 *
 * When aliased as "roslib" via Vite's resolve.alias, all existing imports
 * like `import { Topic } from "roslib"` resolve to this adapter with
 * zero source changes.
 */

export { Ros } from "./ros";
export { Topic } from "./topic";
export { Service } from "./service";
export { Param } from "./param";
export { ROS2TFClient } from "./tf-client";
export { Transform, Vector3, Quaternion } from "./types";
