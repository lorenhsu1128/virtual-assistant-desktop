/**
 * 影片動作轉換器 — Hand Solver（Kalidokit 1 DOF 流派）
 *
 * 從 MediaPipe hand landmarks 解出手指三節骨骼的 Z 軸彎曲角度。
 *
 * 對應計畫：video-converter-plan.md 第 2.5 / 5.3 節
 *
 * 簡化說明：
 *   - 四指（index / middle / ring / little）：每節 1 DOF Z 軸彎曲，
 *     由 angleBetween3DCoords(prev, curr, next) 計算彎曲角度
 *   - 拇指：MVP 也使用 1 DOF 簡化，未來 Phase 4 calibration 後可升級為
 *     3 DOF（每節 findRotation + dampener + startPos，plan 第 5.3 節原規格）
 *   - 直線（攤平）= bend ≈ π → zRot ≈ 0
 *   - 完全彎曲 = bend ≈ π/2 → zRot ≈ -π/2
 */

import type { Quat } from '../math/Quat';
import { quatIdentity } from '../math/Quat';
import { eulerToQuat } from '../math/Euler';
import { angleBetween3DCoords, type Vec3 } from '../math/Vector';
import { clamp } from '../math/helpers';
import type { Landmark } from '../tracking/landmarkTypes';
import { HAND_LANDMARK_COUNT } from '../tracking/landmarkTypes';
import {
  FINGER_CHAINS,
  type VRMHumanoidBoneName,
} from '../tracking/boneMapping';

const toVec = (lm: Landmark): Vec3 => ({ x: lm.x, y: lm.y, z: lm.z });

export class HandSolver {
  /**
   * 解出單手所有手指的局部旋轉。
   *
   * @param handLm 21 個 MediaPipe hand landmarks（normalized image coords or world）
   * @param side 左手或右手（影響 Z 軸方向）
   */
  solve(
    handLm: Landmark[],
    side: 'left' | 'right'
  ): Partial<Record<VRMHumanoidBoneName, Quat>> {
    const out: Partial<Record<VRMHumanoidBoneName, Quat>> = {};
    if (!handLm || handLm.length < HAND_LANDMARK_COUNT) return out;

    const invert = side === 'left' ? -1 : 1;
    const wrist = toVec(handLm[0]);

    for (const chain of FINGER_CHAINS) {
      if (chain.side !== side) continue;

      const indices = chain.landmarkIndices;
      // 對每節骨骼計算 1 DOF Z 軸彎曲
      for (let k = 0; k < 3; k++) {
        const prev = k === 0 ? wrist : toVec(handLm[indices[k - 1]]);
        const curr = toVec(handLm[indices[k]]);
        const next = toVec(handLm[indices[k + 1]]);

        const bend = angleBetween3DCoords(prev, curr, next);
        // 攤平 bend = π → zRot = 0；最彎 bend = π/2 → zRot = -π/2
        let zRot = -(Math.PI - bend);
        zRot = clamp(zRot, -Math.PI / 2, 0);

        const q: Quat = eulerToQuat(0, 0, zRot * invert, 'XYZ');
        out[chain.bones[k]] = q;
      }
    }

    return out;
  }

  /** 回傳全部手指 identity（offline / 模型無 hand landmarks 時的 fallback） */
  identity(side: 'left' | 'right'): Partial<Record<VRMHumanoidBoneName, Quat>> {
    const out: Partial<Record<VRMHumanoidBoneName, Quat>> = {};
    for (const chain of FINGER_CHAINS) {
      if (chain.side !== side) continue;
      for (const bone of chain.bones) {
        out[bone] = quatIdentity();
      }
    }
    return out;
  }
}
