/**
 * MediaPipe 33 landmark → SMPL 24 joint 3D 位置映射（Phase 5b HybrIK-TS）
 *
 * 輸入：MediaPipe Pose Landmarker 的 33 個 world landmark（公尺，hip-centered）
 * 輸出：24 個 SMPL joint 的 3D 座標（SMPL 慣例：Y up / +X 角色左側 / +Z 角色前方）
 *
 * ══ Body-frame normalization（2026-04-10 改版） ══
 *
 * 先前使用硬編碼的 `mediaPipeWorldToSmpl(lm) = (x, -y, -z)` 座標變換，
 * 但經過三次修改（-z → +z → -z）都無法得到正確視覺輸出。
 * 根本原因：即使 z 方向數值正確（diagnostic log 驗證），
 * 下游的 IK solver + smplToVrm pipeline 仍然產生不合理的姿勢。
 *
 * 新策略：**body-frame normalization** — 從 landmark 本身建立 subject-local
 * 正交座標系，所有 joint 位置投影到該座標系。完全不依賴 MediaPipe 的座標慣例。
 *
 * 方法：
 *   1. hipMid = avg(leftHip, rightHip) — 原點
 *   2. ankleMid = avg(leftAnkle, rightAnkle)（若可見）
 *   3. bodyUp = normalize(hipMid - ankleMid) — 約等於世界垂直（腳→髖方向）
 *      - 若 ankle 不可見，退化為 normalize(shoulderMid - hipMid)（沿軀幹方向）
 *   4. bodyLeft = orthogonalize(leftHip - rightHip, bodyUp) — 主體左右方向
 *   5. bodyForward = cross(bodyLeft, bodyUp) — 主體前方（右手系）
 *   6. 所有 landmark 投影到 (bodyLeft, bodyUp, bodyForward) 座標系
 *
 * 為什麼用 ankle→hip 而非 hip→shoulder 當「上」：
 *   hip→shoulder 是軀幹方向，人前傾時嚴重傾斜。腿投影到傾斜的 body-frame
 *   會變形（直直往下的腿變成「向前延伸」），導致 IK solver 解出荒謬的腿部旋轉。
 *   ankle→hip 更接近世界垂直（人站著時腿大致垂直），不會扭曲腿部。
 *   同時也能保留上身前傾：shoulder 位置在 body-frame 中仍在 hip 前方。
 *
 * 優點：座標系無關，不需猜 MediaPipe 的 x/y/z 方向；腿部方向正確
 * 限制：若人不是站立（例如躺著、坐著），ankle→hip 不是世界垂直 — 需要
 *       更進階的重力偵測。目前假設人是站立 / 行走 / 蹲踞。
 *
 * 低 visibility 處理：
 *   - 若任一所需 landmark 的 visibility < MIN_VISIBILITY，該 SMPL joint 以
 *     rest pose 位置（SMPL_REST_POSITIONS）作為 fallback
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

// ═══════════════════════════════════════════════════════════
// Body-frame 工具
// ═══════════════════════════════════════════════════════════

/** Raw 3D 向量（避免 hot path new THREE.Vector3） */
interface Vec3 { x: number; y: number; z: number }

function vecSub(a: Vec3, b: Vec3): Vec3 {
  return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z };
}

function vecScale(v: Vec3, s: number): Vec3 {
  return { x: v.x * s, y: v.y * s, z: v.z * s };
}

function vecDot(a: Vec3, b: Vec3): number {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

function vecLen(v: Vec3): number {
  return Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z);
}

function vecNormalize(v: Vec3): Vec3 {
  const len = vecLen(v);
  if (len < 1e-8) return { x: 0, y: 0, z: 0 };
  return { x: v.x / len, y: v.y / len, z: v.z / len };
}

function vecCross(a: Vec3, b: Vec3): Vec3 {
  return {
    x: a.y * b.z - a.z * b.y,
    y: a.z * b.x - a.x * b.z,
    z: a.x * b.y - a.y * b.x,
  };
}

function vecMid(a: Vec3, b: Vec3): Vec3 {
  return { x: (a.x + b.x) * 0.5, y: (a.y + b.y) * 0.5, z: (a.z + b.z) * 0.5 };
}

/** Body-local 正交基底 */
interface BodyFrame {
  origin: Vec3;
  left: Vec3;    // unit, subject's left = SMPL +X
  up: Vec3;      // unit, subject's up = SMPL +Y (沿軀幹，非世界垂直)
  forward: Vec3; // unit, subject's forward = SMPL +Z
}

/**
 * 從軀幹 + 腳踝建立 body-local 正交座標系
 *
 * 「上」方向優先用 ankle→hip（近似世界垂直），避免前傾軀幹扭曲腿部。
 * 若 ankle 不可見，退化為 hip→shoulder。
 *
 * @returns null if degenerate
 */
