/**
 * SMPL joint 空間的 axis-angle 限制表
 *
 * 用途：在 applyClamp 階段對 SmplTrack 的每幀旋轉做硬性限制，
 *       過濾掉 MediaPipe / MoCap 雜訊造成的不合理旋轉。
 *
 * 當前狀態（Phase 2a）：**所有 24 joint 使用寬鬆預設 [-π, π]**。
 * 目的僅為建立 pipeline 接線與單元測試，尚未套用任何解剖學約束。
 *
 * Phase 5（HybrIK-TS 移植）時會根據 HybrIK 論文的 per-joint constraints
 * 收緊這張表，加入真正的人體關節限制：
 *   - 膝 / 肘：單向屈曲
 *   - 髖 / 肩：角度範圍
 *   - 脊椎：扭轉限制
 */

import { SMPL_JOINT_COUNT } from './SmplSkeleton';

/** 單 joint 的三軸限制（min, max 以弧度表示） */
export interface AxisLimits {
  x: readonly [number, number];
  y: readonly [number, number];
  z: readonly [number, number];
}

const WIDE_LIMIT: AxisLimits = {
  x: [-Math.PI, Math.PI],
  y: [-Math.PI, Math.PI],
  z: [-Math.PI, Math.PI],
};

/**
 * 24 joint 預設限制（Phase 2a 版）
 *
 * Phase 5 會針對 knee / elbow / hip / shoulder / spine 等加入收緊條件。
 */
export const SMPL_JOINT_AXIS_LIMITS: readonly AxisLimits[] = Array.from(
  { length: SMPL_JOINT_COUNT },
  () => WIDE_LIMIT,
);
