/**
 * PoseSolver 整合測試
 *
 * 驗證 BodySolver / HandSolver / EyeGazeSolver 在 PoseSolver 下的端對端
 * 組裝：
 *   - enableHands 預設 / 切換時的手指 bone 輸出
 *   - 左右手 landmarks 正確路由到對應 VRM 手指 bone
 *   - pose landmarks 缺失時的降級行為
 *   - setOptions 熱切換不重建 solver
 */

import { describe, it, expect } from 'vitest';
import {
  PoseSolver,
  DEFAULT_POSE_SOLVER_OPTIONS,
} from '../../../../src/video-converter/solver/PoseSolver';
import type { HolisticResult, Landmark } from '../../../../src/video-converter/tracking/landmarkTypes';
import { HAND, POSE_LANDMARK_COUNT } from '../../../../src/video-converter/tracking/landmarkTypes';

const lm = (x: number, y: number, z: number, visibility = 1): Landmark => ({
  x,
  y,
  z,
  visibility,
});

/** 建立 21 點「攤平」手部 landmarks（與 HandSolver 測試共用慣例） */
function makeFlatHand(): Landmark[] {
  const arr: Landmark[] = new Array(21).fill(null).map(() => lm(0, 0, 0));
  arr[HAND.WRIST] = lm(0, 0, 0);
  arr[HAND.THUMB_CMC] = lm(0.02, 0.02, 0);
  arr[HAND.THUMB_MCP] = lm(0.04, 0.04, 0);
  arr[HAND.THUMB_IP] = lm(0.06, 0.06, 0);
  arr[HAND.THUMB_TIP] = lm(0.08, 0.08, 0);
  arr[HAND.INDEX_MCP] = lm(0.05, 0.0, 0);
  arr[HAND.INDEX_PIP] = lm(0.08, 0.0, 0);
  arr[HAND.INDEX_DIP] = lm(0.11, 0.0, 0);
  arr[HAND.INDEX_TIP] = lm(0.14, 0.0, 0);
  arr[HAND.MIDDLE_MCP] = lm(0.05, -0.02, 0);
  arr[HAND.MIDDLE_PIP] = lm(0.08, -0.02, 0);
  arr[HAND.MIDDLE_DIP] = lm(0.11, -0.02, 0);
  arr[HAND.MIDDLE_TIP] = lm(0.14, -0.02, 0);
  arr[HAND.RING_MCP] = lm(0.05, -0.04, 0);
  arr[HAND.RING_PIP] = lm(0.08, -0.04, 0);
  arr[HAND.RING_DIP] = lm(0.11, -0.04, 0);
  arr[HAND.RING_TIP] = lm(0.14, -0.04, 0);
  arr[HAND.PINKY_MCP] = lm(0.05, -0.06, 0);
  arr[HAND.PINKY_PIP] = lm(0.08, -0.06, 0);
  arr[HAND.PINKY_DIP] = lm(0.11, -0.06, 0);
  arr[HAND.PINKY_TIP] = lm(0.14, -0.06, 0);
  return arr;
}

/** 建立 33 點 pose world landmarks（標準 A-pose，用於喚起 BodySolver 不歸零） */
function makePoseWorldLandmarks(): Landmark[] {
  const arr: Landmark[] = new Array(POSE_LANDMARK_COUNT).fill(null).map(() => lm(0, 0, 0));
  // 最低必要點，讓 BodySolver 的 hips / spine / neck / head 段都可解
  arr[0] = lm(0, 1.7, 0); // NOSE
  arr[7] = lm(-0.07, 1.7, -0.05); // LEFT_EAR
  arr[8] = lm(0.07, 1.7, -0.05); // RIGHT_EAR
  arr[11] = lm(-0.18, 1.5, 0); // LEFT_SHOULDER
  arr[12] = lm(0.18, 1.5, 0); // RIGHT_SHOULDER
  arr[13] = lm(-0.35, 1.2, 0); // LEFT_ELBOW
  arr[14] = lm(0.35, 1.2, 0); // RIGHT_ELBOW
  arr[15] = lm(-0.50, 0.95, 0); // LEFT_WRIST
  arr[16] = lm(0.50, 0.95, 0); // RIGHT_WRIST
  arr[17] = lm(-0.54, 0.92, 0); // LEFT_PINKY
  arr[18] = lm(0.54, 0.92, 0); // RIGHT_PINKY
  arr[19] = lm(-0.52, 0.90, 0); // LEFT_INDEX
  arr[20] = lm(0.52, 0.90, 0); // RIGHT_INDEX
  arr[23] = lm(-0.10, 0.9, 0); // LEFT_HIP
  arr[24] = lm(0.10, 0.9, 0); // RIGHT_HIP
  arr[25] = lm(-0.10, 0.45, 0); // LEFT_KNEE
  arr[26] = lm(0.10, 0.45, 0); // RIGHT_KNEE
  arr[27] = lm(-0.10, 0.05, 0); // LEFT_ANKLE
  arr[28] = lm(0.10, 0.05, 0); // RIGHT_ANKLE
  arr[29] = lm(-0.10, 0.02, -0.05); // LEFT_HEEL
  arr[30] = lm(0.10, 0.02, -0.05); // RIGHT_HEEL
  arr[31] = lm(-0.10, 0.02, 0.10); // LEFT_FOOT_INDEX
  arr[32] = lm(0.10, 0.02, 0.10); // RIGHT_FOOT_INDEX
  return arr;
}

