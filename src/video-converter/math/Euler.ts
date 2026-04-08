/**
 * 影片動作轉換器 — 歐拉角 / 四元數互轉（純函式，零依賴）
 *
 * 慣例：內在旋轉（intrinsic），右手座標系。
 * 支援 6 種旋轉順序，當前主要使用 'XYZ' 與 'ZYX'。
 *
 * 對應計畫：video-converter-plan.md 第 2.4 節
 */

import type { Quat } from './Quat';

export type EulerOrder = 'XYZ' | 'YZX' | 'ZXY' | 'XZY' | 'YXZ' | 'ZYX';

/**
 * 從歐拉角（弧度）建構四元數。
 *
 * 慣例為內在旋轉：order='XYZ' 表示「先繞 X 旋 x 弧度，
 * 接著繞新的 Y 軸旋 y 弧度，最後繞新的 Z 軸旋 z 弧度」。
 */
export function eulerToQuat(x: number, y: number, z: number, order: EulerOrder = 'XYZ'): Quat {
  const c1 = Math.cos(x / 2);
  const c2 = Math.cos(y / 2);
  const c3 = Math.cos(z / 2);
  const s1 = Math.sin(x / 2);
  const s2 = Math.sin(y / 2);
  const s3 = Math.sin(z / 2);

  switch (order) {
    case 'XYZ':
      return {
        x: s1 * c2 * c3 + c1 * s2 * s3,
        y: c1 * s2 * c3 - s1 * c2 * s3,
        z: c1 * c2 * s3 + s1 * s2 * c3,
        w: c1 * c2 * c3 - s1 * s2 * s3,
      };
    case 'YXZ':
      return {
        x: s1 * c2 * c3 + c1 * s2 * s3,
        y: c1 * s2 * c3 - s1 * c2 * s3,
        z: c1 * c2 * s3 - s1 * s2 * c3,
        w: c1 * c2 * c3 + s1 * s2 * s3,
      };
    case 'ZXY':
      return {
        x: s1 * c2 * c3 - c1 * s2 * s3,
        y: c1 * s2 * c3 + s1 * c2 * s3,
        z: c1 * c2 * s3 + s1 * s2 * c3,
        w: c1 * c2 * c3 - s1 * s2 * s3,
      };
    case 'ZYX':
      return {
        x: s1 * c2 * c3 - c1 * s2 * s3,
        y: c1 * s2 * c3 + s1 * c2 * s3,
        z: c1 * c2 * s3 - s1 * s2 * c3,
        w: c1 * c2 * c3 + s1 * s2 * s3,
      };
    case 'YZX':
      return {
        x: s1 * c2 * c3 + c1 * s2 * s3,
        y: c1 * s2 * c3 + s1 * c2 * s3,
        z: c1 * c2 * s3 - s1 * s2 * c3,
        w: c1 * c2 * c3 - s1 * s2 * s3,
      };
    case 'XZY':
      return {
        x: s1 * c2 * c3 - c1 * s2 * s3,
        y: c1 * s2 * c3 - s1 * c2 * s3,
        z: c1 * c2 * s3 + s1 * s2 * c3,
        w: c1 * c2 * c3 + s1 * s2 * s3,
      };
  }
}

/**
 * 從四元數解出歐拉角（弧度）。
 *
 * 在 gimbal lock 附近（pitch ≈ ±π/2）會退化，呼叫端應避免在該區域
 * 仰賴 round-trip 一致性。`solver/` 內部使用時皆控制在非退化區。
 */
export function quatToEuler(
  q: Quat,
  order: EulerOrder = 'XYZ'
): { x: number; y: number; z: number } {
  // 透過旋轉矩陣分量解 Euler，比直接用四元數展開更穩定
  const { x, y, z, w } = q;
  const xx = x * x;
  const yy = y * y;
  const zz = z * z;
  const xy = x * y;
  const xz = x * z;
  const yz = y * z;
  const wx = w * x;
  const wy = w * y;
  const wz = w * z;

  // 3×3 rotation matrix（row-major）
  const m11 = 1 - 2 * (yy + zz);
  const m12 = 2 * (xy - wz);
  const m13 = 2 * (xz + wy);
  const m21 = 2 * (xy + wz);
  const m22 = 1 - 2 * (xx + zz);
  const m23 = 2 * (yz - wx);
  const m31 = 2 * (xz - wy);
  const m32 = 2 * (yz + wx);
  const m33 = 1 - 2 * (xx + yy);

  const clampSin = (v: number): number => (v < -1 ? -1 : v > 1 ? 1 : v);

  switch (order) {
    case 'XYZ': {
      const yEuler = Math.asin(clampSin(m13));
      if (Math.abs(m13) < 0.9999999) {
        return {
          x: Math.atan2(-m23, m33),
          y: yEuler,
          z: Math.atan2(-m12, m11),
        };
      }
      return {
        x: Math.atan2(m32, m22),
        y: yEuler,
        z: 0,
      };
    }
    case 'YXZ': {
      const xEuler = Math.asin(-clampSin(m23));
      if (Math.abs(m23) < 0.9999999) {
        return {
          x: xEuler,
          y: Math.atan2(m13, m33),
          z: Math.atan2(m21, m22),
        };
      }
      return {
        x: xEuler,
        y: Math.atan2(-m31, m11),
        z: 0,
      };
    }
    case 'ZXY': {
      const xEuler = Math.asin(clampSin(m32));
      if (Math.abs(m32) < 0.9999999) {
        return {
          x: xEuler,
          y: Math.atan2(-m31, m33),
          z: Math.atan2(-m12, m22),
        };
      }
      return {
        x: xEuler,
        y: 0,
        z: Math.atan2(m21, m11),
      };
    }
    case 'ZYX': {
      const yEuler = Math.asin(-clampSin(m31));
      if (Math.abs(m31) < 0.9999999) {
        return {
          x: Math.atan2(m32, m33),
          y: yEuler,
          z: Math.atan2(m21, m11),
        };
      }
      return {
        x: 0,
        y: yEuler,
        z: Math.atan2(-m12, m22),
      };
    }
    case 'YZX': {
      const zEuler = Math.asin(clampSin(m21));
      if (Math.abs(m21) < 0.9999999) {
        return {
          x: Math.atan2(-m23, m22),
          y: Math.atan2(-m31, m11),
          z: zEuler,
        };
      }
      return {
        x: 0,
        y: Math.atan2(m13, m33),
        z: zEuler,
      };
    }
    case 'XZY': {
      const zEuler = Math.asin(-clampSin(m12));
      if (Math.abs(m12) < 0.9999999) {
        return {
          x: Math.atan2(m32, m22),
          y: Math.atan2(m13, m11),
          z: zEuler,
        };
      }
      return {
        x: Math.atan2(-m23, m33),
        y: 0,
        z: zEuler,
      };
    }
  }
}
