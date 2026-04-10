/**
 * MediaPipe 33 landmark → SMPL 24 joint 3D 位置映射（Phase 5b HybrIK-TS）
 *
 * 輸入：MediaPipe Pose Landmarker 的 33 個 world landmark（公尺，hip-centered）
 * 輸出：24 個 SMPL joint 的 3D 座標（SMPL 慣例：Y up / +X 角色左側 / +Z 角色前方）
 *
 * 座標系轉換（MediaPipe world → SMPL）：
 *   - MediaPipe Pose Landmarker world（GHUM 模型輸出，hip-centered 公尺）：
 *       x = 主體左側為正（image right，面對鏡頭時）
 *       y = 向下為正（沿用 image 慣例，head 為負 y）
 *       z = 主體前方為正（主體面對方向；**經驗觀察**，官方文件未明確規範）
 *   - SMPL: y 上 / x 主體左側 / z 主體前方
 *   - 因此 smpl = (mp.x, -mp.y, mp.z)
 *
 * Z 軸方向注意：
 *   初版曾依 image-z 慣例假設 z 翻轉（"closer to camera = negative z"），
 *   導致推箱子等前傾動作被解成後仰。2026-04-09 實測後修正為不翻 z。
 *   見 LESSONS.md 對應條目。
 *
 * 33 → 24 對照見 `landmarksToSmplJointPositions` 內的逐 joint 註解。
 *
 * 低 visibility 處理：
 *   - 若任一所需 landmark 的 visibility < MIN_VISIBILITY，該 SMPL joint 以
 *     rest pose 位置（SMPL_REST_POSITIONS）作為 fallback，避免 IK 吃到爛資料
 *
 * 本模組不依賴 DOM / VRM / MediaPipe SDK 型別本身，
 * 僅依賴 `PoseLandmark` 的純結構介面 {x, y, z, visibility}。
 */

import * as THREE from 'three';
import type { PoseLandmark } from '../mediapipe/types';
import { SMPL_JOINT_COUNT } from '../smpl/SmplSkeleton';
import { SMPL_REST_POSITIONS } from './SmplRestPose';

/** 低於此可見度的 landmark 視為不可靠 */
export const MIN_VISIBILITY = 0.3;

/** MediaPipe 33 landmark 索引（常用幾個） */
const MP = {
  NOSE: 0,
  LEFT_EAR: 7,
  RIGHT_EAR: 8,
  LEFT_SHOULDER: 11,
  RIGHT_SHOULDER: 12,
  LEFT_ELBOW: 13,
  RIGHT_ELBOW: 14,
  LEFT_WRIST: 15,
  RIGHT_WRIST: 16,
  LEFT_PINKY: 17,
  RIGHT_PINKY: 18,
  LEFT_INDEX: 19,
  RIGHT_INDEX: 20,
  LEFT_HIP: 23,
  RIGHT_HIP: 24,
  LEFT_KNEE: 25,
  RIGHT_KNEE: 26,
  LEFT_ANKLE: 27,
  RIGHT_ANKLE: 28,
  LEFT_FOOT_INDEX: 31,
  RIGHT_FOOT_INDEX: 32,
} as const;

/**
 * 將 MediaPipe world 座標轉為 SMPL 慣例（Y up）
 *
 * 不做任何尺度修正；假設 MediaPipe 已回傳公尺單位。
 * 只翻 Y（image y-down → SMPL y-up）；X 與 Z 保持原值。
 */
export function mediaPipeWorldToSmpl(lm: PoseLandmark, out: THREE.Vector3): THREE.Vector3 {
  out.set(lm.x, -lm.y, lm.z);
  return out;
}

/** 檢查一組 landmark index 是否全部可見 */
function allVisible(landmarks: readonly PoseLandmark[], indices: readonly number[]): boolean {
  for (const i of indices) {
    const lm = landmarks[i];
    if (!lm || lm.visibility < MIN_VISIBILITY) return false;
  }
  return true;
}

