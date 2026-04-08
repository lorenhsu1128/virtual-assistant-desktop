/**
 * 影片動作轉換器 — Quaternion 數學工具（純函式，零依賴）
 *
 * 慣例：
 *   - Quat 為單位四元數 { x, y, z, w }，xyz 為向量部、w 為純量部
 *   - 右手座標系
 *   - 旋轉作用：v' = q * v * q*（透過 quatRotateVec 實作）
 *
 * 對應計畫：video-converter-plan.md 第 2.4 節
 */

import type { Vec3 } from './Vector';

export interface Quat {
  x: number;
  y: number;
  z: number;
  w: number;
}

/** 單位四元數（無旋轉） */
export function quatIdentity(): Quat {
  return { x: 0, y: 0, z: 0, w: 1 };
}

/** 四元數乘法 a * b（先 b 後 a，與旋轉組合一致） */
export function quatMul(a: Quat, b: Quat): Quat {
  return {
    x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
    y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
    z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
    w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z,
  };
}

/** 共軛（單位四元數的共軛即為其反向旋轉） */
export function quatConj(q: Quat): Quat {
  return { x: -q.x, y: -q.y, z: -q.z, w: q.w };
}

/** 內積 */
export function quatDot(a: Quat, b: Quat): number {
  return a.x * b.x + a.y * b.y + a.z * b.z + a.w * b.w;
}

/** 正規化為單位四元數 */
export function quatNormalize(q: Quat): Quat {
  const len = Math.hypot(q.x, q.y, q.z, q.w);
  if (len < 1e-9) return quatIdentity();
  const inv = 1 / len;
  return { x: q.x * inv, y: q.y * inv, z: q.z * inv, w: q.w * inv };
}

/** 從軸角構造四元數，axis 必須為單位向量 */
export function quatFromAxisAngle(axis: Vec3, angle: number): Quat {
  const half = angle * 0.5;
  const s = Math.sin(half);
  return {
    x: axis.x * s,
    y: axis.y * s,
    z: axis.z * s,
    w: Math.cos(half),
  };
}

/**
 * 將單位向量 from 對齊到單位向量 to 所需的最短旋轉。
 *
 * 兩者反向（dot ≈ -1）時挑一個與 from 正交的軸做 180° 旋轉。
 */
export function quatFromUnitVectors(from: Vec3, to: Vec3): Quat {
  const d = from.x * to.x + from.y * to.y + from.z * to.z;
  if (d > 0.999999) return quatIdentity();
  if (d < -0.999999) {
    // 180°：挑與 from 正交的軸
    let ax = -from.y;
    let ay = from.x;
    let az = 0;
    if (ax * ax + ay * ay < 1e-12) {
      ax = 0;
      ay = -from.z;
      az = from.y;
    }
    const len = Math.hypot(ax, ay, az);
    return { x: ax / len, y: ay / len, z: az / len, w: 0 };
  }
  // 一般情況：half-vector 公式（數值穩定）
  const cx = from.y * to.z - from.z * to.y;
  const cy = from.z * to.x - from.x * to.z;
  const cz = from.x * to.y - from.y * to.x;
  const w = 1 + d;
  const len = Math.hypot(cx, cy, cz, w);
  return { x: cx / len, y: cy / len, z: cz / len, w: w / len };
}

/** 用四元數旋轉向量：v' = q * v * q* */
export function quatRotateVec(q: Quat, v: Vec3): Vec3 {
  // 等價於 v + 2 * q.xyz × (q.xyz × v + q.w * v)
  const ix = q.w * v.x + q.y * v.z - q.z * v.y;
  const iy = q.w * v.y + q.z * v.x - q.x * v.z;
  const iz = q.w * v.z + q.x * v.y - q.y * v.x;
  const iw = -q.x * v.x - q.y * v.y - q.z * v.z;
  return {
    x: ix * q.w + iw * -q.x + iy * -q.z - iz * -q.y,
    y: iy * q.w + iw * -q.y + iz * -q.x - ix * -q.z,
    z: iz * q.w + iw * -q.z + ix * -q.y - iy * -q.x,
  };
}

/** Spherical linear interpolation（會自動處理 dot < 0 的最短路徑） */
export function quatSlerp(a: Quat, b: Quat, t: number): Quat {
  let cosTheta = quatDot(a, b);
  let bx = b.x;
  let by = b.y;
  let bz = b.z;
  let bw = b.w;
  if (cosTheta < 0) {
    bx = -bx;
    by = -by;
    bz = -bz;
    bw = -bw;
    cosTheta = -cosTheta;
  }
  // 幾乎共線：用線性內插避免除以接近 0
  if (cosTheta > 0.9995) {
    return quatNormalize({
      x: a.x + (bx - a.x) * t,
      y: a.y + (by - a.y) * t,
      z: a.z + (bz - a.z) * t,
      w: a.w + (bw - a.w) * t,
    });
  }
  const theta = Math.acos(cosTheta);
  const sinTheta = Math.sin(theta);
  const sa = Math.sin((1 - t) * theta) / sinTheta;
  const sb = Math.sin(t * theta) / sinTheta;
  return {
    x: a.x * sa + bx * sb,
    y: a.y * sa + by * sb,
    z: a.z * sa + bz * sb,
    w: a.w * sa + bw * sb,
  };
}

/**
 * 確保 curr 與 prev 在相同半球（dot ≥ 0），必要時翻號。
 *
 * 用於 GaussianQuatSmoother 與時序追蹤前的預處理：
 * 同一個旋轉的四元數有 q 與 -q 兩種表示，平滑前必須統一半球。
 */
export function quatEnsureShortestPath(prev: Quat, curr: Quat): Quat {
  if (quatDot(prev, curr) < 0) {
    return { x: -curr.x, y: -curr.y, z: -curr.z, w: -curr.w };
  }
  return curr;
}

/**
 * 從 3×3 旋轉矩陣建構四元數（內部用，rollPitchYaw 與 Euler 轉換需要）。
 *
 * 矩陣以列主序傳入：m[0..2] 為第一列，m[3..5] 為第二列，m[6..8] 為第三列。
 * 採用 Shepperd 的數值穩定演算法（挑最大跡的分支）。
 */
export function quatFromMat3(m: number[]): Quat {
  const m00 = m[0];
  const m01 = m[1];
  const m02 = m[2];
  const m10 = m[3];
  const m11 = m[4];
  const m12 = m[5];
  const m20 = m[6];
  const m21 = m[7];
  const m22 = m[8];

  const trace = m00 + m11 + m22;
  if (trace > 0) {
    const s = Math.sqrt(trace + 1.0) * 2; // s = 4w
    return {
      w: 0.25 * s,
      x: (m21 - m12) / s,
      y: (m02 - m20) / s,
      z: (m10 - m01) / s,
    };
  }
  if (m00 > m11 && m00 > m22) {
    const s = Math.sqrt(1.0 + m00 - m11 - m22) * 2; // s = 4x
    return {
      w: (m21 - m12) / s,
      x: 0.25 * s,
      y: (m01 + m10) / s,
      z: (m02 + m20) / s,
    };
  }
  if (m11 > m22) {
    const s = Math.sqrt(1.0 + m11 - m00 - m22) * 2; // s = 4y
    return {
      w: (m02 - m20) / s,
      x: (m01 + m10) / s,
      y: 0.25 * s,
      z: (m12 + m21) / s,
    };
  }
  const s = Math.sqrt(1.0 + m22 - m00 - m11) * 2; // s = 4z
  return {
    w: (m10 - m01) / s,
    x: (m02 + m20) / s,
    y: (m12 + m21) / s,
    z: 0.25 * s,
  };
}