function makeResult(overrides: Partial<HolisticResult> = {}): HolisticResult {
  return {
    poseLandmarks: [],
    poseWorldLandmarks: makePoseWorldLandmarks(),
    leftHandLandmarks: [],
    rightHandLandmarks: [],
    faceLandmarks: [],
    timestampMs: 0,
    ...overrides,
  };
}

describe('PoseSolver — defaults', () => {
  it('預設 enableHands = true（v0.4 Hand 追蹤已啟用階段）', () => {
    expect(DEFAULT_POSE_SOLVER_OPTIONS.enableHands).toBe(true);
  });

  it('預設 enableEyes = true', () => {
    expect(DEFAULT_POSE_SOLVER_OPTIONS.enableEyes).toBe(true);
  });
});

describe('PoseSolver — hand landmark routing', () => {
  it('enableHands=true 時，leftHandLandmarks 會解出 left* 手指 bone', () => {
    const solver = new PoseSolver({
      enableHands: true,
      enableEyes: false,
      visibilityThreshold: 0.5,
    });
    const result = makeResult({ leftHandLandmarks: makeFlatHand() });
    const pose = solver.solve(result);

    expect(pose.boneRotations.leftIndexProximal).toBeDefined();
    expect(pose.boneRotations.leftMiddleIntermediate).toBeDefined();
    expect(pose.boneRotations.leftLittleDistal).toBeDefined();
    // 沒給 right hand landmarks → 不應產生 right* 手指
    expect(pose.boneRotations.rightIndexProximal).toBeUndefined();
  });

  it('enableHands=true 時，rightHandLandmarks 會解出 right* 手指 bone', () => {
    const solver = new PoseSolver({
      enableHands: true,
      enableEyes: false,
      visibilityThreshold: 0.5,
    });
    const result = makeResult({ rightHandLandmarks: makeFlatHand() });
    const pose = solver.solve(result);

    expect(pose.boneRotations.rightIndexProximal).toBeDefined();
    expect(pose.boneRotations.rightThumbDistal).toBeDefined();
    expect(pose.boneRotations.leftIndexProximal).toBeUndefined();
  });

  it('同時提供左右手 landmarks，兩側 bone 皆產生', () => {
    const solver = new PoseSolver({
      enableHands: true,
      enableEyes: false,
      visibilityThreshold: 0.5,
    });
    const result = makeResult({
      leftHandLandmarks: makeFlatHand(),
      rightHandLandmarks: makeFlatHand(),
    });
    const pose = solver.solve(result);

    // 15 根 × 2 = 30 根手指 bone
    const fingerBones = Object.keys(pose.boneRotations).filter(
      (k) => k.includes('Thumb') || k.includes('Index') || k.includes('Middle') || k.includes('Ring') || k.includes('Little')
    );
    expect(fingerBones.length).toBe(30);
  });

  it('enableHands=false 時，即便有 hand landmarks 也不會解出手指 bone', () => {
    const solver = new PoseSolver({
      enableHands: false,
      enableEyes: false,
      visibilityThreshold: 0.5,
    });
    const result = makeResult({
      leftHandLandmarks: makeFlatHand(),
      rightHandLandmarks: makeFlatHand(),
    });
    const pose = solver.solve(result);

    expect(pose.boneRotations.leftIndexProximal).toBeUndefined();
    expect(pose.boneRotations.rightIndexProximal).toBeUndefined();
  });

  it('hand landmarks 少於 21 點時靜默跳過', () => {
    const solver = new PoseSolver({
      enableHands: true,
      enableEyes: false,
      visibilityThreshold: 0.5,
    });
    const partial = makeFlatHand().slice(0, 10);
    const result = makeResult({ leftHandLandmarks: partial });
    const pose = solver.solve(result);

    expect(pose.boneRotations.leftIndexProximal).toBeUndefined();
    // body 部分應仍正常
    expect(pose.boneRotations.hips).toBeDefined();
  });
});

describe('PoseSolver — setOptions 熱切換', () => {
  it('執行中 setOptions({ enableHands: false }) 會停止手指輸出', () => {
    const solver = new PoseSolver({
      enableHands: true,
      enableEyes: false,
      visibilityThreshold: 0.5,
    });
    const result = makeResult({ leftHandLandmarks: makeFlatHand() });

    const before = solver.solve(result);
    expect(before.boneRotations.leftIndexProximal).toBeDefined();

    solver.setOptions({ enableHands: false });
    const after = solver.solve(result);
    expect(after.boneRotations.leftIndexProximal).toBeUndefined();
  });

  it('setOptions 只更新傳入的欄位，其他維持', () => {
    const solver = new PoseSolver({
      enableHands: false,
      enableEyes: true,
      visibilityThreshold: 0.7,
    });
    solver.setOptions({ enableHands: true });
    const opts = solver.getOptions();
    expect(opts.enableHands).toBe(true);
    expect(opts.enableEyes).toBe(true);
    expect(opts.visibilityThreshold).toBe(0.7);
  });
});

describe('PoseSolver — body + hand 獨立性', () => {
  it('hand 解算失敗不影響 body bone 輸出', () => {
    const solver = new PoseSolver({
      enableHands: true,
      enableEyes: false,
      visibilityThreshold: 0.5,
    });
    // 全零的手部 landmarks — HandSolver 仍會回傳骨骼（全 identity），
    // 但更重要的是 body 必須解算成功
    const result = makeResult({
      leftHandLandmarks: new Array(21).fill(null).map(() => lm(0, 0, 0)),
    });
    const pose = solver.solve(result);
    expect(pose.boneRotations.hips).toBeDefined();
    expect(pose.boneRotations.leftUpperArm).toBeDefined();
    expect(pose.boneRotations.rightUpperArm).toBeDefined();
  });
});
