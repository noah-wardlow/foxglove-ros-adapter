import { describe, expect, it } from "vitest";

import { Quaternion, Transform, Vector3 } from "../src/types";

describe("Vector3", () => {
  it("defaults to the zero vector", () => {
    const v = new Vector3();
    expect(v).toEqual({ x: 0, y: 0, z: 0 });
  });

  it("honors any provided components", () => {
    const v = new Vector3({ x: 1, y: 2, z: 3 });
    expect(v).toEqual({ x: 1, y: 2, z: 3 });
  });

  it("fills missing components with 0", () => {
    const v = new Vector3({ y: 5 });
    expect(v).toEqual({ x: 0, y: 5, z: 0 });
  });
});

describe("Quaternion", () => {
  it("defaults to the identity rotation (w=1)", () => {
    const q = new Quaternion();
    expect(q).toEqual({ x: 0, y: 0, z: 0, w: 1 });
  });

  it("honors any provided components", () => {
    const q = new Quaternion({ x: 0.5, y: 0.5, z: 0.5, w: 0.5 });
    expect(q).toEqual({ x: 0.5, y: 0.5, z: 0.5, w: 0.5 });
  });

  it("fills missing components with 0 except w which defaults to 1", () => {
    const q = new Quaternion({ z: 0.3 });
    expect(q).toEqual({ x: 0, y: 0, z: 0.3, w: 1 });
  });
});

describe("Transform", () => {
  it("defaults to identity (zero translation, identity rotation)", () => {
    const t = new Transform();
    expect(t.translation).toEqual({ x: 0, y: 0, z: 0 });
    expect(t.rotation).toEqual({ x: 0, y: 0, z: 0, w: 1 });
  });

  it("identity() is equivalent to the default constructor", () => {
    const id = Transform.identity();
    expect(id.translation).toEqual({ x: 0, y: 0, z: 0 });
    expect(id.rotation).toEqual({ x: 0, y: 0, z: 0, w: 1 });
  });

  it("multiplying by identity returns an equivalent transform", () => {
    const t = new Transform({
      translation: new Vector3({ x: 1, y: 2, z: 3 }),
      rotation: new Quaternion({ x: 0, y: 0, z: 0, w: 1 })
    });
    const composed = t.multiply(Transform.identity());
    expect(composed.translation).toEqual({ x: 1, y: 2, z: 3 });
    expect(composed.rotation).toEqual({ x: 0, y: 0, z: 0, w: 1 });
  });

  it("composes translations additively when both rotations are identity", () => {
    const a = new Transform({ translation: new Vector3({ x: 1, y: 0, z: 0 }) });
    const b = new Transform({ translation: new Vector3({ x: 0, y: 2, z: 0 }) });
    const composed = a.multiply(b);
    expect(composed.translation).toEqual({ x: 1, y: 2, z: 0 });
  });

  it("rotates the second transform's translation by the first's rotation", () => {
    // 90° rotation about +Z: +X -> +Y.
    const halfSqrt2 = Math.SQRT1_2;
    const rotZ90 = new Transform({
      rotation: new Quaternion({ x: 0, y: 0, z: halfSqrt2, w: halfSqrt2 })
    });
    const translateX = new Transform({
      translation: new Vector3({ x: 1, y: 0, z: 0 })
    });
    const composed = rotZ90.multiply(translateX);
    expect(composed.translation.x).toBeCloseTo(0, 10);
    expect(composed.translation.y).toBeCloseTo(1, 10);
    expect(composed.translation.z).toBeCloseTo(0, 10);
  });

  it("multiplies rotations as expected (two 90° Z rotations → 180° Z rotation)", () => {
    const halfSqrt2 = Math.SQRT1_2;
    const rotZ90 = new Transform({
      rotation: new Quaternion({ x: 0, y: 0, z: halfSqrt2, w: halfSqrt2 })
    });
    const composed = rotZ90.multiply(rotZ90);
    // 180° about +Z → (0, 0, 1, 0).
    expect(composed.rotation.x).toBeCloseTo(0, 10);
    expect(composed.rotation.y).toBeCloseTo(0, 10);
    expect(composed.rotation.z).toBeCloseTo(1, 10);
    expect(composed.rotation.w).toBeCloseTo(0, 10);
  });

  it("inverse composed with the original yields identity", () => {
    const halfSqrt2 = Math.SQRT1_2;
    const t = new Transform({
      translation: new Vector3({ x: 1, y: 2, z: 3 }),
      rotation: new Quaternion({ x: 0, y: 0, z: halfSqrt2, w: halfSqrt2 })
    });
    const identity = t.multiply(t.inverse());
    expect(identity.translation.x).toBeCloseTo(0, 10);
    expect(identity.translation.y).toBeCloseTo(0, 10);
    expect(identity.translation.z).toBeCloseTo(0, 10);
    expect(identity.rotation.w).toBeCloseTo(1, 10);

    // multiply is non-commutative, so check the other order too — a sign error
    // in the inverse would pass one ordering and fail the other.
    const identity2 = t.inverse().multiply(t);
    expect(identity2.translation.x).toBeCloseTo(0, 10);
    expect(identity2.translation.y).toBeCloseTo(0, 10);
    expect(identity2.translation.z).toBeCloseTo(0, 10);
    expect(identity2.rotation.w).toBeCloseTo(1, 10);
  });

  it("inverts a pure translation by negating it", () => {
    const t = new Transform({ translation: new Vector3({ x: 1, y: -2, z: 3 }) });
    expect(t.inverse().translation).toEqual({ x: -1, y: 2, z: -3 });
  });

  it("inverts a rotation to its conjugate", () => {
    const halfSqrt2 = Math.SQRT1_2;
    const t = new Transform({
      rotation: new Quaternion({ x: 0, y: 0, z: halfSqrt2, w: halfSqrt2 })
    });
    const inv = t.inverse();
    expect(inv.rotation.z).toBeCloseTo(-halfSqrt2, 10);
    expect(inv.rotation.w).toBeCloseTo(halfSqrt2, 10);
  });
});
