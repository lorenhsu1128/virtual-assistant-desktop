/**
 * SMPL → VRM 轉換（Phase 2a 核心模組）
 *
 * 職責：把單幀 SMPL 24 joint 的 axis-angle 旋轉，轉成 VRM humanoid bone 的
 *       local quaternion，回傳型別為 `Partial<Record<VrmHumanBoneName, Quaternion>>`。
 *
 * 缺失 bone 策略（Q28 決定）：
 *   每個 SMPL joint 有 primary VRM target；若 primary 不存在於模型，
 *   改用 SMPL_FALLBACK_TARGETS 中的備援；若備援也不存在，再沿 SMPL
 *   parent chain 往上找第一個存在的 target。多個 SMPL joint 映射到同一個
 *   VRM bone 時，按 SMPL index 順序四元數累乘，模擬「將多段旋轉合併到一根骨」
 *   的效果。
 *
 * 已知限制（Phase 6 視需要升級）：
 *   - 此版本假設 SMPL 與 VRM 的 rest pose 座標系近似對齊（皆為 T-pose），
 *     直接套用 SMPL 的 local quat 到 VRM bone 的 local rotation。
 *     對 VRM 1.0 模型的 T-pose 近似正確；VRM 0.x 的 A-pose 可能有小偏移。
 *   - 真正精確的轉換需要讀 VRM humanoid rest pose 並做 FK-based remap，
 *     在 Phase 6 評估肉眼效果後再決定是否升級。
 */

import * as THREE from 'three';
import { SMPL_JOINT_COUNT, SMPL_PARENT } from './SmplSkeleton';
import type { VrmHumanBoneName } from '../types';

/**
 * SMPL joint index → VRM humanoid bone 主要對應
 *
 * Index 對應 SMPL joint 順序；`null` 表示該 SMPL joint 無直接對應的 VRM bone
 * （例如 SMPL 的 leftHand/rightHand 是 fingers 根節點，VRM 沒有對應骨）。
 */
export const SMPL_TO_VRM_PRIMARY: readonly (VrmHumanBoneName | null)[] = [
  'hips',          // 0  pelvis
  'leftUpperLeg',  // 1  leftHip
  'rightUpperLeg', // 2  rightHip
  'spine',         // 3  spine1
  'leftLowerLeg',  // 4  leftKnee
  'rightLowerLeg', // 5  rightKnee
  'chest',         // 6  spine2
  'leftFoot',      // 7  leftAnkle
  'rightFoot',     // 8  rightAnkle
  'upperChest',    // 9  spine3   (optional VRM bone)
  'leftToes',      // 10 leftFoot(toes)  (optional)
  'rightToes',     // 11 rightFoot(toes) (optional)
  'neck',          // 12 neck
  'leftShoulder',  // 13 leftCollar  (optional VRM bone)
  'rightShoulder', // 14 rightCollar (optional)
  'head',          // 15 head
  'leftUpperArm',  // 16 leftShoulder (SMPL) = upper arm
  'rightUpperArm', // 17 rightShoulder
  'leftLowerArm',  // 18 leftElbow
  'rightLowerArm', // 19 rightElbow
  'leftHand',      // 20 leftWrist
  'rightHand',     // 21 rightWrist
  null,            // 22 leftHand  (fingers root, no direct VRM bone)
  null,            // 23 rightHand
];

/**
 * 當 primary target 不存在時的明確 fallback 目標
 *
 * 設計原則：
 *   - 序列骨（spine3, toes, hand-tip）→ 往 parent 方向併
 *   - 分支骨（collar）→ 往 child 方向併（保留手臂動作的方向性）
 *
 * 若此表也找不到（或該 fallback 也缺失），會退回「走 SMPL parent chain」的
 * 預設行為（見 buildSmplToVrmMapping）。
 */
export const SMPL_FALLBACK_TARGETS: Readonly<Record<number, VrmHumanBoneName>> = {
  9: 'chest',          // spine3 → chest（序列，往父方向）
  10: 'leftFoot',      // leftToes → leftFoot
  11: 'rightFoot',     // rightToes → rightFoot
  13: 'leftUpperArm',  // leftCollar → leftUpperArm（分支，往子方向保留臂向）
  14: 'rightUpperArm', // rightCollar → rightUpperArm
  22: 'leftHand',      // leftHand(fingers) → leftHand(wrist)
  23: 'rightHand',     // rightHand(fingers) → rightHand
};