function buildBodyFrame(
  leftHip: Vec3,
  rightHip: Vec3,
  leftShoulder: Vec3,
  rightShoulder: Vec3,
  leftAnkle: Vec3 | null,
  rightAnkle: Vec3 | null,
): BodyFrame | null {
  const hipMid = vecMid(leftHip, rightHip);

  // up 方向：優先用 ankle→hip（世界垂直近似）
  let upRaw: Vec3;
  if (leftAnkle && rightAnkle) {
    const ankleMid = vecMid(leftAnkle, rightAnkle);
    upRaw = vecSub(hipMid, ankleMid); // 從腳踝指向髖部 = 世界「上」
  } else {
    const shoulderMid = vecMid(leftShoulder, rightShoulder);
    upRaw = vecSub(shoulderMid, hipMid); // 退化：軀幹方向
  }
  if (vecLen(upRaw) < 0.01) return null;
  const up = vecNormalize(upRaw);

  // left = rightHip → leftHip 方向（subject's left）
  const leftRaw = vecSub(leftHip, rightHip);
  const leftDotUp = vecDot(leftRaw, up);
  const leftOrth = vecSub(leftRaw, vecScale(up, leftDotUp));
  if (vecLen(leftOrth) < 0.001) return null;
  const left = vecNormalize(leftOrth);

  // forward = cross(left, up) → right-hand rule: left × up = forward
  const forward = vecCross(left, up);

  return { origin: hipMid, left, up, forward };
}

/**
 * 把一個 MP 空間的 3D 點投影到 body-local 座標系
 *
 * 結果直接就是 SMPL 座標 (x=left, y=up, z=forward)
 */
function projectToBodyFrame(frame: BodyFrame, p: Vec3): Vec3 {
  const d = vecSub(p, frame.origin);
  return {
    x: vecDot(d, frame.left),
    y: vecDot(d, frame.up),
    z: vecDot(d, frame.forward),
  };
}

// ═══════════════════════════════════════════════════════════
// Legacy transform（保留給 diagnostic / test 用）
// ═══════════════════════════════════════════════════════════

/**
 * 將 MediaPipe world 座標轉為 SMPL 慣例（Y up）
 *
 * @deprecated 2026-04-10 — 已改用 body-frame normalization。
 * 保留此函式僅供診斷 log 與向後相容測試使用。
 */
export function mediaPipeWorldToSmpl(lm: PoseLandmark, out: THREE.Vector3): THREE.Vector3 {
  out.set(lm.x, -lm.y, -lm.z);
  return out;
}

// ═══════════════════════════════════════════════════════════
// 主函式
// ═══════════════════════════════════════════════════════════

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

/** 把 body-frame 投影結果寫入 THREE.Vector3 */
function setFromBodyFrame(out: THREE.Vector3, frame: BodyFrame, lm: PoseLandmark): void {
  const p = projectToBodyFrame(frame, lm);
  out.set(p.x, p.y, p.z);
}

/** 把 body-frame 投影的兩點平均寫入 THREE.Vector3 */
function setAvgFromBodyFrame(
  out: THREE.Vector3,
  frame: BodyFrame,
  a: PoseLandmark,
  b: PoseLandmark,
): void {
  const pa = projectToBodyFrame(frame, a);
  const pb = projectToBodyFrame(frame, b);
  out.set((pa.x + pb.x) * 0.5, (pa.y + pb.y) * 0.5, (pa.z + pb.z) * 0.5);
}

/** 線性插值：out = a * (1 - t) + b * t */
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
 * 使用 body-frame normalization：從軀幹四點建立 subject-local 正交座標系，
 * 所有 landmark 投影到 (left, up, forward) 基底。結果不依賴 MediaPipe 的
 * world 座標慣例（x/y/z 方向），但會失去全域身體傾斜（角色永遠直立）。
 *
 * @param landmarks MediaPipe world landmarks（應為長度 33）
 */
