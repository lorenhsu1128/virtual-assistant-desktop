/**
 * 影片動作轉換器 — VRM Humanoid Bone 對應表
 *
 * 定義內容：
 *   1. VRMHumanoidBoneName：VRM 1.0 humanoid 53 根骨骼名稱（**不含 toes**）
 *   2. VRM_BONE_PARENT_CHAIN：每根骨骼從 hips 到自己的祖先鏈（不含自己）
 *   3. A_POSE_REFERENCE_DIR：每根骨骼在「父骨骼局部座標系」的 bind pose
 *      參考方向（單位向量），供 solver 計算 findRotation(REF, localDir)
 *   4. FINGER_CHAINS：HandSolver 用的手指對應（VRM bone ↔ MediaPipe hand
 *      landmark index）
 *
 * **注意**：MVP 不含 leftToes / rightToes（plan 第 0 節決策）。
 *
 * **A_POSE_REFERENCE_DIR 精度**：當前為基於 VRM 1.0 normalized rest
 * pose 的合理初始值。Phase 4 solver 實作後若實測偏差大，會用當前
 * VRM rest pose 反推校正（見 plan 第 8 節 Open Question 2）。
 *
 * 對應計畫：video-converter-plan.md 第 2.3 / 6 節
 */

import type { Vec3 } from '../math/Vector';
import { HAND } from './landmarkTypes';

/**
 * VRM 1.0 humanoid 骨骼名稱（共 53 根，不含 leftToes / rightToes）。
 *
 * 命名與 @pixiv/three-vrm 的 VRMHumanBoneName 完全一致，未來可直接
 * 對接 vrm.humanoid.getNormalizedBoneNode(name)。
 */
export type VRMHumanoidBoneName =
  // 軀幹（6）
  | 'hips'
  | 'spine'
  | 'chest'
  | 'upperChest'
  | 'neck'
  | 'head'
  // 頭部附屬（3）
  | 'leftEye'
  | 'rightEye'
  | 'jaw'
  // 左手臂（4）
  | 'leftShoulder'
  | 'leftUpperArm'
  | 'leftLowerArm'
  | 'leftHand'
  // 右手臂（4）
  | 'rightShoulder'
  | 'rightUpperArm'
  | 'rightLowerArm'
  | 'rightHand'
  // 左腿（3）
  | 'leftUpperLeg'
  | 'leftLowerLeg'
  | 'leftFoot'
  // 右腿（3）
  | 'rightUpperLeg'
  | 'rightLowerLeg'
  | 'rightFoot'
  // 左手指（15）
  | 'leftThumbMetacarpal'
  | 'leftThumbProximal'
  | 'leftThumbDistal'
  | 'leftIndexProximal'
  | 'leftIndexIntermediate'
  | 'leftIndexDistal'
  | 'leftMiddleProximal'
  | 'leftMiddleIntermediate'
  | 'leftMiddleDistal'
  | 'leftRingProximal'
  | 'leftRingIntermediate'
  | 'leftRingDistal'
  | 'leftLittleProximal'
  | 'leftLittleIntermediate'
  | 'leftLittleDistal'
  // 右手指（15）
  | 'rightThumbMetacarpal'
  | 'rightThumbProximal'
  | 'rightThumbDistal'
  | 'rightIndexProximal'
  | 'rightIndexIntermediate'
  | 'rightIndexDistal'
  | 'rightMiddleProximal'
  | 'rightMiddleIntermediate'
  | 'rightMiddleDistal'
  | 'rightRingProximal'
  | 'rightRingIntermediate'
  | 'rightRingDistal'
  | 'rightLittleProximal'
  | 'rightLittleIntermediate'
  | 'rightLittleDistal';

