/**
 * Data types matching roslib's Vector3, Quaternion, and Transform classes.
 * These are simple data containers used by the TF system.
 */

export class Vector3 {
  x: number;
  y: number;
  z: number;

  constructor(options?: { x?: number; y?: number; z?: number }) {
    this.x = options?.x ?? 0;
    this.y = options?.y ?? 0;
    this.z = options?.z ?? 0;
  }
}

export class Quaternion {
  x: number;
  y: number;
  z: number;
  w: number;

  constructor(options?: { x?: number; y?: number; z?: number; w?: number }) {
    this.x = options?.x ?? 0;
    this.y = options?.y ?? 0;
    this.z = options?.z ?? 0;
    this.w = options?.w ?? 1;
  }
}

export class Transform {
  translation: Vector3;
  rotation: Quaternion;

  constructor(options?: { translation?: Vector3; rotation?: Quaternion }) {
    this.translation = options?.translation ?? new Vector3();
    this.rotation = options?.rotation ?? new Quaternion();
  }

  static identity(): Transform {
    return new Transform();
  }

  /**
   * Compose two rigid transforms: `this` (a→b) composed with `other` (b→c)
   * yields the transform from a→c.
   */
  multiply(other: Transform): Transform {
    // Rotate other.translation by this.rotation, then add this.translation.
    const rotated = rotateVectorByQuaternion(other.translation, this.rotation);
    const translation = new Vector3({
      x: this.translation.x + rotated.x,
      y: this.translation.y + rotated.y,
      z: this.translation.z + rotated.z
    });
    const rotation = multiplyQuaternions(this.rotation, other.rotation);
    return new Transform({ translation, rotation });
  }
}

function multiplyQuaternions(a: Quaternion, b: Quaternion): Quaternion {
  return new Quaternion({
    x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
    y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
    z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
    w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z
  });
}

function rotateVectorByQuaternion(v: Vector3, q: Quaternion): Vector3 {
  // Standard formula: v' = q * v * q⁻¹, expanded for efficiency.
  const { x, y, z } = v;
  const qx = q.x;
  const qy = q.y;
  const qz = q.z;
  const qw = q.w;
  // t = 2 * (q_vec × v)
  const tx = 2 * (qy * z - qz * y);
  const ty = 2 * (qz * x - qx * z);
  const tz = 2 * (qx * y - qy * x);
  // v' = v + qw * t + q_vec × t
  return new Vector3({
    x: x + qw * tx + (qy * tz - qz * ty),
    y: y + qw * ty + (qz * tx - qx * tz),
    z: z + qw * tz + (qx * ty - qy * tx)
  });
}

/** Channel info advertised by foxglove_bridge. */
export interface FoxgloveChannel {
  id: number;
  topic: string;
  encoding: string;
  schemaName: string;
  schema: string;
  schemaEncoding?: string;
}

/**
 * Service schema side (request or response) as advertised by `foxglove.sdk.v1`.
 * The legacy `foxglove.websocket.v1` protocol used flat `requestSchema`/
 * `responseSchema` fields; the sdk.v1 protocol nests the encoding metadata
 * alongside the schema.
 */
export interface FoxgloveServiceSchemaSide {
  encoding?: string;
  schemaName?: string;
  schemaEncoding?: string;
  schema: string;
}

/** Service info advertised by foxglove_bridge. Accepts both wire shapes. */
export interface FoxgloveService {
  id: number;
  name: string;
  type: string;
  // Legacy flat form.
  requestSchema?: string;
  responseSchema?: string;
  // sdk.v1 nested form.
  request?: FoxgloveServiceSchemaSide;
  response?: FoxgloveServiceSchemaSide;
}

/** Server info sent on connection. */
export interface FoxgloveServerInfo {
  name: string;
  capabilities: string[];
  supportedEncodings?: string[];
  metadata?: Record<string, string>;
  sessionId?: string;
}
