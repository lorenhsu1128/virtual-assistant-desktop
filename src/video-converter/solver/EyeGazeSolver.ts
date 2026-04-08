/**
 * 影片動作轉換器 — Eye Gaze Solver
 *
 * 從 MediaPipe face landmarks 的虹膜中心相對眼角位置，計算 leftEye /
 * rightEye bone 的旋轉。
 *
 * 對應計畫：video-converter-plan.md 第 5.4 節
 *
 * 演算法：
 *   1. 取眼角內外角中點為眼眶中心
 *   2. 計算虹膜相對眼眶的歸一化偏移（[-1, 1]）
 *   3. 偏移 → yaw / pitch（±30° / ±20° 範圍）
 *   4. 構造 eye bone 局部 quaternion（XYZ Euler）
 *
 * **注意**：許多 VRM 模型沒有 leftEye / rightEye humanoid bone。
 * PreviewCharacterScene 套用前須檢查 `humanoid.getNormalizedBoneNode('leftEye')`，
 * 缺失時靜默跳過（plan 第 8 節 風險點 2）。
 */

import type { Quat } from '../math/Quat';
import { eulerToQuat } from '../math/Euler';
import { clamp } from '../math/helpers';
import type { Landmark } from '../tracking/landmarkTypes';
import { FACE, FACE_LANDMARK_COUNT } from '../tracking/landmarkTypes';

export interface SolvedEyes {
  leftEye: Quat | null;
  rightEye: Quat | null;
}

export class EyeGazeSolver {
  /**
   * 從 478 個 face landmarks（含 iris）解出兩眼旋轉。
   *
   * 若 face landmarks 不足或眼眶尺寸退化（< 1e-6），對應的 eye 為 null。
   */
  solve(faceLm: Landmark[]): SolvedEyes {
    if (!faceLm || faceLm.length < FACE_LANDMARK_COUNT) {
      return { leftEye: null, rightEye: null };
    }
    return {
      leftEye: this.solveEye(
        faceLm[FACE.LEFT_EYE_INNER_CORNER],
        faceLm[FACE.LEFT_EYE_OUTER_CORNER],
        faceLm[FACE.LEFT_EYE_TOP],
        faceLm[FACE.LEFT_EYE_BOTTOM],
        faceLm[FACE.LEFT_IRIS_CENTER]
      ),
      rightEye: this.solveEye(
        faceLm[FACE.RIGHT_EYE_INNER_CORNER],
        faceLm[FACE.RIGHT_EYE_OUTER_CORNER],
        faceLm[FACE.RIGHT_EYE_TOP],
        faceLm[FACE.RIGHT_EYE_BOTTOM],
        faceLm[FACE.RIGHT_IRIS_CENTER]
      ),
    };
  }

  private solveEye(
    inner: Landmark,
    outer: Landmark,
    top: Landmark,
    bot: Landmark,
    iris: Landmark
  ): Quat | null {
    const cx = (inner.x + outer.x) * 0.5;
    const cy = (inner.y + outer.y) * 0.5;
    const eyeWidth = Math.hypot(inner.x - outer.x, inner.y - outer.y);
    const eyeHeight = Math.hypot(top.x - bot.x, top.y - bot.y);
    if (eyeWidth < 1e-6 || eyeHeight < 1e-6) return null;

    let irisX = (iris.x - cx) / (eyeWidth * 0.5);
    let irisY = (iris.y - cy) / (eyeHeight * 0.5);
    irisX = clamp(irisX, -1, 1);
    irisY = clamp(irisY, -1, 1);

    // ±30° 水平、±20° 垂直
    const yaw = irisX * (Math.PI / 6);
    // 影像 Y 朝下，正值表示往下看；轉成 pitch 也往下（正 X 旋轉）
    const pitch = irisY * (Math.PI / 9);
    return eulerToQuat(pitch, yaw, 0, 'XYZ');
  }
}
