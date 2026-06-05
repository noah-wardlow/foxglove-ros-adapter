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
  /**
   * Max /tf processing rate in Hz (roslib semantics). Throttled client-side to
   * a `1000 / rate` ms leading-edge window; 0 / undefined / non-finite disables
   * throttling. /tf_static is never throttled (see subscribeTF).
   */
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

/**
 * Notified whenever the set of frames known to the client grows. Receives the
 * full sorted frame list. Used by the TF visualization layer to populate the
 * frame-selection UI; not part of roslib's ROS2TFClient API.
 */
type FramesCallback = (frames: string[]) => void;

/**
 * Stored direct transform: parent → child, keyed by child frame id. One entry
 * per child — `resolveTransform` relies on each frame having a single parent, so
 * a frame published by multiple authorities is reduced to last-writer-wins (with
 * a one-time warning; see `handleTFMessage`).
 */
interface ParentedTransform {
  parentFrame: string;
  transform: Transform;
}

/** Strip any leading slash so keys compare consistently. */
function normalizeFrameId(frame: string): string {
  return frame.replace(/^\/+/, "");
}

/**
 * Return a unit quaternion. TF rotations enter straight off the wire and zod
 * only checks the four fields are numbers, not that ‖q‖≈1; `Transform.inverse`
 * and composition assume unit quaternions, so a drifted or hand-edited rotation
 * would otherwise skew every descendant frame. Falls back to identity for a
 * degenerate (zero-norm) quaternion.
 */
function normalizeQuaternion(q: {
  x: number;
  y: number;
  z: number;
  w: number;
}): Quaternion {
  const norm = Math.hypot(q.x, q.y, q.z, q.w);
  if (norm === 0) {
    return new Quaternion({ x: 0, y: 0, z: 0, w: 1 });
  }
  return new Quaternion({ x: q.x / norm, y: q.y / norm, z: q.z / norm, w: q.w / norm });
}

/**
 * Leading-edge throttle: fire immediately, then drop calls until `windowMs`
 * elapses (no trailing catch-up). Uses the monotonic `performance.now()` clock
 * so a long-running UI is immune to wall-clock changes. foxglove_bridge delivers
 * every published message (no server-side rate cap, see topic.ts), so /tf is
 * capped here. Mirrors the throttle in `Topic`.
 */
function throttleLeadingEdge(fn: MessageCallback, windowMs: number): MessageCallback {
  let lastFiredAt = -Infinity;
  return (msg) => {
    const now = performance.now();
    if (now - lastFiredAt < windowMs) return;
    lastFiredAt = now;
    fn(msg);
  };
}

export class ROS2TFClient {
  private readonly ros: Ros;
  private readonly fixedFrame: string;
  private readonly frameCallbacks = new Map<string, Set<TFCallback>>();
  /** child_frame_id → {parent, local transform}. One entry per child. */
  private readonly directTransforms = new Map<string, ParentedTransform>();
  // Every frame id ever seen as a parent or child, for enumeration. Grows
  // monotonically for the life of the client (only dispose() clears it), which
  // assumes frame ids are stable for a connection — true for a fixed robot, but
  // a source that mints transient frame ids would accumulate stale entries.
  private readonly knownFrames = new Set<string>();
  private readonly framesListeners = new Set<FramesCallback>();
  // Children for which a conflicting parent has already been reported, so the
  // multi-authority warning fires once per child rather than every tick.
  private readonly multiParentWarned = new Set<string>();
  private tfSub: MessageCallback | null = null;
  private tfStaticSub: MessageCallback | null = null;
  private readonly onReconnect: () => void;
  private readonly throttleMs: number;
  private parseWarned = false;
  private disposed = false;

  constructor(options: TFClientOptions) {
    this.ros = options.ros;
    this.fixedFrame = normalizeFrameId(options.fixedFrame ?? "world");
    // rate is in Hz; convert to a ms throttle window. 0 / non-finite disables it.
    const rate = options.rate ?? 0;
    this.throttleMs = Number.isFinite(rate) && rate > 0 ? 1000 / rate : 0;
    // The foxglove Ros reuses the same instance across reconnects and clears all
    // subscription state on close, so a one-time constructor subscription is
    // silently dropped on the first WebSocket drop. Re-subscribe on reconnect —
    // the same invariant `useTopicSubscription` maintains for ordinary topics.
    this.onReconnect = () => this.subscribeTF();
    this.ros.on("connection", this.onReconnect);
    this.subscribeTF();
  }

