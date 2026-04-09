/**
 * 測試用 SMPL fixture 產生器（Phase 2c dev-only）
 *
 * 純程式碼產生 SmplTrack，不需要 JSON 檔案 I/O。
 * 用途：驗證下游 pipeline（smplToVrm → clamp → filter → MocapFrame）能正確運作，
 *       並提供肉眼可辨的動作讓使用者確認 scrub / 播放行為。
 *
 * 未來 Phase 4/5 接上真引擎後，這些 fixture 仍可保留作為回歸測試資料。
 */

import type { SmplTrack } from '../types';
import { SMPL_JOINT_COUNT } from '../smpl/SmplSkeleton';

/**
 * 左手舉起 + 手肘彎曲 fixture
 *
 * 動作曲線（以秒為單位）：
 *   - [0.0, 0.5]：rest pose
 *   - [0.5, 1.5]：左肩、左肘同步漸進到最終角度（smoothstep 過渡）
 *   - [1.5, 2.0]：保持最終姿勢
 *
 * 目的：
 *   - 視覺上易於辨認（左臂從垂放 → 舉起彎曲）
 *   - 驗證 smplToVrm 的 primary target 映射（leftShoulder→leftUpperArm，
 *     leftElbow→leftLowerArm）
 *   - 驗證 OneEuroFilter 對跨幀過渡的平滑效果
 *
 * @param fps        取樣 fps（預設 30）
 * @param durationSec 總長度（秒，預設 2.0）
 * @returns 生成的 SmplTrack
 */
export function generateLeftArmRaiseFixture(
  fps = 30,
  durationSec = 2.0,
): SmplTrack {
  const frameCount = Math.floor(fps * durationSec);
  const frames: number[][][] = [];
  const trans: number[][] = [];

  for (let f = 0; f < frameCount; f++) {
    const t = f / fps;
    const frame: number[][] = Array.from({ length: SMPL_JOINT_COUNT }, () => [0, 0, 0]);

    // 計算 0–1 過渡進度（smoothstep 曲線，[0.5s, 1.5s] 區間）
    const rawProgress = Math.max(0, Math.min(1, (t - 0.5) / 1.0));
    const progress = smoothstep(rawProgress);

    // SMPL leftShoulder (upper arm, idx 16)：繞 Z 軸正轉 → 手臂外展舉起
    // 角度從 0 → π/3 (~60°)
    frame[16] = [0, 0, progress * (Math.PI / 3)];

    // SMPL leftElbow (lower arm, idx 18)：繞 Z 軸負轉 → 手肘彎曲
    // 角度從 0 → -π/2 (~90°)
    frame[18] = [0, 0, -progress * (Math.PI / 2)];

    frames.push(frame);
    trans.push([0, 0, 0]);
  }

  return {
    version: 1,
    fps,
    frameCount,
    frames,
    trans,
  };
}

/**
 * Rest pose fixture
 *
 * 所有 joint 都是 identity rotation，所有 translation 都是 0。
 * 用於驗證 VrmaExporter 對「全 identity」輸入的正確處理。
 */
export function generateRestFixture(fps = 30, durationSec = 1.0): SmplTrack {
  const frameCount = Math.floor(fps * durationSec);
  const frames: number[][][] = [];
  const trans: number[][] = [];
  for (let f = 0; f < frameCount; f++) {
    frames.push(Array.from({ length: SMPL_JOINT_COUNT }, () => [0, 0, 0]));
    trans.push([0, 0, 0]);
  }
  return {
    version: 1,
    fps,
    frameCount,
    frames,
    trans,
  };
}

/**
 * Hips walk fixture
 *
 * - 所有 bone 保持 identity（無旋轉）
 * - hips 位置隨時間變化：Y 軸正弦波起伏（模擬走路晃動）+ X 軸緩步前進
 *
 * 用於驗證 VrmaExporter 的 hips translation 軌道。
 */
export function generateHipsWalkFixture(fps = 30, durationSec = 2.0): SmplTrack {
  const frameCount = Math.floor(fps * durationSec);
  const frames: number[][][] = [];
  const trans: number[][] = [];
  for (let f = 0; f < frameCount; f++) {
    const t = f / fps;
    frames.push(Array.from({ length: SMPL_JOINT_COUNT }, () => [0, 0, 0]));
    // Y 軸正弦波（幅度 0.05m，週期 0.8s），X 軸緩速前進
    const y = 0.05 * Math.sin((2 * Math.PI * t) / 0.8);
    const x = t * 0.3;
    trans.push([x, y, 0]);
  }
  return {
    version: 1,
    fps,
    frameCount,
    frames,
    trans,
  };
}

/** Smoothstep 過渡函式（3x² - 2x³），比線性插值平滑 */
function smoothstep(x: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  return x * x * (3 - 2 * x);
}