/** 全部 53 根骨骼名稱（陣列形式，順序固定，方便迭代與測試） */
export const ALL_VRM_BONES: readonly VRMHumanoidBoneName[] = [
  'hips',
  'spine',
  'chest',
  'upperChest',
  'neck',
  'head',
  'leftEye',
  'rightEye',
  'jaw',
  'leftShoulder',
  'leftUpperArm',
  'leftLowerArm',
  'leftHand',
  'rightShoulder',
  'rightUpperArm',
  'rightLowerArm',
  'rightHand',
  'leftUpperLeg',
  'leftLowerLeg',
  'leftFoot',
  'rightUpperLeg',
  'rightLowerLeg',
  'rightFoot',
  'leftThumbMetacarpal',
  'leftThumbProximal',
  'leftThumbDistal',
  'leftIndexProximal',
  'leftIndexIntermediate',
  'leftIndexDistal',
  'leftMiddleProximal',
  'leftMiddleIntermediate',
  'leftMiddleDistal',
  'leftRingProximal',
  'leftRingIntermediate',
  'leftRingDistal',
  'leftLittleProximal',
  'leftLittleIntermediate',
  'leftLittleDistal',
  'rightThumbMetacarpal',
  'rightThumbProximal',
  'rightThumbDistal',
  'rightIndexProximal',
  'rightIndexIntermediate',
  'rightIndexDistal',
  'rightMiddleProximal',
  'rightMiddleIntermediate',
  'rightMiddleDistal',
  'rightRingProximal',
  'rightRingIntermediate',
  'rightRingDistal',
  'rightLittleProximal',
  'rightLittleIntermediate',
  'rightLittleDistal',
];

/**
 * 每根骨骼從 hips 到該骨骼父節點的祖先鏈（不含該骨骼自己）。
 *
 * 例：leftUpperArm → ['hips', 'spine', 'chest', 'upperChest', 'leftShoulder']
 * 例：hips → []（root）
 *
 * Solver 用此鏈累積祖先 quaternion 後反向計算 local rotation：
 *   ancestorQ = chain.reduce((q, name) => quatMul(q, solved[name]), I)
 *   localDir  = quatRotateVec(quatConj(ancestorQ), worldDir)
 *
 * **注意**：這是「理想化」的 VRM 1.0 鏈。實際模型若缺少 chest /
 * upperChest / shoulder 等可選骨骼，solver 在 Phase 4 會用
 * vrm.humanoid 的實際父節點補洞。
 */