  subscribe(frameId: string, callback: TFCallback): void {
    if (this.warnIfDisposed("subscribe")) return;
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
      const callbacks = this.frameCallbacks.get(key);
      callbacks?.delete(callback);
      // Drop the now-empty Set so a session that toggles many frames on and off
      // doesn't accumulate empty entries keyed by every frame ever subscribed.
      if (callbacks?.size === 0) {
        this.frameCallbacks.delete(key);
      }
    } else {
      this.frameCallbacks.delete(key);
    }
  }

  /**
   * Sorted list of every frame seen so far on /tf or /tf_static (as a parent or
   * child). MoveIt Pro extension used to drive the TF visualization frame list.
   */
  getFrameIds(): string[] {
    return [...this.knownFrames].sort((a, b) => a.localeCompare(b));
  }

  /**
   * Register a listener fired whenever new frames appear. Invoked immediately
   * with the current frame list so callers don't miss frames seen before they
   * subscribed. MoveIt Pro extension, not part of roslib's ROS2TFClient.
   */
  addFramesListener(callback: FramesCallback): void {
    if (this.warnIfDisposed("addFramesListener")) return;
    this.framesListeners.add(callback);
    callback(this.getFrameIds());
  }

  removeFramesListener(callback: FramesCallback): void {
    this.framesListeners.delete(callback);
  }

  dispose(): void {
    this.disposed = true;
    this.ros.off("connection", this.onReconnect);
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
    this.knownFrames.clear();
    this.framesListeners.clear();
    this.multiParentWarned.clear();
  }

  /** Warn once if a mutating method is called on a disposed client. */
  private warnIfDisposed(method: string): boolean {
    if (this.disposed) {
      console.warn(`ROS2TFClient.${method}() called after dispose(); ignoring.`);
    }
    return this.disposed;
  }

  private subscribeTF(): void {
    // Idempotent: drop any existing handles before re-subscribing. The
    // constructor calls this once, and the "connection" handler calls it again
    // on every (re)connect — including the first connect when the client was
    // built before the socket opened. Without tearing down first, that race
    // would double-subscribe and orphan the previous callbacks (dispose only
    // tracks the latest). On a real reconnect the foxglove Ros has already
    // cleared its side, so these unsubscribes are harmless no-ops.
    if (this.tfSub) this.ros.unsubscribeTopic("/tf", this.tfSub);
    if (this.tfStaticSub) this.ros.unsubscribeTopic("/tf_static", this.tfStaticSub);

    // Distinct callback identities — Topic.unsubscribe keys by reference, so
    // sharing one arrow makes dispose()'s second unsubscribe a no-op.
    const dispatch: MessageCallback = (msg) => this.dispatchTFMessage(msg);

    // /tf can arrive far faster than we redraw, so throttle it client-side when
    // a rate was requested. /tf_static is latched and low-volume, and a dropped
    // static transform is lost permanently (never re-published), so it is never
    // throttled. When throttleMs is 0 the dispatch callback is registered
    // directly, so the hot path takes no wrapper overhead (same as Topic).
    this.tfSub =
      this.throttleMs > 0 ? throttleLeadingEdge(dispatch, this.throttleMs) : dispatch;
    this.ros.subscribeTopic("/tf", "tf2_msgs/msg/TFMessage", this.tfSub);

    this.tfStaticSub = (msg) => this.dispatchTFMessage(msg);
    this.ros.subscribeTopic("/tf_static", "tf2_msgs/msg/TFMessage", this.tfStaticSub);
  }

  private dispatchTFMessage(msg: unknown): void {
    const parsed = tfMessageSchema.safeParse(msg);
    if (parsed.success) {
      this.handleTFMessage(parsed.data);
    } else if (!this.parseWarned) {
      // Warn once rather than every tick so a wire-shape drift (e.g. a tf2_msgs
      // field rename across distros) is visible instead of silently empty.
      this.parseWarned = true;
      console.warn("ROS2TFClient: ignoring /tf message that failed schema validation.");
    }
  }

  /**
   * Warn once per child when it is published with a parent different from the
   * one already stored. A frame with two live parents is a malformed tree (tf2
   * surfaces this as a multiple-authority warning). We keep last-writer-wins so
   * resolution still works, but a silent pick can resolve through a different
   * parent than tf2/RViz would, so make the misconfiguration visible.
   */
  private warnIfReparented(childFrame: string, parentFrame: string): void {
    const existing = this.directTransforms.get(childFrame);
    if (
      !existing ||
      existing.parentFrame === parentFrame ||
      this.multiParentWarned.has(childFrame)
    ) {
      return;
    }
    this.multiParentWarned.add(childFrame);
    console.warn(
      `TF: frame "${childFrame}" is published with multiple parents ` +
        `("${existing.parentFrame}" and "${parentFrame}"); using the most ` +
        `recent. This is a malformed TF tree and may render differently from RViz.`
    );
  }

  private handleTFMessage(msg: TFMessage): void {
    // Whether any edge was updated this tick. The re-resolution pass below
    // ignores *which* edges changed (it re-resolves every subscribed frame), so
    // a boolean is enough — no need to allocate a Set per tick.
    let anyChanged = false;
    const framesBefore = this.knownFrames.size;

    for (const tfStamped of msg.transforms) {
      const childFrame = normalizeFrameId(tfStamped.child_frame_id);
      const parentFrame = normalizeFrameId(tfStamped.header.frame_id);
      const t = tfStamped.transform;

      this.knownFrames.add(childFrame);
      this.knownFrames.add(parentFrame);

      const transform = new Transform({
        translation: new Vector3({
          x: t.translation.x,
          y: t.translation.y,
          z: t.translation.z
        }),
        // Normalize at the ingest boundary so downstream inverse/compose can
        // assume unit quaternions (see normalizeQuaternion).
        rotation: normalizeQuaternion(t.rotation)
      });

      this.warnIfReparented(childFrame, parentFrame);
      this.directTransforms.set(childFrame, { parentFrame, transform });
      anyChanged = true;
    }

    // Notify frame-list listeners only when the known set actually grew, so
    // the steady state (same frames re-published every tick) costs nothing.
    if (this.knownFrames.size !== framesBefore) {
      const frames = this.getFrameIds();
      for (const listener of this.framesListeners) {
        listener(frames);
      }
    }

    if (!anyChanged) return;

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
   * Resolve the transform from `fixedFrame` to `frameId`, i.e. the pose of
   * `frameId` expressed in `fixedFrame`.
   *
   * tf2 (and RViz) can relate any two connected frames, not just a frame and
   * its descendant: it walks both frames up to their lowest common ancestor and
   * inverts one side. We do the same. Walking only child→parent from `frameId`
   * to `fixedFrame` (the previous approach) silently failed for any frame that
   * is an ancestor of — or in a sibling branch to — `fixedFrame`, which is the
   * common case for mobile-base trees where the reference frame sits below
   * `map`/`odom`.
   *
   * Returns null if the two frames are not connected (yet) or the tree is
   * malformed (cycle).
   *
   * Time semantics: this composes each edge's most recent value. Unlike tf2 it
   * does not interpolate edges to a common timestamp, so during fast motion with
   * edges published at different rates the result can briefly lead or lag tf2's.
   * For a visualization layer this is an accepted simplification.
   */
  private resolveTransform(frameId: string): Transform | null {
    if (frameId === this.fixedFrame) {
      return Transform.identity();
    }

    // Fast path for a direct child of the fixed frame — by far the most common
    // case (markers, tip frames) — avoids allocating the ancestor map every tick.
    const direct = this.directTransforms.get(frameId);
    if (direct !== undefined) {
      if (direct.parentFrame === this.fixedFrame) {
        return direct.transform;
      }
    }

    // Map each ancestor A of frameId (including frameId itself) to T_A_frameId.
    const targetAncestors = this.ancestorTransforms(frameId);
    if (!targetAncestors) return null;

    // Walk up from fixedFrame until we reach a frame that is also an ancestor
    // of frameId — the lowest common ancestor (LCA). `tFixed` accumulates
    // T_current_fixedFrame as we climb.
    let current = this.fixedFrame;
    let tFixed = Transform.identity();
    const visited = new Set<string>();
    for (;;) {
      const tToTarget = targetAncestors.get(current);
      if (tToTarget) {
        // current is the LCA: T_LCA_fixedFrame = tFixed, T_LCA_frameId = tToTarget.
        // T_fixedFrame_frameId = inverse(T_LCA_fixedFrame) ∘ T_LCA_frameId.
        return tFixed.inverse().multiply(tToTarget);
      }
      if (visited.has(current)) return null;
      visited.add(current);
      const direct = this.directTransforms.get(current);
      if (!direct) return null; // reached a root with no common ancestor — disconnected.
      tFixed = direct.transform.multiply(tFixed);
      current = direct.parentFrame;
    }
  }

  /**
   * Walk from `frameId` up to its tree root, returning a map from every
   * ancestor frame (including `frameId`) to the transform expressing `frameId`
   * in that ancestor's frame. Returns null on a cycle.
   */
  private ancestorTransforms(frameId: string): Map<string, Transform> | null {
    const ancestors = new Map<string, Transform>();
    let current = frameId;
    let accumulated = Transform.identity(); // T_current_frameId
    ancestors.set(current, accumulated);

    const visited = new Set<string>();
    for (;;) {
      if (visited.has(current)) return null;
      visited.add(current);
      const direct = this.directTransforms.get(current);
      if (!direct) return ancestors; // reached the root.
      accumulated = direct.transform.multiply(accumulated);
      current = direct.parentFrame;
      ancestors.set(current, accumulated);
    }
  }
}