/** 取 rest pose 的 SMPL joint 位置作為 fallback */
function restPosTo(out: THREE.Vector3, smplIdx: number): void {
  const p = SMPL_REST_POSITIONS[smplIdx];
  out.set(p.x, p.y, p.z);
}

/** SMPL 座標 = avg(lm[a], lm[b])（與 mediaPipeWorldToSmpl 同轉換） */
function avgToSmpl(
  out: THREE.Vector3,
  a: PoseLandmark,
  b: PoseLandmark,
): void {
  out.set((a.x + b.x) * 0.5, -(a.y + b.y) * 0.5, (a.z + b.z) * 0.5);
}

/** 線性插值：out = a * (1 - t) + b * t（a, b 為已轉 SMPL 座標系的點） */
function lerpVec(
  out: THREE.Vector3,
  a: THREE.Vector3,
  b: THREE.Vector3,
  t: number,
): void {
  out.set(
    a.x + (b.x - a.x) * t,
    a.y + (b.y - a.y) * t,
    a.z + (b.z - a.z) * t,
  );
}

/**
 * 將 33 個 MediaPipe world landmark 映射為 24 個 SMPL joint 的 3D 位置
 *
 * 輸出為新建的 THREE.Vector3[24]。呼叫頻率高時，考慮改用 pooled 版本。
 *
 * 對 MediaPipe 沒有直接對應的 SMPL joint（脊椎中段、collar 等），
 * 以「pelvis↔neck 線性插值」或「neck↔shoulder 中點」等幾何估計。
 *
 * @param landmarks MediaPipe world landmarks（應為長度 33）
 */