export function landmarksToSmplJointPositions(
  landmarks: readonly PoseLandmark[],
): THREE.Vector3[] {
  const out: THREE.Vector3[] = new Array(SMPL_JOINT_COUNT);
  for (let i = 0; i < SMPL_JOINT_COUNT; i++) out[i] = new THREE.Vector3();

  if (landmarks.length < 33) {
    for (let i = 0; i < SMPL_JOINT_COUNT; i++) restPosTo(out[i], i);
    return out;
  }

  // ── 軀幹四點 ──
  const lh = landmarks[MP.LEFT_HIP];
  const rh = landmarks[MP.RIGHT_HIP];
  const ls = landmarks[MP.LEFT_SHOULDER];
  const rs = landmarks[MP.RIGHT_SHOULDER];

  if (!allVisible(landmarks, [MP.LEFT_HIP, MP.RIGHT_HIP, MP.LEFT_SHOULDER, MP.RIGHT_SHOULDER])) {
    for (let i = 0; i < SMPL_JOINT_COUNT; i++) restPosTo(out[i], i);
    return out;
  }

  // ── 取得 ankle（用於 body-frame 的「上」方向） ──
  const ankleVisible = allVisible(landmarks, [MP.LEFT_ANKLE, MP.RIGHT_ANKLE]);
  const la = ankleVisible ? landmarks[MP.LEFT_ANKLE] : null;
  const ra = ankleVisible ? landmarks[MP.RIGHT_ANKLE] : null;

  // ── 建立 body-frame ──
  const frame = buildBodyFrame(lh, rh, ls, rs, la, ra);
  if (!frame) {
    for (let i = 0; i < SMPL_JOINT_COUNT; i++) restPosTo(out[i], i);
    return out;
  }

  // ── 骨盆、頸（基準） ──
  // pelvis 在 body-frame 下是 origin = (0,0,0)
  out[0].set(0, 0, 0);
  // neck = avg(shoulders) 在 body-frame
  setAvgFromBodyFrame(out[12], frame, ls, rs);

  // ── 脊椎：pelvis ↔ neck 線性插值 ──
  lerpVec(out[3], out[0], out[12], 1 / 3);  // spine1
  lerpVec(out[6], out[0], out[12], 2 / 3);  // spine2
  lerpVec(out[9], out[0], out[12], 0.9);    // spine3

  // ── 髖 ──
  setFromBodyFrame(out[1], frame, lh); // leftHip
  setFromBodyFrame(out[2], frame, rh); // rightHip

  // ── 膝、踝、腳趾 ──
  if (allVisible(landmarks, [MP.LEFT_KNEE, MP.RIGHT_KNEE])) {
    setFromBodyFrame(out[4], frame, landmarks[MP.LEFT_KNEE]);
    setFromBodyFrame(out[5], frame, landmarks[MP.RIGHT_KNEE]);
  } else {
    restPosTo(out[4], 4);
    restPosTo(out[5], 5);
  }
  if (allVisible(landmarks, [MP.LEFT_ANKLE, MP.RIGHT_ANKLE])) {
    setFromBodyFrame(out[7], frame, landmarks[MP.LEFT_ANKLE]);
    setFromBodyFrame(out[8], frame, landmarks[MP.RIGHT_ANKLE]);
  } else {
    restPosTo(out[7], 7);
    restPosTo(out[8], 8);
  }
  if (allVisible(landmarks, [MP.LEFT_FOOT_INDEX, MP.RIGHT_FOOT_INDEX])) {
    setFromBodyFrame(out[10], frame, landmarks[MP.LEFT_FOOT_INDEX]);
    setFromBodyFrame(out[11], frame, landmarks[MP.RIGHT_FOOT_INDEX]);
  } else {
    restPosTo(out[10], 10);
    restPosTo(out[11], 11);
  }

  // ── 頭 ──
  if (allVisible(landmarks, [MP.LEFT_EAR, MP.RIGHT_EAR])) {
    setAvgFromBodyFrame(out[15], frame, landmarks[MP.LEFT_EAR], landmarks[MP.RIGHT_EAR]);
  } else if (landmarks[MP.NOSE] && landmarks[MP.NOSE].visibility >= MIN_VISIBILITY) {
    setFromBodyFrame(out[15], frame, landmarks[MP.NOSE]);
  } else {
    restPosTo(out[15], 15);
  }

  // ── 肩（upper arm root）──
  setFromBodyFrame(out[16], frame, ls); // leftShoulder
  setFromBodyFrame(out[17], frame, rs); // rightShoulder

  // ── collar = neck ↔ shoulder 中點 ──
  lerpVec(out[13], out[12], out[16], 0.5); // leftCollar
  lerpVec(out[14], out[12], out[17], 0.5); // rightCollar

  // ── 肘、腕 ──
  if (allVisible(landmarks, [MP.LEFT_ELBOW])) {
    setFromBodyFrame(out[18], frame, landmarks[MP.LEFT_ELBOW]);
  } else {
    restPosTo(out[18], 18);
  }
  if (allVisible(landmarks, [MP.RIGHT_ELBOW])) {
    setFromBodyFrame(out[19], frame, landmarks[MP.RIGHT_ELBOW]);
  } else {
    restPosTo(out[19], 19);
  }
  if (allVisible(landmarks, [MP.LEFT_WRIST])) {
    setFromBodyFrame(out[20], frame, landmarks[MP.LEFT_WRIST]);
  } else {
    restPosTo(out[20], 20);
  }
  if (allVisible(landmarks, [MP.RIGHT_WRIST])) {
    setFromBodyFrame(out[21], frame, landmarks[MP.RIGHT_WRIST]);
  } else {
    restPosTo(out[21], 21);
  }

  // ── 手指根 ──
  if (allVisible(landmarks, [MP.LEFT_INDEX, MP.LEFT_PINKY])) {
    setAvgFromBodyFrame(out[22], frame, landmarks[MP.LEFT_INDEX], landmarks[MP.LEFT_PINKY]);
  } else {
    restPosTo(out[22], 22);
  }
  if (allVisible(landmarks, [MP.RIGHT_INDEX, MP.RIGHT_PINKY])) {
    setAvgFromBodyFrame(out[23], frame, landmarks[MP.RIGHT_INDEX], landmarks[MP.RIGHT_PINKY]);
  } else {
    restPosTo(out[23], 23);
  }

  return out;
}