export const VRM_BONE_PARENT_CHAIN: Record<VRMHumanoidBoneName, VRMHumanoidBoneName[]> = {
  // 軀幹
  hips: [],
  spine: ['hips'],
  chest: ['hips', 'spine'],
  upperChest: ['hips', 'spine', 'chest'],
  neck: ['hips', 'spine', 'chest', 'upperChest'],
  head: ['hips', 'spine', 'chest', 'upperChest', 'neck'],
  leftEye: ['hips', 'spine', 'chest', 'upperChest', 'neck', 'head'],
  rightEye: ['hips', 'spine', 'chest', 'upperChest', 'neck', 'head'],
  jaw: ['hips', 'spine', 'chest', 'upperChest', 'neck', 'head'],

  // 左手臂
  leftShoulder: ['hips', 'spine', 'chest', 'upperChest'],
  leftUpperArm: ['hips', 'spine', 'chest', 'upperChest', 'leftShoulder'],
  leftLowerArm: ['hips', 'spine', 'chest', 'upperChest', 'leftShoulder', 'leftUpperArm'],
  leftHand: ['hips', 'spine', 'chest', 'upperChest', 'leftShoulder', 'leftUpperArm', 'leftLowerArm'],

  // 右手臂
  rightShoulder: ['hips', 'spine', 'chest', 'upperChest'],
  rightUpperArm: ['hips', 'spine', 'chest', 'upperChest', 'rightShoulder'],
  rightLowerArm: ['hips', 'spine', 'chest', 'upperChest', 'rightShoulder', 'rightUpperArm'],
  rightHand: ['hips', 'spine', 'chest', 'upperChest', 'rightShoulder', 'rightUpperArm', 'rightLowerArm'],

  // 左腿
  leftUpperLeg: ['hips'],
  leftLowerLeg: ['hips', 'leftUpperLeg'],
  leftFoot: ['hips', 'leftUpperLeg', 'leftLowerLeg'],

  // 右腿
  rightUpperLeg: ['hips'],
  rightLowerLeg: ['hips', 'rightUpperLeg'],
  rightFoot: ['hips', 'rightUpperLeg', 'rightLowerLeg'],

  // 左手指（共用 leftHand 之前的鏈再加上 leftHand）
  leftThumbMetacarpal: [
    'hips', 'spine', 'chest', 'upperChest', 'leftShoulder', 'leftUpperArm', 'leftLowerArm', 'leftHand',
  ],
  leftThumbProximal: [
    'hips', 'spine', 'chest', 'upperChest', 'leftShoulder', 'leftUpperArm', 'leftLowerArm', 'leftHand', 'leftThumbMetacarpal',
  ],
  leftThumbDistal: [
    'hips', 'spine', 'chest', 'upperChest', 'leftShoulder', 'leftUpperArm', 'leftLowerArm', 'leftHand', 'leftThumbMetacarpal', 'leftThumbProximal',
  ],
  leftIndexProximal: [
    'hips', 'spine', 'chest', 'upperChest', 'leftShoulder', 'leftUpperArm', 'leftLowerArm', 'leftHand',
  ],
  leftIndexIntermediate: [
    'hips', 'spine', 'chest', 'upperChest', 'leftShoulder', 'leftUpperArm', 'leftLowerArm', 'leftHand', 'leftIndexProximal',
  ],
  leftIndexDistal: [
    'hips', 'spine', 'chest', 'upperChest', 'leftShoulder', 'leftUpperArm', 'leftLowerArm', 'leftHand', 'leftIndexProximal', 'leftIndexIntermediate',
  ],
  leftMiddleProximal: [
    'hips', 'spine', 'chest', 'upperChest', 'leftShoulder', 'leftUpperArm', 'leftLowerArm', 'leftHand',
  ],
  leftMiddleIntermediate: [
    'hips', 'spine', 'chest', 'upperChest', 'leftShoulder', 'leftUpperArm', 'leftLowerArm', 'leftHand', 'leftMiddleProximal',
  ],
  leftMiddleDistal: [
    'hips', 'spine', 'chest', 'upperChest', 'leftShoulder', 'leftUpperArm', 'leftLowerArm', 'leftHand', 'leftMiddleProximal', 'leftMiddleIntermediate',
  ],
  leftRingProximal: [
    'hips', 'spine', 'chest', 'upperChest', 'leftShoulder', 'leftUpperArm', 'leftLowerArm', 'leftHand',
  ],
  leftRingIntermediate: [
    'hips', 'spine', 'chest', 'upperChest', 'leftShoulder', 'leftUpperArm', 'leftLowerArm', 'leftHand', 'leftRingProximal',
  ],
  leftRingDistal: [
    'hips', 'spine', 'chest', 'upperChest', 'leftShoulder', 'leftUpperArm', 'leftLowerArm', 'leftHand', 'leftRingProximal', 'leftRingIntermediate',
  ],
  leftLittleProximal: [
    'hips', 'spine', 'chest', 'upperChest', 'leftShoulder', 'leftUpperArm', 'leftLowerArm', 'leftHand',
  ],
  leftLittleIntermediate: [
    'hips', 'spine', 'chest', 'upperChest', 'leftShoulder', 'leftUpperArm', 'leftLowerArm', 'leftHand', 'leftLittleProximal',
  ],
  leftLittleDistal: [
    'hips', 'spine', 'chest', 'upperChest', 'leftShoulder', 'leftUpperArm', 'leftLowerArm', 'leftHand', 'leftLittleProximal', 'leftLittleIntermediate',
  ],

  // 右手指
  rightThumbMetacarpal: [
    'hips', 'spine', 'chest', 'upperChest', 'rightShoulder', 'rightUpperArm', 'rightLowerArm', 'rightHand',
  ],
  rightThumbProximal: [
    'hips', 'spine', 'chest', 'upperChest', 'rightShoulder', 'rightUpperArm', 'rightLowerArm', 'rightHand', 'rightThumbMetacarpal',
  ],
  rightThumbDistal: [
    'hips', 'spine', 'chest', 'upperChest', 'rightShoulder', 'rightUpperArm', 'rightLowerArm', 'rightHand', 'rightThumbMetacarpal', 'rightThumbProximal',
  ],
  rightIndexProximal: [
    'hips', 'spine', 'chest', 'upperChest', 'rightShoulder', 'rightUpperArm', 'rightLowerArm', 'rightHand',
  ],
  rightIndexIntermediate: [
    'hips', 'spine', 'chest', 'upperChest', 'rightShoulder', 'rightUpperArm', 'rightLowerArm', 'rightHand', 'rightIndexProximal',
  ],
  rightIndexDistal: [
    'hips', 'spine', 'chest', 'upperChest', 'rightShoulder', 'rightUpperArm', 'rightLowerArm', 'rightHand', 'rightIndexProximal', 'rightIndexIntermediate',
  ],
  rightMiddleProximal: [
    'hips', 'spine', 'chest', 'upperChest', 'rightShoulder', 'rightUpperArm', 'rightLowerArm', 'rightHand',
  ],
  rightMiddleIntermediate: [
    'hips', 'spine', 'chest', 'upperChest', 'rightShoulder', 'rightUpperArm', 'rightLowerArm', 'rightHand', 'rightMiddleProximal',
  ],
  rightMiddleDistal: [
    'hips', 'spine', 'chest', 'upperChest', 'rightShoulder', 'rightUpperArm', 'rightLowerArm', 'rightHand', 'rightMiddleProximal', 'rightMiddleIntermediate',
  ],
  rightRingProximal: [
    'hips', 'spine', 'chest', 'upperChest', 'rightShoulder', 'rightUpperArm', 'rightLowerArm', 'rightHand',
  ],
  rightRingIntermediate: [
    'hips', 'spine', 'chest', 'upperChest', 'rightShoulder', 'rightUpperArm', 'rightLowerArm', 'rightHand', 'rightRingProximal',
  ],
  rightRingDistal: [
    'hips', 'spine', 'chest', 'upperChest', 'rightShoulder', 'rightUpperArm', 'rightLowerArm', 'rightHand', 'rightRingProximal', 'rightRingIntermediate',
  ],
  rightLittleProximal: [
    'hips', 'spine', 'chest', 'upperChest', 'rightShoulder', 'rightUpperArm', 'rightLowerArm', 'rightHand',
  ],
  rightLittleIntermediate: [
    'hips', 'spine', 'chest', 'upperChest', 'rightShoulder', 'rightUpperArm', 'rightLowerArm', 'rightHand', 'rightLittleProximal',
  ],
  rightLittleDistal: [
    'hips', 'spine', 'chest', 'upperChest', 'rightShoulder', 'rightUpperArm', 'rightLowerArm', 'rightHand', 'rightLittleProximal', 'rightLittleIntermediate',
  ],
};

