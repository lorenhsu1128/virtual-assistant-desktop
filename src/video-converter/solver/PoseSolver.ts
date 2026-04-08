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
import { BodySolver } from './BodySolver';
import { HandSolver } from './HandSolver';
import { EyeGazeSolver } from './EyeGazeSolver';

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
