import { describe, it, expect } from 'vitest';
import {
  v3,
  add,
  sub,
  scale,
  dot,
  cross,
  length,
  normalize,
  distance,
  lerpV,
  findRotation,
  angleBetween3DCoords,
  rollPitchYaw,
} from '../../../../src/video-converter/math/Vector';
import { quatRotateVec } from '../../../../src/video-converter/math/Quat';

describe('Vector — basic ops', () => {
  it('add / sub / scale', () => {
    expect(add(v3(1, 2, 3), v3(4, 5, 6))).toEqual({ x: 5, y: 7, z: 9 });
    expect(sub(v3(4, 5, 6), v3(1, 2, 3))).toEqual({ x: 3, y: 3, z: 3 });
    expect(scale(v3(1, 2, 3), 2)).toEqual({ x: 2, y: 4, z: 6 });
  });

  it('dot product', () => {
    expect(dot(v3(1, 0, 0), v3(0, 1, 0))).toBe(0);
    expect(dot(v3(1, 2, 3), v3(4, 5, 6))).toBe(32);
  });

  it('cross product (right-handed)', () => {
    expect(cross(v3(1, 0, 0), v3(0, 1, 0))).toEqual({ x: 0, y: 0, z: 1 });
    expect(cross(v3(0, 1, 0), v3(0, 0, 1))).toEqual({ x: 1, y: 0, z: 0 });
    expect(cross(v3(0, 0, 1), v3(1, 0, 0))).toEqual({ x: 0, y: 1, z: 0 });
  });

  it('length / normalize / distance', () => {
    expect(length(v3(3, 4, 0))).toBe(5);
    const n = normalize(v3(3, 4, 0));
    expect(length(n)).toBeCloseTo(1, 12);
    expect(distance(v3(0, 0, 0), v3(3, 4, 0))).toBe(5);
  });

  it('normalize zero vector returns zero', () => {
    expect(normalize(v3(0, 0, 0))).toEqual({ x: 0, y: 0, z: 0 });
  });

  it('lerpV midpoint', () => {
    expect(lerpV(v3(0, 0, 0), v3(10, 20, 30), 0.5)).toEqual({ x: 5, y: 10, z: 15 });
  });
});

describe('Vector — findRotation', () => {
  it('Z 90°: from (1,0,0) to (0,1,0)', () => {
    const q = findRotation(v3(1, 0, 0), v3(0, 1, 0));
    const result = quatRotateVec(q, v3(1, 0, 0));
    expect(result.x).toBeCloseTo(0, 9);
    expect(result.y).toBeCloseTo(1, 9);
    expect(result.z).toBeCloseTo(0, 9);
  });

  it('handles non-normalized inputs', () => {
    const q = findRotation(v3(2, 0, 0), v3(0, 5, 0));
    const result = quatRotateVec(q, v3(1, 0, 0));
    expect(result.x).toBeCloseTo(0, 9);
    expect(result.y).toBeCloseTo(1, 9);
  });

  it('identical vectors → identity rotation', () => {
    const q = findRotation(v3(1, 1, 1), v3(2, 2, 2));
    const v = v3(0.7, -0.3, 0.5);
    const result = quatRotateVec(q, v);
    expect(result.x).toBeCloseTo(v.x, 9);
    expect(result.y).toBeCloseTo(v.y, 9);
    expect(result.z).toBeCloseTo(v.z, 9);
  });
});

describe('Vector — angleBetween3DCoords', () => {
  it('collinear (a-b-c straight) → π', () => {
    const a = v3(0, 0, 0);
    const b = v3(1, 0, 0);
    const c = v3(2, 0, 0);
    expect(angleBetween3DCoords(a, b, c)).toBeCloseTo(Math.PI, 9);
  });

  it('right angle at b → π/2', () => {
    const a = v3(1, 0, 0);
    const b = v3(0, 0, 0);
    const c = v3(0, 1, 0);
    expect(angleBetween3DCoords(a, b, c)).toBeCloseTo(Math.PI / 2, 9);
  });

  it('a == c at b → 0 (degenerate but handled)', () => {
    const a = v3(1, 0, 0);
    const b = v3(0, 0, 0);
    const c = v3(1, 0, 0);
    expect(angleBetween3DCoords(a, b, c)).toBeCloseTo(0, 9);
  });

  it('45° angle', () => {
    const a = v3(1, 0, 0);
    const b = v3(0, 0, 0);
    const c = v3(1, 1, 0);
    expect(angleBetween3DCoords(a, b, c)).toBeCloseTo(Math.PI / 4, 9);
  });
});

describe('Vector — rollPitchYaw', () => {
  it('canonical horizontal plane → all zero', () => {
    // a, b, c 在 xy 平面：x 軸沿 +x、c 在 +y 側
    const a = v3(0, 0, 0);
    const b = v3(1, 0, 0);
    const c = v3(0, 1, 0);
    const { roll, pitch, yaw } = rollPitchYaw(a, b, c);
    expect(roll).toBeCloseTo(0, 9);
    expect(pitch).toBeCloseTo(0, 9);
    expect(yaw).toBeCloseTo(0, 9);
  });

  it('returns finite values for tilted plane', () => {
    // 三角形傾斜，三個分量都不應 NaN
    const a = v3(0, 0, 0);
    const b = v3(1, 0.5, 0);
    const c = v3(0.2, 1, 0.3);
    const { roll, pitch, yaw } = rollPitchYaw(a, b, c);
    expect(Number.isFinite(roll)).toBe(true);
    expect(Number.isFinite(pitch)).toBe(true);
    expect(Number.isFinite(yaw)).toBe(true);
  });
});