/**
 * 每根骨骼在「父骨骼局部座標系」的 bind pose 參考方向（單位向量）。
 *
 * Phase 4 solver 用法：
 *   localDir = quatRotateVec(quatConj(ancestorQ), worldDirFromLandmarks)
 *   bone.q   = quatFromUnitVectors(A_POSE_REFERENCE_DIR[bone], localDir)
 *
 * 當前數值為 VRM 1.0 normalized rest pose 的合理近似（vertical chain 沿
 * 父 +Y、shoulders ±X、四肢與手指沿父 -Y、腳沿 +Z）。Phase 4 實測偏差
 * 大時會反推校正。
 */
const Y_UP: Vec3 = { x: 0, y: 1, z: 0 };
const Y_DOWN: Vec3 = { x: 0, y: -1, z: 0 };
const X_LEFT: Vec3 = { x: -1, y: 0, z: 0 };
const X_RIGHT: Vec3 = { x: 1, y: 0, z: 0 };
const Z_FORWARD: Vec3 = { x: 0, y: 0, z: 1 };
const Z_BACKWARD: Vec3 = { x: 0, y: 0, z: -1 };

export const A_POSE_REFERENCE_DIR: Record<VRMHumanoidBoneName, Vec3> = {
  // 軀幹：垂直向上鏈
  hips: { ...Y_UP },
  spine: { ...Y_UP },
  chest: { ...Y_UP },
  upperChest: { ...Y_UP },
  // neck：BodySolver 用 (NOSE - shoulderMid) 當 world 方向，rest 時為 +Y
  neck: { ...Y_UP },
  // head：BodySolver 用 (earMid - NOSE) 當 world 方向，rest 時為 -Z
  // （耳朵在鼻子正後方）
  head: { ...Z_BACKWARD },

  // 頭部附屬
  leftEye: { ...Z_FORWARD },
  rightEye: { ...Z_FORWARD },
  jaw: { ...Y_DOWN },

  // 肩膀（在 upperChest 局部空間左右展開）
  leftShoulder: { ...X_LEFT },
  rightShoulder: { ...X_RIGHT },

  // 手臂（在父骨骼局部空間沿 -Y 延伸）
  leftUpperArm: { ...Y_DOWN },
  leftLowerArm: { ...Y_DOWN },
  leftHand: { ...Y_DOWN },
  rightUpperArm: { ...Y_DOWN },
  rightLowerArm: { ...Y_DOWN },
  rightHand: { ...Y_DOWN },

  // 腿（沿父 -Y 向下）
  leftUpperLeg: { ...Y_DOWN },
  leftLowerLeg: { ...Y_DOWN },
  rightUpperLeg: { ...Y_DOWN },
  rightLowerLeg: { ...Y_DOWN },

  // 腳掌（沿父 +Z 向前）
  leftFoot: { ...Z_FORWARD },
  rightFoot: { ...Z_FORWARD },

  // 左手指（皆沿父 -Y 延伸）
  leftThumbMetacarpal: { ...Y_DOWN },
  leftThumbProximal: { ...Y_DOWN },
  leftThumbDistal: { ...Y_DOWN },
  leftIndexProximal: { ...Y_DOWN },
  leftIndexIntermediate: { ...Y_DOWN },
  leftIndexDistal: { ...Y_DOWN },
  leftMiddleProximal: { ...Y_DOWN },
  leftMiddleIntermediate: { ...Y_DOWN },
  leftMiddleDistal: { ...Y_DOWN },
  leftRingProximal: { ...Y_DOWN },
  leftRingIntermediate: { ...Y_DOWN },
  leftRingDistal: { ...Y_DOWN },
  leftLittleProximal: { ...Y_DOWN },
  leftLittleIntermediate: { ...Y_DOWN },
  leftLittleDistal: { ...Y_DOWN },

  // 右手指
  rightThumbMetacarpal: { ...Y_DOWN },
  rightThumbProximal: { ...Y_DOWN },
  rightThumbDistal: { ...Y_DOWN },
  rightIndexProximal: { ...Y_DOWN },
  rightIndexIntermediate: { ...Y_DOWN },
  rightIndexDistal: { ...Y_DOWN },
  rightMiddleProximal: { ...Y_DOWN },
  rightMiddleIntermediate: { ...Y_DOWN },
  rightMiddleDistal: { ...Y_DOWN },
  rightRingProximal: { ...Y_DOWN },
  rightRingIntermediate: { ...Y_DOWN },
  rightRingDistal: { ...Y_DOWN },
  rightLittleProximal: { ...Y_DOWN },
  rightLittleIntermediate: { ...Y_DOWN },
  rightLittleDistal: { ...Y_DOWN },
};