export function landmarksToSmplJointPositions(
  landmarks: readonly PoseLandmark[],
): THREE.Vector3[] {
  const out: THREE.Vector3[] = new Array(SMPL_JOINT_COUNT);
  for (let i = 0; i < SMPL_JOINT_COUNT; i++) out[i] = new THREE.Vector3();

  if (landmarks.length < 33) {
    // 無效輸入 → 全部 rest pose
    for (let i = 0; i < SMPL_JOINT_COUNT; i++) restPosTo(out[i], i);
    return out;
  }

  // ── 基準：骨盆（髖中點）與頸（肩中點） ──
  const lh = landmarks[MP.LEFT_HIP];
  const rh = landmarks[MP.RIGHT_HIP];
  const ls = landmarks[MP.LEFT_SHOULDER];
  const rs = landmarks[MP.RIGHT_SHOULDER];

  if (!allVisible(landmarks, [MP.LEFT_HIP, MP.RIGHT_HIP, MP.LEFT_SHOULDER, MP.RIGHT_SHOULDER])) {
    // 軀幹四點缺失 → 無法建立座標系，全部回 rest
    for (let i = 0; i < SMPL_JOINT_COUNT; i++) restPosTo(out[i], i);
    return out;
  }

  avgToSmpl(out[0], lh, rh);  // 0 pelvis
  avgToSmpl(out[12], ls, rs); // 12 neck

  // ── 脊椎：pelvis ↔ neck 線性插值 ──
  lerpVec(out[3], out[0], out[12], 1 / 3);  // 3 spine1
  lerpVec(out[6], out[0], out[12], 2 / 3);  // 6 spine2
  lerpVec(out[9], out[0], out[12], 0.9);    // 9 spine3 （略低於 neck）

  // ── 髖、膝、踝、腳趾 ──
  const kneeVisible = allVisible(landmarks, [MP.LEFT_KNEE, MP.RIGHT_KNEE]);
  const ankleVisible = allVisible(landmarks, [MP.LEFT_ANKLE, MP.RIGHT_ANKLE]);
  const footVisible = allVisible(landmarks, [MP.LEFT_FOOT_INDEX, MP.RIGHT_FOOT_INDEX]);

  mediaPipeWorldToSmpl(lh, out[1]);                                     // 1 leftHip
  mediaPipeWorldToSmpl(rh, out[2]);                                     // 2 rightHip
  if (kneeVisible) {
    mediaPipeWorldToSmpl(landmarks[MP.LEFT_KNEE], out[4]);              // 4 leftKnee
    mediaPipeWorldToSmpl(landmarks[MP.RIGHT_KNEE], out[5]);             // 5 rightKnee
  } else {
    restPosTo(out[4], 4);
    restPosTo(out[5], 5);
  }
  if (ankleVisible) {
    mediaPipeWorldToSmpl(landmarks[MP.LEFT_ANKLE], out[7]);             // 7 leftAnkle
    mediaPipeWorldToSmpl(landmarks[MP.RIGHT_ANKLE], out[8]);            // 8 rightAnkle
  } else {
    restPosTo(out[7], 7);
    restPosTo(out[8], 8);
  }
  if (footVisible) {
    mediaPipeWorldToSmpl(landmarks[MP.LEFT_FOOT_INDEX], out[10]);       // 10 leftFoot (toes)
    mediaPipeWorldToSmpl(landmarks[MP.RIGHT_FOOT_INDEX], out[11]);      // 11 rightFoot
  } else {
    restPosTo(out[10], 10);
    restPosTo(out[11], 11);
  }

  // ── 頸、頭 ──
  // 頭部位置用耳朵中點（若兩耳都可見），否則用鼻子
  const earsVisible = allVisible(landmarks, [MP.LEFT_EAR, MP.RIGHT_EAR]);
  if (earsVisible) {
    avgToSmpl(out[15], landmarks[MP.LEFT_EAR], landmarks[MP.RIGHT_EAR]); // 15 head
  } else if (landmarks[MP.NOSE] && landmarks[MP.NOSE].visibility >= MIN_VISIBILITY) {
    mediaPipeWorldToSmpl(landmarks[MP.NOSE], out[15]);
  } else {
    restPosTo(out[15], 15);
  }

  // ── collar（clavicle） = neck ↔ shoulder 中點 ──
  mediaPipeWorldToSmpl(ls, out[16]); // 16 leftShoulder (upper arm start) — 暫存
  mediaPipeWorldToSmpl(rs, out[17]); // 17 rightShoulder
  lerpVec(out[13], out[12], out[16], 0.5); // 13 leftCollar
  lerpVec(out[14], out[12], out[17], 0.5); // 14 rightCollar

  // ── 肘、腕 ──
  if (allVisible(landmarks, [MP.LEFT_ELBOW])) {
    mediaPipeWorldToSmpl(landmarks[MP.LEFT_ELBOW], out[18]);   // 18 leftElbow
  } else {
    restPosTo(out[18], 18);
  }
  if (allVisible(landmarks, [MP.RIGHT_ELBOW])) {
    mediaPipeWorldToSmpl(landmarks[MP.RIGHT_ELBOW], out[19]);  // 19 rightElbow
  } else {
    restPosTo(out[19], 19);
  }
  if (allVisible(landmarks, [MP.LEFT_WRIST])) {
    mediaPipeWorldToSmpl(landmarks[MP.LEFT_WRIST], out[20]);   // 20 leftWrist
  } else {
    restPosTo(out[20], 20);
  }
  if (allVisible(landmarks, [MP.RIGHT_WRIST])) {
    mediaPipeWorldToSmpl(landmarks[MP.RIGHT_WRIST], out[21]);  // 21 rightWrist
  } else {
    restPosTo(out[21], 21);
  }

  // ── 手指根（leftHand / rightHand）：以 index + pinky 的中點近似 ──
  const leftFingerVisible = allVisible(landmarks, [MP.LEFT_INDEX, MP.LEFT_PINKY]);
  const rightFingerVisible = allVisible(landmarks, [MP.RIGHT_INDEX, MP.RIGHT_PINKY]);
  if (leftFingerVisible) {
    avgToSmpl(out[22], landmarks[MP.LEFT_INDEX], landmarks[MP.LEFT_PINKY]);  // 22 leftHand
  } else {
    restPosTo(out[22], 22);
  }
  if (rightFingerVisible) {
    avgToSmpl(out[23], landmarks[MP.RIGHT_INDEX], landmarks[MP.RIGHT_PINKY]); // 23 rightHand
  } else {
    restPosTo(out[23], 23);
  }

  return out;
}
