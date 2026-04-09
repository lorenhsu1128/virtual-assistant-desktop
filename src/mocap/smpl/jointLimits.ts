/**
 * SMPL joint 空間的 axis-angle 限制表
 *
 * 用途：在 applyClamp 階段對 SmplTrack 的每幀旋轉做硬性限制，
 *       過濾掉 MediaPipe / MoCap 雜訊造成的不合理旋轉。
 *
 * Phase 5c 策略（溫和收緊）：
 *   - 預設值從 Phase 2a 的「全部 [-π, π]」收緊為 per-joint 解剖學近似
 *   - 對相對穩定的 joint（脊椎、頸、腳趾、手指根）收緊，避免雜訊
 *   - 對大範圍關節（髖、肩、肘、膝、踝、pelvis）維持寬鬆，因為：
 *     1. axis-angle per-component clamp 是近似，過緊會裁掉正確姿態
 *     2. 肘/膝的「單向屈曲」限制需要 axis-aware 約束，per-axis 無法表達
 *     3. HybrIK solver 本身輸出的 rotation 由 target 位置決定，
 *        合理姿態天然落在解剖範圍內；clamp 主要在「防雜訊炸裂」
 *
 * 未來 Phase 6+ 升級空間：
 *   - 改用「最大 angle magnitude」約束（clamp 整個 axis-angle 向量長度）
 *   - 引入 HybrIK 論文的 per-joint analytical constraints（需 axis-aware）
 *   - 依據 β (SMPL betas) 做個體化限制
 */

import { SMPL_JOINT_COUNT } from './SmplSkeleton';

/** 單 joint 的三軸限制（min, max 以弧度表示） */
export interface AxisLimits {
  x: readonly [number, number];
  y: readonly [number, number];
  z: readonly [number, number];
}

/** 最寬鬆的限制：[-π, π] per axis（等同於「完全不 clamp」） */
export const WIDE_LIMIT: AxisLimits = {
  x: [-Math.PI, Math.PI],
  y: [-Math.PI, Math.PI],
  z: [-Math.PI, Math.PI],
};

/** 工具：產生對稱限制 ±bound */
function sym(bound: number): AxisLimits {
  return { x: [-bound, bound], y: [-bound, bound], z: [-bound, bound] };
}

// ── 常用限制範圍 ──
const TIGHT_TORSO = sym(Math.PI / 3); // ±60°，適用脊椎 / 頸 / collar / hand
const TIGHT_HEAD = sym(Math.PI / 4); // ±45°，head / finger base
const LOOSE_ANKLE = sym(Math.PI / 2); // ±90°，踝關節
const TIGHT_TOES = sym(Math.PI / 6); // ±30°，腳趾幾乎靜態

/**
 * 24 joint 的 axis-angle 限制（Phase 5c 版）
 *
 * 索引對應 `SMPL_JOINT_NAMES`。
 */
export const SMPL_JOINT_AXIS_LIMITS: readonly AxisLimits[] = [
  WIDE_LIMIT,   // 0  pelvis（根，全域朝向）
  WIDE_LIMIT,   // 1  leftHip
  WIDE_LIMIT,   // 2  rightHip
  TIGHT_TORSO,  // 3  spine1
  WIDE_LIMIT,   // 4  leftKnee（單向屈曲需 axis-aware，per-axis 不裁）
  WIDE_LIMIT,   // 5  rightKnee
  TIGHT_TORSO,  // 6  spine2
  LOOSE_ANKLE,  // 7  leftAnkle
  LOOSE_ANKLE,  // 8  rightAnkle
  TIGHT_TORSO,  // 9  spine3
  TIGHT_TOES,   // 10 leftFoot (toes)
  TIGHT_TOES,   // 11 rightFoot
  TIGHT_TORSO,  // 12 neck
  TIGHT_TORSO,  // 13 leftCollar
  TIGHT_TORSO,  // 14 rightCollar
  TIGHT_HEAD,   // 15 head
  WIDE_LIMIT,   // 16 leftShoulder (SMPL: upper arm root)
  WIDE_LIMIT,   // 17 rightShoulder
  WIDE_LIMIT,   // 18 leftElbow（單向屈曲需 axis-aware）
  WIDE_LIMIT,   // 19 rightElbow
  LOOSE_ANKLE,  // 20 leftWrist
  LOOSE_ANKLE,  // 21 rightWrist
  TIGHT_HEAD,   // 22 leftHand (fingers base)
  TIGHT_HEAD,   // 23 rightHand
];

if (SMPL_JOINT_AXIS_LIMITS.length !== SMPL_JOINT_COUNT) {
  throw new Error(
    `[jointLimits] 長度不符：expected ${SMPL_JOINT_COUNT}, got ${SMPL_JOINT_AXIS_LIMITS.length}`,
  );
}