/**
 * 手指鏈：HandSolver 用此對應 VRM 手指骨骼與 MediaPipe hand landmark。
 *
 * landmarkIndices 含 4 個點（從第一節指骨基部到尖端），用於 plan 第 5.3
 * 節的 1 DOF 彎曲角度演算法：
 *
 *   FOR each segment k in [0, 1, 2]:
 *     prev = (k === 0) ? handLm[0] : handLm[indices[k-1]]
 *     curr = handLm[indices[k]]
 *     next = handLm[indices[k+1]]
 *     bend = angleBetween3DCoords(prev, curr, next)
 */
export interface FingerChainEntry {
  side: 'left' | 'right';
  finger: 'thumb' | 'index' | 'middle' | 'ring' | 'little';
  /** VRM 骨骼鏈（從根節到末節，固定 3 根） */
  bones: [VRMHumanoidBoneName, VRMHumanoidBoneName, VRMHumanoidBoneName];
  /** Hand landmark 索引（4 點，從基部到尖端） */
  landmarkIndices: [number, number, number, number];
}

export const FINGER_CHAINS: readonly FingerChainEntry[] = [
  // ── 左手 ──
  {
    side: 'left',
    finger: 'thumb',
    bones: ['leftThumbMetacarpal', 'leftThumbProximal', 'leftThumbDistal'],
    landmarkIndices: [HAND.THUMB_CMC, HAND.THUMB_MCP, HAND.THUMB_IP, HAND.THUMB_TIP],
  },
  {
    side: 'left',
    finger: 'index',
    bones: ['leftIndexProximal', 'leftIndexIntermediate', 'leftIndexDistal'],
    landmarkIndices: [HAND.INDEX_MCP, HAND.INDEX_PIP, HAND.INDEX_DIP, HAND.INDEX_TIP],
  },
  {
    side: 'left',
    finger: 'middle',
    bones: ['leftMiddleProximal', 'leftMiddleIntermediate', 'leftMiddleDistal'],
    landmarkIndices: [HAND.MIDDLE_MCP, HAND.MIDDLE_PIP, HAND.MIDDLE_DIP, HAND.MIDDLE_TIP],
  },
  {
    side: 'left',
    finger: 'ring',
    bones: ['leftRingProximal', 'leftRingIntermediate', 'leftRingDistal'],
    landmarkIndices: [HAND.RING_MCP, HAND.RING_PIP, HAND.RING_DIP, HAND.RING_TIP],
  },
  {
    side: 'left',
    finger: 'little',
    bones: ['leftLittleProximal', 'leftLittleIntermediate', 'leftLittleDistal'],
    landmarkIndices: [HAND.PINKY_MCP, HAND.PINKY_PIP, HAND.PINKY_DIP, HAND.PINKY_TIP],
  },

  // ── 右手 ──
  {
    side: 'right',
    finger: 'thumb',
    bones: ['rightThumbMetacarpal', 'rightThumbProximal', 'rightThumbDistal'],
    landmarkIndices: [HAND.THUMB_CMC, HAND.THUMB_MCP, HAND.THUMB_IP, HAND.THUMB_TIP],
  },
  {
    side: 'right',
    finger: 'index',
    bones: ['rightIndexProximal', 'rightIndexIntermediate', 'rightIndexDistal'],
    landmarkIndices: [HAND.INDEX_MCP, HAND.INDEX_PIP, HAND.INDEX_DIP, HAND.INDEX_TIP],
  },
  {
    side: 'right',
    finger: 'middle',
    bones: ['rightMiddleProximal', 'rightMiddleIntermediate', 'rightMiddleDistal'],
    landmarkIndices: [HAND.MIDDLE_MCP, HAND.MIDDLE_PIP, HAND.MIDDLE_DIP, HAND.MIDDLE_TIP],
  },
  {
    side: 'right',
    finger: 'ring',
    bones: ['rightRingProximal', 'rightRingIntermediate', 'rightRingDistal'],
    landmarkIndices: [HAND.RING_MCP, HAND.RING_PIP, HAND.RING_DIP, HAND.RING_TIP],
  },
  {
    side: 'right',
    finger: 'little',
    bones: ['rightLittleProximal', 'rightLittleIntermediate', 'rightLittleDistal'],
    landmarkIndices: [HAND.PINKY_MCP, HAND.PINKY_PIP, HAND.PINKY_DIP, HAND.PINKY_TIP],
  },
];
