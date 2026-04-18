/**
 * ROS2TFClient — drop-in replacement for roslib's ROSLIB.ROS2TFClient.
 *
 * Subscribes to /tf and /tf_static topics, builds a parent→child transform
 * graph, and resolves transforms from `fixedFrame` to any requested frame by
 * chaining through intermediate frames.
 */

import { z } from "zod";

import { Ros, type MessageCallback } from "./ros";
import { Transform, Vector3, Quaternion } from "./types";

export interface TFClientOptions {
  ros: Ros;
  fixedFrame?: string;
  angularThres?: number;
  transThres?: number;
  rate?: number;
  serverName?: string;
}

/**
 * Runtime shape of a `tf2_msgs/TFMessage` as deserialized from CDR by the
 * Ros class. Validated with zod at the subscription edge so downstream
 * code works with properly typed values instead of casting the generic
 * `Record<string, unknown>` coming off the wire.
 */
const tfMessageSchema = z.object({
  transforms: z.array(
    z.object({
      header: z.object({
        stamp: z.object({ sec: z.number(), nanosec: z.number() }),
        frame_id: z.string()
      }),
      child_frame_id: z.string(),
      transform: z.object({
        translation: z.object({ x: z.number(), y: z.number(), z: z.number() }),
        rotation: z.object({
          x: z.number(),
          y: z.number(),
          z: z.number(),
          w: z.number()
        })
      })
    })
  )
});
type TFMessage = z.infer<typeof tfMessageSchema>;

type TFCallback = (transform: Transform) => void;

/** Stored direct transform: parent → child, keyed by child frame id. */
interface ParentedTransform {
  parentFrame: string;
  transform: Transform;
}

/** Strip any leading slash so keys compare consistently. */
function normalizeFrameId(frame: string): string {
  return frame.replace(/^\/+/, "");
}

export class ROS2TFClient {
  private readonly ros: Ros;
  private readonly fixedFrame: string;
  private readonly frameCallbacks = new Map<string, Set<TFCallback>>();
  /** child_frame_id → {parent, local transform}. One entry per child. */
  private readonly directTransforms = new Map<string, ParentedTransform>();
  private tfSub: MessageCallback | null = null;
  private tfStaticSub: MessageCallback | null = null;

  constructor(options: TFClientOptions) {
    this.ros = options.ros;
    this.fixedFrame = normalizeFrameId(options.fixedFrame ?? "world");
    this.subscribeTF();
  }

  subscribe(frameId: string, callback: TFCallback): void {
    const key = normalizeFrameId(frameId);
    let callbacks = this.frameCallbacks.get(key);
    if (!callbacks) {
      callbacks = new Set();
      this.frameCallbacks.set(key, callbacks);
    }
    callbacks.add(callback);

    // If we can already resolve the chain, deliver the current transform.
    const resolved = this.resolveTransform(key);
    if (resolved) {
      callback(resolved);
    }
  }

  unsubscribe(frameId: string, callback?: TFCallback): void {
    const key = normalizeFrameId(frameId);
    if (callback) {
      this.frameCallbacks.get(key)?.delete(callback);
    } else {
      this.frameCallbacks.delete(key);
    }
  }

  dispose(): void {
    if (this.tfSub) {
      this.ros.unsubscribeTopic("/tf", this.tfSub);
      this.tfSub = null;
    }
    if (this.tfStaticSub) {
      this.ros.unsubscribeTopic("/tf_static", this.tfStaticSub);
      this.tfStaticSub = null;
    }
    this.frameCallbacks.clear();
    this.directTransforms.clear();
  }

  private subscribeTF(): void {
    const handler: MessageCallback = (msg) => {
      const parsed = tfMessageSchema.safeParse(msg);
      if (parsed.success) this.handleTFMessage(parsed.data);
    };

    this.tfSub = handler;
    this.ros.subscribeTopic("/tf", "tf2_msgs/msg/TFMessage", handler);

    this.tfStaticSub = handler;
    this.ros.subscribeTopic("/tf_static", "tf2_msgs/msg/TFMessage", handler);
  }

  private handleTFMessage(msg: TFMessage): void {
    // Track which frames' resolved transforms may have changed so we can
    // notify subscribers after updating the graph.
    const changed = new Set<string>();

    for (const tfStamped of msg.transforms) {
      const childFrame = normalizeFrameId(tfStamped.child_frame_id);
      const parentFrame = normalizeFrameId(tfStamped.header.frame_id);
      const t = tfStamped.transform;

      const transform = new Transform({
        translation: new Vector3({
          x: t.translation.x,
          y: t.translation.y,
          z: t.translation.z
        }),
        rotation: new Quaternion({
          x: t.rotation.x,
          y: t.rotation.y,
          z: t.rotation.z,
          w: t.rotation.w
        })
      });

      this.directTransforms.set(childFrame, { parentFrame, transform });
      changed.add(childFrame);
    }

    if (changed.size === 0) return;

    // A change to frame X's direct transform can affect any subscriber whose
    // resolved chain passes through X. Cheaper than computing exact impact:
    // re-resolve every subscribed frame and deliver if resolution succeeds.
    for (const [frameId, callbacks] of this.frameCallbacks) {
      if (callbacks.size === 0) continue;
      const resolved = this.resolveTransform(frameId);
      if (resolved) {
        for (const cb of callbacks) {
          cb(resolved);
        }
      }
    }
  }

  /**
   * Compose the transform from `fixedFrame` to `frameId` by walking parent
   * pointers. Returns null if the chain cannot be resolved (broken tree or
   * the requested frame isn't connected to fixedFrame yet).
   */
  private resolveTransform(frameId: string): Transform | null {
    if (frameId === this.fixedFrame) {
      return Transform.identity();
    }

    // Walk up from frameId, collecting local transforms, until we hit
    // fixedFrame or run out of parents.
    const chain: Transform[] = [];
    const visited = new Set<string>();
    let current = frameId;
    while (current !== this.fixedFrame) {
      if (visited.has(current)) {
        // Cycle — malformed tree.
        return null;
      }
      visited.add(current);
      const direct = this.directTransforms.get(current);
      if (!direct) return null;
      chain.push(direct.transform);
      current = direct.parentFrame;
    }

    // Compose: result = T(fixed→p1) ∘ T(p1→p2) ∘ ... ∘ T(pN→frameId).
    // chain holds [T(pN→frameId), ..., T(fixed→p1)]; compose right-to-left.
    let result = Transform.identity();
    for (let i = chain.length - 1; i >= 0; i--) {
      const step = chain[i];
      if (step === undefined) continue;
      result = result.multiply(step);
    }
    return result;
  }
}
