/**
 * SMPL 骨架常數
 *
 * 定義 24 個標準 SMPL joint 的名稱、索引順序、parent 關係。
 * 索引順序遵循 SMPL 官方 skinning 規範（本專案用於 EasyMocap / HybrIK 輸出）。
 *
 * 純資料模組，無函式邏輯；被 smplToVrm / jointLimits / applyClamp 共用。
 */

/** SMPL 24 個 joint 的名稱（按標準索引順序） */
export const SMPL_JOINT_NAMES = [
  'pelvis',       // 0  (root)
  'leftHip',      // 1
  'rightHip',     // 2
  'spine1',       // 3
  'leftKnee',     // 4
  'rightKnee',    // 5
  'spine2',       // 6
  'leftAnkle',    // 7
  'rightAnkle',   // 8
  'spine3',       // 9
  'leftFoot',     // 10 (toes)
  'rightFoot',    // 11 (toes)
  'neck',         // 12
  'leftCollar',   // 13
  'rightCollar',  // 14
  'head',         // 15
  'leftShoulder', // 16 (upper arm in SMPL naming)
  'rightShoulder',// 17
  'leftElbow',    // 18 (lower arm)
  'rightElbow',   // 19
  'leftWrist',    // 20
  'rightWrist',   // 21
  'leftHand',     // 22 (fingers root)
  'rightHand',    // 23
] as const;

export type SmplJointName = (typeof SMPL_JOINT_NAMES)[number];

/** SMPL joint 總數 */
export const SMPL_JOINT_COUNT = 24;

/**
 * SMPL parent index 表：`SMPL_PARENT[i]` 為 joint `i` 的 parent index
 *
 * Root pelvis 的 parent 為 `-1`。
 * 遵循 SMPL 官方 kinematic tree。
 */
export const SMPL_PARENT: readonly number[] = [
  -1, // 0  pelvis
  0,  // 1  leftHip
  0,  // 2  rightHip
  0,  // 3  spine1
  1,  // 4  leftKnee
  2,  // 5  rightKnee
  3,  // 6  spine2
  4,  // 7  leftAnkle
  5,  // 8  rightAnkle
  6,  // 9  spine3
  7,  // 10 leftFoot (toes)
  8,  // 11 rightFoot (toes)
  9,  // 12 neck
  9,  // 13 leftCollar
  9,  // 14 rightCollar
  12, // 15 head
  13, // 16 leftShoulder (upper arm)
  14, // 17 rightShoulder
  16, // 18 leftElbow
  17, // 19 rightElbow
  18, // 20 leftWrist
  19, // 21 rightWrist
  20, // 22 leftHand (fingers)
  21, // 23 rightHand
];
