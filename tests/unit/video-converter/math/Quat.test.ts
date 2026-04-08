import { describe, it, expect } from 'vitest';
import {
  quatIdentity,
  quatMul,
  quatConj,
  quatDot,
  quatNormalize,
  quatFromAxisAngle,
  quatFromUnitVectors,
  quatRotateVec,
  quatSlerp,
  quatEnsureShortestPath,
  quatFromMat3,
} from '../../../../src/video-converter/math/Quat';
import type { Quat } from '../../../../src/video-converter/math/Quat';
import { v3 } from '../../../../src/video-converter/math/Vector';

const expectQuatClose = (a: Quat, b: Quat, digits = 9): void => {
  // 同一個旋轉的四元數 q 與 -q 等價，比較時取較近的半球
  const sign = quatDot(a, b) < 0 ? -1 : 1;
  expect(a.x).toBeCloseTo(sign * b.x, digits);
  expect(a.y).toBeCloseTo(sign * b.y, digits);
  expect(a.z).toBeCloseTo(sign * b.z, digits);
  expect(a.w).toBeCloseTo(sign * b.w, digits);
};

describe('Quat', () => {
  describe('quatMul', () => {
    it('quatMul(I, a) = a', () => {
      const a = quatNormalize({ x: 0.1, y: 0.2, z: 0.3, w: 0.9 });
      expectQuatClose(quatMul(quatIdentity(), a), a);
    });

    it('quatMul(a, I) = a', () => {
      const a = quatNormalize({ x: 0.1, y: 0.2, z: 0.3, w: 0.9 });
      expectQuatClose(quatMul(a, quatIdentity()), a);
    });

    it('two 90° rotations around X compose to 180°', () => {
      const half = quatFromAxisAngle(v3(1, 0, 0), Math.PI / 2);
      const full = quatMul(half, half);
      const expected = quatFromAxisAngle(v3(1, 0, 0), Math.PI);
      expectQuatClose(full, expected);
    });
  });

  describe('quatConj', () => {
    it('quat * conj = identity', () => {
      const q = quatFromAxisAngle(v3(0, 1, 0), 1.234);
      const result = quatMul(q, quatConj(q));
      expectQuatClose(result, quatIdentity());
    });
  });

  describe('quatNormalize', () => {
    it('produces unit quaternion', () => {
      const q = quatNormalize({ x: 3, y: 4, z: 0, w: 0 });
      expect(Math.hypot(q.x, q.y, q.z, q.w)).toBeCloseTo(1, 12);
    });
    it('zero quat returns identity', () => {
      const q = quatNormalize({ x: 0, y: 0, z: 0, w: 0 });
      expectQuatClose(q, quatIdentity());
    });
  });

  describe('quatFromAxisAngle', () => {
    it('axis-angle round-trip via rotation', () => {
      const axis = v3(0, 0, 1);
      const q = quatFromAxisAngle(axis, Math.PI / 2);
      // 旋轉 (1,0,0) 90° 繞 Z 應得 (0,1,0)
      const v = quatRotateVec(q, v3(1, 0, 0));
      expect(v.x).toBeCloseTo(0, 9);
      expect(v.y).toBeCloseTo(1, 9);
      expect(v.z).toBeCloseTo(0, 9);
    });
  });

  describe('quatFromUnitVectors', () => {
    it('round-trip: rotate from to should yield to', () => {
      const cases = [
        [v3(1, 0, 0), v3(0, 1, 0)],
        [v3(1, 0, 0), v3(0, 0, 1)],
        [v3(0, 1, 0), v3(0, 0, 1)],
        [v3(1, 1, 0), v3(0, 1, 1)],
      ];
      for (const [from, to] of cases) {
        const fromN = {
          x: from.x / Math.hypot(from.x, from.y, from.z),
          y: from.y / Math.hypot(from.x, from.y, from.z),
          z: from.z / Math.hypot(from.x, from.y, from.z),
        };
        const toN = {
          x: to.x / Math.hypot(to.x, to.y, to.z),
          y: to.y / Math.hypot(to.x, to.y, to.z),
          z: to.z / Math.hypot(to.x, to.y, to.z),
        };
        const q = quatFromUnitVectors(fromN, toN);
        const result = quatRotateVec(q, fromN);
        expect(result.x).toBeCloseTo(toN.x, 9);
        expect(result.y).toBeCloseTo(toN.y, 9);
        expect(result.z).toBeCloseTo(toN.z, 9);
      }
    });

    it('identical vectors return identity', () => {
      const q = quatFromUnitVectors(v3(1, 0, 0), v3(1, 0, 0));
      expectQuatClose(q, quatIdentity());
    });

    it('opposite vectors return 180° rotation', () => {
      const q = quatFromUnitVectors(v3(1, 0, 0), v3(-1, 0, 0));
      const result = quatRotateVec(q, v3(1, 0, 0));
      expect(result.x).toBeCloseTo(-1, 9);
      expect(result.y).toBeCloseTo(0, 9);
      expect(result.z).toBeCloseTo(0, 9);
    });
  });

  describe('quatSlerp', () => {
    const a = quatIdentity();
    const b = quatFromAxisAngle(v3(0, 0, 1), Math.PI / 2);

    it('t=0 returns a', () => {
      expectQuatClose(quatSlerp(a, b, 0), a);
    });
    it('t=1 returns b', () => {
      expectQuatClose(quatSlerp(a, b, 1), b);
    });
    it('t=0.5 returns half rotation', () => {
      const mid = quatSlerp(a, b, 0.5);
      const expected = quatFromAxisAngle(v3(0, 0, 1), Math.PI / 4);
      expectQuatClose(mid, expected);
    });
    it('handles shortest path automatically', () => {
      // -b 與 b 等價，slerp 應走最短路徑
      const negB: Quat = { x: -b.x, y: -b.y, z: -b.z, w: -b.w };
      const mid = quatSlerp(a, negB, 0.5);
      const expected = quatFromAxisAngle(v3(0, 0, 1), Math.PI / 4);
      expectQuatClose(mid, expected);
    });
  });

  describe('quatEnsureShortestPath', () => {
    it('flips when dot < 0', () => {
      const prev = quatIdentity();
      const curr: Quat = { x: 0, y: 0, z: 0, w: -1 }; // 等價於 identity
      const fixed = quatEnsureShortestPath(prev, curr);
      expect(fixed.w).toBe(1);
    });
    it('keeps when dot >= 0', () => {
      const prev = quatIdentity();
      const curr = quatFromAxisAngle(v3(0, 0, 1), 0.1);
      const fixed = quatEnsureShortestPath(prev, curr);
      expect(fixed).toEqual(curr);
    });
  });

  describe('quatRotateVec consistency with quatFromMat3', () => {
    it('quatRotateVec around Z 90° matches matrix rotation', () => {
      const q = quatFromAxisAngle(v3(0, 0, 1), Math.PI / 2);
      // 對應的旋轉矩陣（row-major）：[[0,-1,0],[1,0,0],[0,0,1]]
      const m = [0, -1, 0, 1, 0, 0, 0, 0, 1];
      const qFromMat = quatFromMat3(m);
      expectQuatClose(q, qFromMat);
    });

    it('quatFromMat3 of identity matrix is identity quat', () => {
      const m = [1, 0, 0, 0, 1, 0, 0, 0, 1];
      expectQuatClose(quatFromMat3(m), quatIdentity());
    });

    it('rotated vector via quat matches mat3 quat result', () => {
      const q = quatFromAxisAngle(v3(0, 1, 0), Math.PI / 3);
      const v = v3(1, 0, 0);
      const r1 = quatRotateVec(q, v);
      // 手算 cos(60°)=0.5, sin(60°)≈0.866
      expect(r1.x).toBeCloseTo(0.5, 9);
      expect(r1.y).toBeCloseTo(0, 9);
      expect(r1.z).toBeCloseTo(-Math.sin(Math.PI / 3), 9);
    });
  });
});