/**
 * 解析每個 SMPL joint 最終應套用到哪個 VRM bone
 *
 * 流程（每個 joint）：
 *   1. primary 存在 → 使用
 *   2. 否則，fallback 表中的目標存在 → 使用
 *   3. 否則，沿 SMPL parent chain 往上走，套用每個 ancestor 的 primary/fallback
 *   4. 若全部失敗 → `null`（理論上不會發生，因為 pelvis → hips 是 VRM 必備）
 *
 * @param availableBones 模型實際存在的 VRM humanoid bone 名稱集合
 * @returns 長度為 24 的陣列，每格為該 SMPL joint 最終的 VRM bone，或 null
 */
export function buildSmplToVrmMapping(
  availableBones: ReadonlySet<VrmHumanBoneName>,
): (VrmHumanBoneName | null)[] {
  const resolved: (VrmHumanBoneName | null)[] = new Array(SMPL_JOINT_COUNT).fill(null);

  for (let i = 0; i < SMPL_JOINT_COUNT; i++) {
    resolved[i] = resolveTarget(i, availableBones);
  }

  return resolved;
}

/** 解析單一 SMPL joint 的最終 VRM 目標（遞迴套用 primary → fallback → 父鏈） */
function resolveTarget(
  smplIdx: number,
  availableBones: ReadonlySet<VrmHumanBoneName>,
): VrmHumanBoneName | null {
  const primary = SMPL_TO_VRM_PRIMARY[smplIdx];
  if (primary && availableBones.has(primary)) return primary;

  const fallback = SMPL_FALLBACK_TARGETS[smplIdx];
  if (fallback && availableBones.has(fallback)) return fallback;

  // 沿 SMPL parent chain 往上走
  let parent = SMPL_PARENT[smplIdx];
  while (parent >= 0) {
    const parentPrimary = SMPL_TO_VRM_PRIMARY[parent];
    if (parentPrimary && availableBones.has(parentPrimary)) return parentPrimary;
    const parentFallback = SMPL_FALLBACK_TARGETS[parent];
    if (parentFallback && availableBones.has(parentFallback)) return parentFallback;
    parent = SMPL_PARENT[parent];
  }

  return null;
}

/**
 * 將單幀 SMPL axis-angle 轉成 VRM humanoid bone 的 local quaternion
 *
 * 累乘順序 = SMPL chain 順序（i 單調遞增），所以同一個 VRM bone 的
 * 多個 SMPL joint 會依 pelvis→ext 方向順序相乘。
 *
 * @param smplFrame       單幀，[24][3] axis-angle（弧度）
 * @param resolvedMapping buildSmplToVrmMapping 的結果
 * @returns VRM bone → local quaternion。未被任何 SMPL joint 映射的 bone 不會出現。
 */
export function smplFrameToVrmRotations(
  smplFrame: readonly (readonly number[])[],
  resolvedMapping: readonly (VrmHumanBoneName | null)[],
): Partial<Record<VrmHumanBoneName, THREE.Quaternion>> {
  const buckets = new Map<VrmHumanBoneName, THREE.Quaternion>();
  const tmpQuat = new THREE.Quaternion();

  for (let i = 0; i < SMPL_JOINT_COUNT; i++) {
    const target = resolvedMapping[i];
    if (!target) continue;
    const aa = smplFrame[i];
    if (!aa || aa.length < 3) continue;

    axisAngleToQuaternion(aa[0], aa[1], aa[2], tmpQuat);

    const existing = buckets.get(target);
    if (existing) {
      // 累乘：existing ← existing × tmpQuat（Three.js 語意）
      existing.multiply(tmpQuat);
    } else {
      buckets.set(target, tmpQuat.clone());
    }
  }

  const result: Partial<Record<VrmHumanBoneName, THREE.Quaternion>> = {};
  for (const [name, q] of buckets) {
    result[name] = q;
  }
  return result;
}

/**
 * 將 axis-angle（exponential map）轉為 quaternion，寫入 `out` 並回傳
 *
 * 公式：q = [sin(θ/2) · (ax, ay, az) / θ, cos(θ/2)]，θ = |a|
 * 若 |a| ≈ 0，回傳 identity quaternion（0, 0, 0, 1）。
 */
export function axisAngleToQuaternion(
  ax: number,
  ay: number,
  az: number,
  out: THREE.Quaternion,
): THREE.Quaternion {
  const angle = Math.sqrt(ax * ax + ay * ay + az * az);
  if (angle < 1e-8) {
    out.set(0, 0, 0, 1);
    return out;
  }
  const half = angle * 0.5;
  const s = Math.sin(half) / angle;
  out.set(ax * s, ay * s, az * s, Math.cos(half));
  return out;
}
