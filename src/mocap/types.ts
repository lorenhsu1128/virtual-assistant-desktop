/**
 * 影片動捕模組 — 共用型別定義
 *
 * 純型別檔，無 runtime 依賴。
 * 使用自訂 VrmHumanBoneName string literal union 代替 @pixiv/three-vrm 的
 * VRMHumanBoneName enum，避免型別系統耦合。
 */

import type * as THREE from 'three';

/**
 * VRM humanoid bone 名稱（涵蓋本專案動捕會用到的主要骨骼）
 *
 * 依據 VRM 1.0 規格，分為 required 與 optional：
 *   - required：hips, spine, chest, neck, head, 四肢主要骨骼
 *   - optional：upperChest, leftShoulder, rightShoulder, leftToes, rightToes, 眼睛, jaw
 *
 * 本模組只關心動捕軌道的 24 個 SMPL joint 對應骨骼，
 * 不包含手指（finger）等精細骨骼。
 */
export type VrmHumanBoneName =
  | 'hips'
  | 'spine'
  | 'chest'
  | 'upperChest'
  | 'neck'
  | 'head'
  | 'leftShoulder'
  | 'rightShoulder'
  | 'leftUpperArm'
  | 'rightUpperArm'
  | 'leftLowerArm'
  | 'rightLowerArm'
  | 'leftHand'
  | 'rightHand'
  | 'leftUpperLeg'
  | 'rightUpperLeg'
  | 'leftLowerLeg'
  | 'rightLowerLeg'
  | 'leftFoot'
  | 'rightFoot'
  | 'leftToes'
  | 'rightToes'
  | 'leftEye'
  | 'rightEye'
  | 'jaw';

/**
 * SMPL 動捕軌道
 *
 * Python sidecar（EasyMocap wrapper）回傳的標準格式。
 * HybrIK-TS 引擎（Phase 5）也會產生相同格式。
 *
 * 每幀 24 個 joint 的 axis-angle（exponential map）表示：
 *   frames[f][j] = [ax, ay, az]，其中 |a|=角度（弧度），a/|a|=軸
 */
export interface SmplTrack {
  version: 1;
  /** 取樣 fps（通常 30） */
  fps: number;
  /** frames 陣列長度 */
  frameCount: number;
  /** 每幀 24 個 joint 的 axis-angle，[frameCount][24][3] */
  frames: number[][][];
  /** 每幀根部（pelvis）世界位置 [frameCount][3] */
  trans: number[][];
  /** SMPL 體型參數 β[10]，Phase 2–5 未使用但保留 */
  betas?: number[];
}

/**
 * 下游 pipeline 統一幀格式
 *
 * 由 smplToVrm 轉換後產出；時間軸 scrub 與 VRMA exporter 都吃這個格式。
 * 引擎層的差異（SMPL θ / Kalidokit Euler / 其他）全部在此處被抹平。
 */
export interface MocapFrame {
  /** 時間戳（毫秒，相對於軌道起點） */
  timestampMs: number;
  /** VRM humanoid bone 的 local rotation（在父骨座標系內） */
  boneRotations: Partial<Record<VrmHumanBoneName, THREE.Quaternion>>;
  /** VRM BlendShape 名 → 權重（0–1） */
  blendShapes: Record<string, number>;
  /** 根部（hips）世界座標，相對於軌道起點的 hips 原點；null = 無平移軌道 */
  hipsWorldPosition: { x: number; y: number; z: number } | null;
}
