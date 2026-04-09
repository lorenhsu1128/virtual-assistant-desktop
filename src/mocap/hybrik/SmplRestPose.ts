/**
 * SMPL neutral rest pose 常數（Phase 5b HybrIK-TS）
 *
 * 提供 24 個 SMPL joint 在 neutral rest pose（T-pose）下的全域 3D 座標，
 * 以及由此推導的 parent→child 骨骼方向與骨骼長度。
 *
 * 座標慣例：
 *   - Y 軸向上（up）
 *   - X 軸指向角色左側（subject-left；面對角色時為觀察者右側）
 *   - Z 軸指向角色前方（subject-forward，離開身體方向）
 *   - 原點為骨盆（pelvis）所在位置
 *   - 單位：公尺
 *
 * 數值來自 SMPL neutral mean-shape（β = 0）的近似公開資料，誤差約 ±1cm。
 * 用途是提供 bone 方向的「rest frame」；IK solver 只依賴相對方向與相對長度，
 * 絕對座標的精確性對結果影響有限。
 *
 * 此檔為純資料模組，無函式邏輯、無 runtime 依賴。
 */

import { SMPL_JOINT_COUNT } from '../smpl/SmplSkeleton';

/** 單一 3D 點（純資料） */
export interface RestJoint {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

/**
 * SMPL 24 joint 的 neutral rest pose 全域座標
 *
 * 索引順序對應 `SMPL_JOINT_NAMES`。
 */
export const SMPL_REST_POSITIONS: readonly RestJoint[] = [
  { x: 0.000, y: 0.000, z: 0.000 },   // 0  pelvis
  { x: 0.080, y: -0.080, z: 0.000 },  // 1  leftHip
  { x: -0.080, y: -0.080, z: 0.000 }, // 2  rightHip
  { x: 0.000, y: 0.120, z: 0.000 },   // 3  spine1
  { x: 0.080, y: -0.500, z: 0.000 },  // 4  leftKnee
  { x: -0.080, y: -0.500, z: 0.000 }, // 5  rightKnee
  { x: 0.000, y: 0.240, z: 0.000 },   // 6  spine2
  { x: 0.080, y: -0.930, z: 0.000 },  // 7  leftAnkle
  { x: -0.080, y: -0.930, z: 0.000 }, // 8  rightAnkle
  { x: 0.000, y: 0.360, z: 0.000 },   // 9  spine3
  { x: 0.080, y: -0.980, z: 0.150 },  // 10 leftFoot (toes)
  { x: -0.080, y: -0.980, z: 0.150 }, // 11 rightFoot (toes)
  { x: 0.000, y: 0.480, z: 0.000 },   // 12 neck
  { x: 0.070, y: 0.440, z: 0.000 },   // 13 leftCollar
  { x: -0.070, y: 0.440, z: 0.000 },  // 14 rightCollar
  { x: 0.000, y: 0.580, z: 0.000 },   // 15 head
  { x: 0.170, y: 0.450, z: 0.000 },   // 16 leftShoulder (SMPL: upper arm root)
  { x: -0.170, y: 0.450, z: 0.000 },  // 17 rightShoulder
  { x: 0.440, y: 0.450, z: 0.000 },   // 18 leftElbow
  { x: -0.440, y: 0.450, z: 0.000 },  // 19 rightElbow
  { x: 0.700, y: 0.450, z: 0.000 },   // 20 leftWrist
  { x: -0.700, y: 0.450, z: 0.000 },  // 21 rightWrist
  { x: 0.780, y: 0.450, z: 0.000 },   // 22 leftHand (fingers root)
  { x: -0.780, y: 0.450, z: 0.000 },  // 23 rightHand
];

if (SMPL_REST_POSITIONS.length !== SMPL_JOINT_COUNT) {
  throw new Error(
    `[SmplRestPose] 長度不符：expected ${SMPL_JOINT_COUNT}, got ${SMPL_REST_POSITIONS.length}`,
  );
}

/**
 * 每個 joint 的 primary child（用於 IK swing 計算）
 *
 * 選取規則：
 *   - 若 joint 只有一個子節點 → 該子節點
 *   - 若有多個子節點 → 選「中軸線上」的主要延伸（例如 pelvis 選 spine1、
 *     spine3 選 neck），避免 IK 解出的軀幹朝向偏向手臂側
 *   - 葉節點（無子節點） → null，該 joint 的 local rotation 保持 identity
 *
 * 索引對應 `SMPL_JOINT_NAMES`。
 */
export const SMPL_PRIMARY_CHILD: readonly (number | null)[] = [
  3,  // 0  pelvis    → spine1
  4,  // 1  leftHip   → leftKnee
  5,  // 2  rightHip  → rightKnee
  6,  // 3  spine1    → spine2
  7,  // 4  leftKnee  → leftAnkle
  8,  // 5  rightKnee → rightAnkle
  9,  // 6  spine2    → spine3
  10, // 7  leftAnkle → leftFoot
  11, // 8  rightAnkle→ rightFoot
  12, // 9  spine3    → neck (選中軸延伸，避免軀幹朝向偏斜)
  null, // 10 leftFoot (toes) — leaf
  null, // 11 rightFoot — leaf
  15, // 12 neck → head
  16, // 13 leftCollar  → leftShoulder
  17, // 14 rightCollar → rightShoulder
  null, // 15 head — leaf
  18, // 16 leftShoulder  → leftElbow
  19, // 17 rightShoulder → rightElbow
  20, // 18 leftElbow  → leftWrist
  21, // 19 rightElbow → rightWrist
  22, // 20 leftWrist  → leftHand
  23, // 21 rightWrist → rightHand
  null, // 22 leftHand — leaf
  null, // 23 rightHand — leaf
];

/**
 * 部分多子節點 joint 的 secondary child（用於 two-axis 旋轉擬合）
 *
 * 有 secondary 的 joint 會用「primary + secondary」兩組方向對來擬合完整
 * 3x3 rotation matrix，解決單軸 swing 無法決定 twist 的問題。
 *
 * 對於只有單一 primary 且沒有 secondary 的 joint，退化為 swingFromTo。
 */
export const SMPL_SECONDARY_CHILD: Readonly<Record<number, number>> = {
  0: 1,  // pelvis  → leftHip（提供髖線 x 方向，決定軀幹面向）
  9: 13, // spine3  → leftCollar（提供肩線 x 方向，決定肩膀扭轉）
};

/**
 * Rest pose 下每個 joint 相對於 parent 的 bone offset（公尺）
 *
 * `SMPL_REST_BONE_OFFSETS[i] = SMPL_REST_POSITIONS[i] - SMPL_REST_POSITIONS[parent[i]]`
 * Root pelvis (i=0) 為 (0, 0, 0)。
 */
export const SMPL_REST_BONE_OFFSETS: readonly RestJoint[] = (() => {
  const parent = [
    -1, 0, 0, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 9, 9, 12, 13, 14, 16, 17, 18, 19, 20, 21,
  ];
  const out: RestJoint[] = new Array(SMPL_JOINT_COUNT);
  for (let i = 0; i < SMPL_JOINT_COUNT; i++) {
    if (parent[i] < 0) {
      out[i] = { x: 0, y: 0, z: 0 };
    } else {
      const me = SMPL_REST_POSITIONS[i];
      const pa = SMPL_REST_POSITIONS[parent[i]];
      out[i] = { x: me.x - pa.x, y: me.y - pa.y, z: me.z - pa.z };
    }
  }
  return out;
})();

/**
 * Rest pose 下每個 joint 到 parent 的骨骼長度（公尺）
 *
 * IK 求解時骨骼長度由此表保持，與 target 距離可能不符（尤其 MediaPipe 噪音大時）。
 */
export const SMPL_REST_BONE_LENGTHS: readonly number[] = SMPL_REST_BONE_OFFSETS.map(
  (o) => Math.sqrt(o.x * o.x + o.y * o.y + o.z * o.z),
);
