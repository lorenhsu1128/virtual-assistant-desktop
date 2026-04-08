/**
 * 影片動作轉換器 — 3D 向量數學工具（純函式，零依賴）
 *
 * 對應計畫：video-converter-plan.md 第 2.4 節
 */

import type { Quat } from './Quat';
import { quatFromUnitVectors, quatFromMat3 } from './Quat';

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export function v3(x: number, y: number, z: number): Vec3 {
  return { x, y, z };
}

export function add(a: Vec3, b: Vec3): Vec3 {
  return { x: a.x + b.x, y: a.y + b.y, z: a.z + b.z };
}

export function sub(a: Vec3, b: Vec3): Vec3 {
  return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z };
}

export function scale(a: Vec3, s: number): Vec3 {
  return { x: a.x * s, y: a.y * s, z: a.z * s };
}

export function dot(a: Vec3, b: Vec3): number {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

export function cross(a: Vec3, b: Vec3): Vec3 {
  return {
    x: a.y * b.z - a.z * b.y,
    y: a.z * b.x - a.x * b.z,
    z: a.x * b.y - a.y * b.x,
  };
}

export function length(a: Vec3): number {
  return Math.hypot(a.x, a.y, a.z);
}

export function normalize(a: Vec3): Vec3 {
  const l = length(a);
  if (l < 1e-9) return { x: 0, y: 0, z: 0 };
  return { x: a.x / l, y: a.y / l, z: a.z / l };
}

export function distance(a: Vec3, b: Vec3): number {
  return length(sub(a, b));
}

export function lerpV(a: Vec3, b: Vec3, t: number): Vec3 {
  return {
    x: a.x + (b.x - a.x) * t,
    y: a.y + (b.y - a.y) * t,
    z: a.z + (b.z - a.z) * t,
  };
}

/**
 * 計算把單位向量 from 對齊到單位向量 to 的最短旋轉。
 *
 * 包裝 quatFromUnitVectors，呼叫前自動正規化兩個輸入向量。
 * 用於 BodySolver / HandSolver 把骨骼參考方向旋到實際 landmark 方向。
 */
export function findRotation(from: Vec3, to: Vec3): Quat {
  return quatFromUnitVectors(normalize(from), normalize(to));
}

/**
 * 三點 a-b-c 在頂點 b 處的夾角，回傳值在 [0, π]。
 *
 * 用於 HandSolver 的手指彎曲角度計算（直線 = π，垂直 = π/2）。
 */
export function angleBetween3DCoords(a: Vec3, b: Vec3, c: Vec3): number {
  const ba = normalize(sub(a, b));
  const bc = normalize(sub(c, b));
  const d = ba.x * bc.x + ba.y * bc.y + ba.z * bc.z;
  // 數值保護：clamp 到 [-1, 1] 避免 acos NaN
  const clamped = d < -1 ? -1 : d > 1 ? 1 : d;
  return Math.acos(clamped);
}

/**
 * 從三點構造的局部基底，輸出 XYZ 內在歐拉角。
 *
 * 慣例：
 *   - x 軸 = normalize(b - a)
 *   - z 軸 = normalize(cross(x 軸, c - a)) — 三角形平面外法向
 *   - y 軸 = cross(z, x) — 補成右手系
 *
 * 用於 BodySolver 把肩膀 / 髖骨 / 臉部三角形轉為三軸姿態。
 * 返回值對應該局部基底相對世界座標系的 Euler XYZ。
 *
 * 在標準水平面（a, b, c 共面於 xy 平面、x 軸沿 +x、c 在 +y 側）時，
 * 三個分量都應為 0。
 */
export function rollPitchYaw(
  a: Vec3,
  b: Vec3,
  c: Vec3
): { roll: number; pitch: number; yaw: number } {
  const xAxis = normalize(sub(b, a));
  const inPlane = sub(c, a);
  const zAxis = normalize(cross(xAxis, inPlane));
  const yAxis = cross(zAxis, xAxis);

  // Build column-major rotation matrix and convert to quat → euler.
  // Column-major: [xAxis | yAxis | zAxis]
  // Row-major (the form quatFromMat3 expects): each row is the
  // basis vector's component contribution.
  // 第 i 列、第 j 行 = (xAxis, yAxis, zAxis)[j].(x|y|z)[i]
  const m = [
    xAxis.x, yAxis.x, zAxis.x,
    xAxis.y, yAxis.y, zAxis.y,
    xAxis.z, yAxis.z, zAxis.z,
  ];
  const q = quatFromMat3(m);

  // 直接從 quat 解 Euler XYZ（與 Euler.ts quatToEuler 一致，但避開循環依賴）
  // XYZ 內在順序：roll(z), pitch(y), yaw(x) → 但本函式回傳語意化命名
  const sinp = 2 * (q.w * q.y - q.z * q.x);
  const sinpClamped = sinp < -1 ? -1 : sinp > 1 ? 1 : sinp;
  const pitch = Math.asin(sinpClamped);

  const yaw = Math.atan2(2 * (q.w * q.z + q.x * q.y), 1 - 2 * (q.y * q.y + q.z * q.z));

  const roll = Math.atan2(2 * (q.w * q.x + q.y * q.z), 1 - 2 * (q.x * q.x + q.y * q.y));

  return { roll, pitch, yaw };
}
