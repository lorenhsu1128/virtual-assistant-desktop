import { describe, it, expect } from 'vitest';
import { eulerToQuat, quatToEuler } from '../../../../src/video-converter/math/Euler';
import type { EulerOrder } from '../../../../src/video-converter/math/Euler';
import { quatRotateVec } from '../../../../src/video-converter/math/Quat';
import { v3 } from '../../../../src/video-converter/math/Vector';

describe('Euler', () => {
  describe('eulerToQuat — known cases', () => {
    it('zero euler → identity quat', () => {
      const q = eulerToQuat(0, 0, 0, 'XYZ');
      expect(q.x).toBeCloseTo(0, 12);
      expect(q.y).toBeCloseTo(0, 12);
      expect(q.z).toBeCloseTo(0, 12);
      expect(q.w).toBeCloseTo(1, 12);
    });

    it('90° around X (XYZ): rotates (0,1,0) → (0,0,1)', () => {
      const q = eulerToQuat(Math.PI / 2, 0, 0, 'XYZ');
      const v = quatRotateVec(q, v3(0, 1, 0));
      expect(v.x).toBeCloseTo(0, 9);
      expect(v.y).toBeCloseTo(0, 9);
      expect(v.z).toBeCloseTo(1, 9);
    });

    it('90° around Y (XYZ): rotates (0,0,1) → (1,0,0)', () => {
      const q = eulerToQuat(0, Math.PI / 2, 0, 'XYZ');
      const v = quatRotateVec(q, v3(0, 0, 1));
      expect(v.x).toBeCloseTo(1, 9);
      expect(v.y).toBeCloseTo(0, 9);
      expect(v.z).toBeCloseTo(0, 9);
    });

    it('90° around Z (XYZ): rotates (1,0,0) → (0,1,0)', () => {
      const q = eulerToQuat(0, 0, Math.PI / 2, 'XYZ');
      const v = quatRotateVec(q, v3(1, 0, 0));
      expect(v.x).toBeCloseTo(0, 9);
      expect(v.y).toBeCloseTo(1, 9);
      expect(v.z).toBeCloseTo(0, 9);
    });
  });

  describe('round-trip — non-gimbal regime', () => {
    // 避開 ±π/2 附近的 gimbal lock 區
    const samples: Array<{ x: number; y: number; z: number }> = [
      { x: 0.1, y: 0.2, z: 0.3 },
      { x: -0.5, y: 0.4, z: 0.6 },
      { x: 0.7, y: -0.8, z: 0.2 },
      { x: 1.0, y: 0.5, z: -0.3 },
      { x: -1.2, y: -0.7, z: 0.9 },
    ];

    const orders: EulerOrder[] = ['XYZ', 'YXZ', 'ZXY', 'ZYX', 'YZX', 'XZY'];

    for (const order of orders) {
      describe(`order ${order}`, () => {
        for (const s of samples) {
          it(`(${s.x}, ${s.y}, ${s.z}) round-trips`, () => {
            const q = eulerToQuat(s.x, s.y, s.z, order);
            const e = quatToEuler(q, order);
            expect(e.x).toBeCloseTo(s.x, 6);
            expect(e.y).toBeCloseTo(s.y, 6);
            expect(e.z).toBeCloseTo(s.z, 6);
          });
        }
      });
    }
  });

  describe('round-trip — error budget < 1e-6', () => {
    it('XYZ specific case', () => {
      const x = 0.4321;
      const y = -0.1234;
      const z = 0.8765;
      const q = eulerToQuat(x, y, z, 'XYZ');
      const e = quatToEuler(q, 'XYZ');
      expect(Math.abs(e.x - x)).toBeLessThan(1e-6);
      expect(Math.abs(e.y - y)).toBeLessThan(1e-6);
      expect(Math.abs(e.z - z)).toBeLessThan(1e-6);
    });

    it('ZYX specific case', () => {
      const x = -0.55;
      const y = 0.42;
      const z = -0.77;
      const q = eulerToQuat(x, y, z, 'ZYX');
      const e = quatToEuler(q, 'ZYX');
      expect(Math.abs(e.x - x)).toBeLessThan(1e-6);
      expect(Math.abs(e.y - y)).toBeLessThan(1e-6);
      expect(Math.abs(e.z - z)).toBeLessThan(1e-6);
    });
  });
});
