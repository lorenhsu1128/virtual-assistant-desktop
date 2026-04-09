/**
 * SMPL 空間 clamp
 *
 * 對 SmplTrack 或單幀套用 jointLimits，將超範圍的 axis-angle 分量拉回限制邊界。
 * In-place 修改（直接寫回原陣列）。
 *
 * 被呼叫時機：引擎輸出 SmplTrack 後，進入 smplToVrm 之前。
 * 順序：engine → clamp → filter → smplToVrm → MocapFrame
 */

import type { SmplTrack } from '../types';
import { SMPL_JOINT_AXIS_LIMITS, type AxisLimits } from './jointLimits';

/**
 * 對單幀（24 joint × 3 axis）套用限制。In-place 修改。
 *
 * @param frame  單幀 axis-angle 陣列 `[24][3]`
 * @param limits 每 joint 的限制表，長度須 >= frame.length
 */
export function clampSmplFrame(
  frame: number[][],
  limits: readonly AxisLimits[],
): void {
  for (let i = 0; i < frame.length; i++) {
    const aa = frame[i];
    const l = limits[i];
    if (!aa || !l) continue;
    if (aa.length >= 1) aa[0] = clamp(aa[0], l.x[0], l.x[1]);
    if (aa.length >= 2) aa[1] = clamp(aa[1], l.y[0], l.y[1]);
    if (aa.length >= 3) aa[2] = clamp(aa[2], l.z[0], l.z[1]);
  }
}

/**
 * 對整條 SmplTrack 套用限制。In-place 修改。
 *
 * @param track  目標軌道
 * @param limits 可選，預設使用 SMPL_JOINT_AXIS_LIMITS
 */
export function clampSmplTrack(
  track: SmplTrack,
  limits: readonly AxisLimits[] = SMPL_JOINT_AXIS_LIMITS,
): void {
  for (const frame of track.frames) {
    clampSmplFrame(frame, limits);
  }
}

function clamp(v: number, lo: number, hi: number): number {
  if (v < lo) return lo;
  if (v > hi) return hi;
  return v;
}
