/**
 * 影片動作轉換器 — 手臂後處理（Kalidokit 風格 Euler 調整）
 *
 * 對應計畫：video-converter-plan.md §5.2 / §14（Kalidokit 倍率未套用）
 *
 * 流派：Kalidokit 的 solveArmRig 回傳 raw Euler 偏小，需要套倍率放大與
 * 生理合理性 clamp。本模組接收 BodySolver 回傳的 raw upperArm / lowerArm
 * 四元數，做 Euler round-trip 後：
 *
 *   1. 倍率：upperArm.z *= -2.3 × invert
 *      （左手 invert = -1，右手 invert = +1；負號來自 Kalidokit 的座標慣例）
 *   2. Clamp：upperArm.x ∈ [-0.5, π]，upperArm.y ∈ [-π/2, π/2]
 *   3. 解剖耦合：upperArm.y += lowerArm.x × 0.5
 *      （二頭肌扭轉跟隨前臂彎曲；lowerArm 實作為 1 DOF Z 軸時 x=0，
 *       此耦合等於 no-op，但保留 API 以符合 plan）
 *
 * 純函式模組，不依賴 Three.js，可獨立測試。
 */

import type { Quat } from '../math/Quat';
import { eulerToQuat, quatToEuler } from '../math/Euler';

/** Kalidokit 倍率常數（plan §5.2） */
const UPPER_ARM_Z_MULTIPLIER = -2.3;

/** upperArm Euler 生理合理性範圍（弧度） */
const UPPER_ARM_X_MIN = -0.5;
const UPPER_ARM_X_MAX = Math.PI;
const UPPER_ARM_Y_MIN = -Math.PI / 2;
const UPPER_ARM_Y_MAX = Math.PI / 2;

/** 解剖耦合係數：upperArm.y += lowerArm.x × 此值 */
const ANATOMICAL_COUPLING = 0.5;

const clamp = (v: number, min: number, max: number): number =>
  v < min ? min : v > max ? max : v;

export interface ArmPostProcessResult {
  upperArm: Quat;
  lowerArm: Quat;
}

/**
 * 套用 Kalidokit 風格的手臂後處理。
 *
 * @param side          左右側（決定 invert 正負）
 * @param upperArmRaw   BodySolver 回傳的 upperArm raw quaternion
 * @param lowerArmRaw   BodySolver 回傳的 lowerArm raw quaternion（1 DOF Z）
 * @returns 處理後的 { upperArm, lowerArm } 四元數
 */
export function applyKalidokitArmAdjust(
  side: 'left' | 'right',
  upperArmRaw: Quat,
  lowerArmRaw: Quat,
): ArmPostProcessResult {
  const invert = side === 'left' ? -1 : 1;

  // 解出 Euler（XYZ 內在順序，符合 plan §5.2）
  const upperEuler = quatToEuler(upperArmRaw, 'XYZ');
  const lowerEuler = quatToEuler(lowerArmRaw, 'XYZ');

  // 1. Z 軸倍率（僅 upperArm）
  let upperZ = upperEuler.z * UPPER_ARM_Z_MULTIPLIER * invert;
  // 2. X / Y 生理範圍 clamp
  const upperX = clamp(upperEuler.x, UPPER_ARM_X_MIN, UPPER_ARM_X_MAX);
  let upperY = clamp(upperEuler.y, UPPER_ARM_Y_MIN, UPPER_ARM_Y_MAX);

  // 3. 解剖耦合：upperArm.y += lowerArm.x × 0.5
  upperY += lowerEuler.x * ANATOMICAL_COUPLING;
  // 耦合後可能超出範圍，再 clamp 一次
  upperY = clamp(upperY, UPPER_ARM_Y_MIN, UPPER_ARM_Y_MAX);

  // Z 也做一次防禦性的範圍 clamp（避免 ×2.3 之後 wrap-around 造成怪姿）
  // 允許 ±2π 的絕對範圍（不過度限制，只防極端值）
  upperZ = clamp(upperZ, -2 * Math.PI, 2 * Math.PI);

  const upperArm = eulerToQuat(upperX, upperY, upperZ, 'XYZ');

  // lowerArm 原樣回傳（BodySolver 已將其建構為 1 DOF Z，此處無需調整）
  return { upperArm, lowerArm: lowerArmRaw };
}
