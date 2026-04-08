/**
 * 影片動作轉換器 — Pose Solver Orchestrator
 *
 * 統合 BodySolver / HandSolver / EyeGazeSolver，從一幀 HolisticResult
 * 解出單一 SolvedPose（含全身骨骼 local rotation + 髖部位置）。
 *
 * 對應計畫：video-converter-plan.md 第 2.5 節
 */

import type { Quat } from '../math/Quat';
import type { Vec3 } from '../math/Vector';
import type { HolisticResult } from '../tracking/landmarkTypes';
import type { VRMHumanoidBoneName } from '../tracking/boneMapping';
import { BodySolver, type RefDirMap } from './BodySolver';
import { HandSolver } from './HandSolver';
import { EyeGazeSolver } from './EyeGazeSolver';
import { applyKalidokitArmAdjust } from './armPostProcess';

export interface SolvedPose {
  hipsTranslation: Vec3 | null;
  boneRotations: Partial<Record<VRMHumanoidBoneName, Quat>>;
}

export interface PoseSolverOptions {
  /** 是否處理手部 landmark（plan 第 8 節風險點 1 — 預設 OFF 由 spike 結果決定） */
  enableHands: boolean;
  /** 是否處理眼睛（部分 VRM 模型無 eye bone，套用前要檢查） */
  enableEyes: boolean;
}

export const DEFAULT_POSE_SOLVER_OPTIONS: PoseSolverOptions = {
  enableHands: true,
  enableEyes: true,
};

export class PoseSolver {
  private bodySolver = new BodySolver();
  private handSolver = new HandSolver();
  private eyeSolver = new EyeGazeSolver();

  constructor(private opts: PoseSolverOptions = DEFAULT_POSE_SOLVER_OPTIONS) {}

  /** 更新解算選項（不重建 solver 實例） */
  setOptions(opts: Partial<PoseSolverOptions>): void {
    this.opts = { ...this.opts, ...opts };
  }

  getOptions(): PoseSolverOptions {
    return { ...this.opts };
  }

  /**
   * 用實際 VRM bind pose 校正後的 REF_DIR 覆蓋 BodySolver 的預設值。
   * 對應 plan 第 8 節 Open Question 2，呼叫端通常為 PreviewCharacterScene
   * 在 loadVrm 後計算的校正結果。
   */
  setRefDirs(map: RefDirMap): void {
    this.bodySolver.setRefDirs(map);
  }

  /** 解算單幀 HolisticResult */
  solve(result: HolisticResult): SolvedPose {
    const out: SolvedPose = {
      hipsTranslation: null,
      boneRotations: {},
    };

    if (result.poseWorldLandmarks && result.poseWorldLandmarks.length >= 33) {
      const body = this.bodySolver.solve(result.poseWorldLandmarks);
      out.hipsTranslation = body.hipsTranslation;
      Object.assign(out.boneRotations, body.rotations);

      // Kalidokit 風格手臂後處理（plan §5.2 / §14）：
      // 套用 upperArm.z ×(-2.3×invert) 倍率、x/y clamp、解剖耦合。
      // 只覆寫已解算的手臂四根，其他骨骼不受影響。
      const lUa = body.rotations.leftUpperArm;
      const lLa = body.rotations.leftLowerArm;
      if (lUa && lLa) {
        const { upperArm, lowerArm } = applyKalidokitArmAdjust('left', lUa, lLa);
        out.boneRotations.leftUpperArm = upperArm;
        out.boneRotations.leftLowerArm = lowerArm;
      }
      const rUa = body.rotations.rightUpperArm;
      const rLa = body.rotations.rightLowerArm;
      if (rUa && rLa) {
        const { upperArm, lowerArm } = applyKalidokitArmAdjust('right', rUa, rLa);
        out.boneRotations.rightUpperArm = upperArm;
        out.boneRotations.rightLowerArm = lowerArm;
      }
    }

    if (this.opts.enableHands) {
      if (result.leftHandLandmarks && result.leftHandLandmarks.length >= 21) {
        Object.assign(out.boneRotations, this.handSolver.solve(result.leftHandLandmarks, 'left'));
      }
      if (result.rightHandLandmarks && result.rightHandLandmarks.length >= 21) {
        Object.assign(out.boneRotations, this.handSolver.solve(result.rightHandLandmarks, 'right'));
      }
    }

    if (this.opts.enableEyes && result.faceLandmarks && result.faceLandmarks.length >= 478) {
      const eyes = this.eyeSolver.solve(result.faceLandmarks);
      if (eyes.leftEye) out.boneRotations.leftEye = eyes.leftEye;
      if (eyes.rightEye) out.boneRotations.rightEye = eyes.rightEye;
    }

    return out;
  }
}
