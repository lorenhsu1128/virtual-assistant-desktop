/**
 * 批次：MediaPipe landmarks 陣列 → SmplTrack（Phase 5b HybrIK-TS）
 *
 * 對每一幀執行：
 *   1. landmarksToSmplJointPositions：33 → 24 joint 3D 位置
 *   2. solveSmplFromJointPositions：24 target → 24 local rotation (axis-angle)
 *   3. 組成 SmplTrack.frames[f] 與 SmplTrack.trans[f]
 *
 * 下游 pipeline（`buildMocapFrames`）會再做 clamp + SMPL→VRM 映射 + OneEuro 平滑。
 *
 * 若輸入陣列中某幀為 null（偵測失敗），該幀以 rest pose 填補（axis-angle 全零、
 * pelvis 位置取前一幀或 (0,0,0)）。OneEuro 會在下游把這些突變平滑化。
 *
 * 模組邊界：不依賴 DOM / VRM / MediaPipe SDK 本身，僅依賴 PoseLandmark 介面。
 */

import type { PoseLandmarks } from '../mediapipe/types';
import type { SmplTrack } from '../types';
import { SMPL_JOINT_COUNT } from '../smpl/SmplSkeleton';
import { landmarksToSmplJointPositions } from './LandmarkToSmplJoint';
import { solveSmplFromJointPositions } from './SolverCore';

/** 每幀對應一筆 PoseLandmarks，或 null 表示該幀偵測失敗 */
export type LandmarksFrame = PoseLandmarks | null;

/**
 * 批次建 SmplTrack
 *
 * @param frames 每幀的 MediaPipe landmark 結果
 * @param fps    取樣率（通常與影片 fps 一致）
 */
export function buildSmplTrackFromLandmarks(
  frames: readonly LandmarksFrame[],
  fps: number,
): SmplTrack {
  const frameCount = frames.length;
  const smplFrames: number[][][] = new Array(frameCount);
  const trans: number[][] = new Array(frameCount);
  let lastTrans: [number, number, number] = [0, 0, 0];

  for (let f = 0; f < frameCount; f++) {
    const lm = frames[f];
    if (!lm || !lm.world || lm.world.length < 33) {
      // 偵測失敗 → rest pose 填補，沿用上一幀 pelvis 位置
      smplFrames[f] = restFrameAxisAngles();
      trans[f] = [lastTrans[0], lastTrans[1], lastTrans[2]];
      continue;
    }

    const targets = landmarksToSmplJointPositions(lm.world);
    const result = solveSmplFromJointPositions(targets);

    // 把 axis-angle 結果轉成 number[24][3] 形式
    const frameData: number[][] = new Array(SMPL_JOINT_COUNT);
    for (let j = 0; j < SMPL_JOINT_COUNT; j++) {
      const aa = result.axisAngles[j];
      frameData[j] = [aa[0], aa[1], aa[2]];
    }
    smplFrames[f] = frameData;
    trans[f] = [
      result.rootTranslation[0],
      result.rootTranslation[1],
      result.rootTranslation[2],
    ];
    lastTrans = result.rootTranslation;
  }

  return {
    version: 1,
    fps,
    frameCount,
    frames: smplFrames,
    trans,
  };
}

/** 產生一幀全為 identity 的 axis-angle 資料（24 × 3 zeros） */
function restFrameAxisAngles(): number[][] {
  const frame: number[][] = new Array(SMPL_JOINT_COUNT);
  for (let j = 0; j < SMPL_JOINT_COUNT; j++) {
    frame[j] = [0, 0, 0];
  }
  return frame;
}
