/**
 * 影片動作轉換器 — Body Solver（混合 MiKaPo + Kalidokit 流派）
 *
 * 從 MediaPipe poseWorldLandmarks 解出 VRM humanoid 軀幹 / 四肢的
 * local quaternion 旋轉。
 *
 * 流派：
 *   - 脊椎 / 髖部 / 頭：MiKaPo 階層 quaternion（從父骨骼累積後反求 local）
 *   - 四肢：findRotation(REF, localDir) 流派
 *
 * 對應計畫：video-converter-plan.md 第 2.5 / 5.1 / 5.2 節
 *
 * 不負責：
 *   - 手指（HandSolver）
 *   - 眼睛（EyeGazeSolver）
 *   - shoulder bone（無對應 landmark，固定為 identity）
 *   - chest / upperChest（spine 已承擔軀幹整段旋轉，這兩根固定 identity）
 *   - 套用倍率與 clamp（plan 第 5.2 節 Kalidokit 倍率屬於後處理層，此處
 *     只回傳 raw rotation；後處理在 PoseSolver / 呼叫端施加）
 */

import type { Quat } from '../math/Quat';
import {
  quatIdentity,
  quatMul,
  quatConj,
  quatFromUnitVectors,
  quatFromMat3,
  quatRotateVec,
} from '../math/Quat';
import type { Vec3 } from '../math/Vector';
import { sub, normalize, cross } from '../math/Vector';
import type { Landmark } from '../tracking/landmarkTypes';
import { POSE, POSE_LANDMARK_COUNT } from '../tracking/landmarkTypes';
import {
  A_POSE_REFERENCE_DIR,
  type VRMHumanoidBoneName,
} from '../tracking/boneMapping';

export interface SolvedBody {
  /** 髖部世界座標位置（公尺，相對 MediaPipe 原點） */
  hipsTranslation: Vec3 | null;
  /** 各骨骼相對父骨骼的 local rotation */
  rotations: Partial<Record<VRMHumanoidBoneName, Quat>>;
  /**
   * 內部累積的世界 quaternion（hips → 該骨骼），主要供測試與 PoseSolver
   * 後處理使用，呼叫端通常不需要。
   */
  ancestorWorldQ: Partial<Record<VRMHumanoidBoneName, Quat>>;
}

const toVec = (lm: Landmark): Vec3 => ({ x: lm.x, y: lm.y, z: lm.z });

const midpoint = (a: Vec3, b: Vec3): Vec3 => ({
  x: (a.x + b.x) * 0.5,
  y: (a.y + b.y) * 0.5,
  z: (a.z + b.z) * 0.5,
});

export class BodySolver {
  /**
   * 從一幀 poseWorldLandmarks 解出整個身體的 local rotation。
   *
   * @param world 33 個 MediaPipe pose worldLandmarks（公尺座標，原點在髖中心）
   */
  solve(world: Landmark[]): SolvedBody {
    const out: SolvedBody = {
      hipsTranslation: null,
      rotations: {},
      ancestorWorldQ: {},
    };
    if (world.length < POSE_LANDMARK_COUNT) return out;

    // ── 1. Hips orientation（從髖肩四邊形推三軸）──
    const LH = toVec(world[POSE.LEFT_HIP]);
    const RH = toVec(world[POSE.RIGHT_HIP]);
    const LS = toVec(world[POSE.LEFT_SHOULDER]);
    const RS = toVec(world[POSE.RIGHT_SHOULDER]);

    const hipMid = midpoint(LH, RH);
    const shoulderMid = midpoint(LS, RS);

    const hipRight = normalize(sub(RH, LH));
    const torsoUp = normalize(sub(shoulderMid, hipMid));
    // 用 cross 產生正交基底，確保三軸彼此正交（即使 right/up 不完全正交也成立）
    const hipForward = normalize(cross(hipRight, torsoUp));
    const hipUp = normalize(cross(hipForward, hipRight));

    // 把基底向量當成旋轉矩陣的「列」（每行儲一個分量）。
    // quatFromMat3 期望 row-major：第 i 列 j 行 = (right, up, forward)[j].(x|y|z)[i]
    const hipsWorldQ = quatFromMat3([
      hipRight.x, hipUp.x, hipForward.x,
      hipRight.y, hipUp.y, hipForward.y,
      hipRight.z, hipUp.z, hipForward.z,
    ]);
    out.rotations.hips = hipsWorldQ;
    out.ancestorWorldQ.hips = hipsWorldQ;
    out.hipsTranslation = hipMid;

    // ── 2. Spine 鏈：spine 承擔整段旋轉，chest / upperChest 維持 identity ──
    // 在 hips 局部空間下，spine 應指向 torsoUp 方向
    const spineLocalDir = quatRotateVec(quatConj(hipsWorldQ), torsoUp);
    out.rotations.spine = quatFromUnitVectors(A_POSE_REFERENCE_DIR.spine, spineLocalDir);
    out.rotations.chest = quatIdentity();
    out.rotations.upperChest = quatIdentity();

    const spineWorldQ = quatMul(hipsWorldQ, out.rotations.spine);
    const chestWorldQ = spineWorldQ; // chest = identity
    const upperChestWorldQ = chestWorldQ; // upperChest = identity
    out.ancestorWorldQ.spine = spineWorldQ;
    out.ancestorWorldQ.chest = chestWorldQ;
    out.ancestorWorldQ.upperChest = upperChestWorldQ;

    // ── 3. Neck（從鼻子方向推） ──
    const NOSE = toVec(world[POSE.NOSE]);
    const neckWorldDir = normalize(sub(NOSE, shoulderMid));
    const neckLocalDir = quatRotateVec(quatConj(upperChestWorldQ), neckWorldDir);
    out.rotations.neck = quatFromUnitVectors(A_POSE_REFERENCE_DIR.neck, neckLocalDir);
    const neckWorldQ = quatMul(upperChestWorldQ, out.rotations.neck);
    out.ancestorWorldQ.neck = neckWorldQ;

    // ── 4. Head（從耳-鼻方向推） ──
    const LE = toVec(world[POSE.LEFT_EAR]);
    const RE = toVec(world[POSE.RIGHT_EAR]);
    const earMid = midpoint(LE, RE);
    const headWorldDir = normalize(sub(earMid, NOSE));
    const headLocalDir = quatRotateVec(quatConj(neckWorldQ), headWorldDir);
    out.rotations.head = quatFromUnitVectors(A_POSE_REFERENCE_DIR.head, headLocalDir);
    out.ancestorWorldQ.head = quatMul(neckWorldQ, out.rotations.head);

    // ── 5. Shoulders（無對應 landmark，固定 identity） ──
    out.rotations.leftShoulder = quatIdentity();
    out.rotations.rightShoulder = quatIdentity();
    out.ancestorWorldQ.leftShoulder = upperChestWorldQ;
    out.ancestorWorldQ.rightShoulder = upperChestWorldQ;

    // ── 6. Arms ──
    this.solveArm(out, world, 'left', upperChestWorldQ);
    this.solveArm(out, world, 'right', upperChestWorldQ);

    // ── 7. Legs ──
    this.solveLeg(out, world, 'left', hipsWorldQ);
    this.solveLeg(out, world, 'right', hipsWorldQ);

    return out;
  }

  /** 解單側手臂（upperArm → lowerArm → hand），父鏈為 shoulder 的世界 quat */
  private solveArm(
    out: SolvedBody,
    world: Landmark[],
    side: 'left' | 'right',
    shoulderWorldQ: Quat
  ): void {
    const idxShoulder = side === 'left' ? POSE.LEFT_SHOULDER : POSE.RIGHT_SHOULDER;
    const idxElbow = side === 'left' ? POSE.LEFT_ELBOW : POSE.RIGHT_ELBOW;
    const idxWrist = side === 'left' ? POSE.LEFT_WRIST : POSE.RIGHT_WRIST;
    const idxIndex = side === 'left' ? POSE.LEFT_INDEX : POSE.RIGHT_INDEX;

    const upperArmBone: VRMHumanoidBoneName =
      side === 'left' ? 'leftUpperArm' : 'rightUpperArm';
    const lowerArmBone: VRMHumanoidBoneName =
      side === 'left' ? 'leftLowerArm' : 'rightLowerArm';
    const handBone: VRMHumanoidBoneName = side === 'left' ? 'leftHand' : 'rightHand';

    const shoulder = toVec(world[idxShoulder]);
    const elbow = toVec(world[idxElbow]);
    const wrist = toVec(world[idxWrist]);

    // upperArm
    const uaWorldDir = normalize(sub(elbow, shoulder));
    const uaLocalDir = quatRotateVec(quatConj(shoulderWorldQ), uaWorldDir);
    const upperArm = quatFromUnitVectors(A_POSE_REFERENCE_DIR[upperArmBone], uaLocalDir);
    out.rotations[upperArmBone] = upperArm;
    const upperArmWorldQ = quatMul(shoulderWorldQ, upperArm);
    out.ancestorWorldQ[upperArmBone] = upperArmWorldQ;

    // lowerArm
    const laWorldDir = normalize(sub(wrist, elbow));
    const laLocalDir = quatRotateVec(quatConj(upperArmWorldQ), laWorldDir);
    const lowerArm = quatFromUnitVectors(A_POSE_REFERENCE_DIR[lowerArmBone], laLocalDir);
    out.rotations[lowerArmBone] = lowerArm;
    const lowerArmWorldQ = quatMul(upperArmWorldQ, lowerArm);
    out.ancestorWorldQ[lowerArmBone] = lowerArmWorldQ;

    // hand：以 wrist→index 方向推
    const indexLm = toVec(world[idxIndex]);
    const handWorldDir = normalize(sub(indexLm, wrist));
    const handLocalDir = quatRotateVec(quatConj(lowerArmWorldQ), handWorldDir);
    const hand = quatFromUnitVectors(A_POSE_REFERENCE_DIR[handBone], handLocalDir);
    out.rotations[handBone] = hand;
    out.ancestorWorldQ[handBone] = quatMul(lowerArmWorldQ, hand);
  }

  /** 解單側腿（upperLeg → lowerLeg → foot），父鏈為 hips */
  private solveLeg(
    out: SolvedBody,
    world: Landmark[],
    side: 'left' | 'right',
    hipsWorldQ: Quat
  ): void {
    const idxHip = side === 'left' ? POSE.LEFT_HIP : POSE.RIGHT_HIP;
    const idxKnee = side === 'left' ? POSE.LEFT_KNEE : POSE.RIGHT_KNEE;
    const idxAnkle = side === 'left' ? POSE.LEFT_ANKLE : POSE.RIGHT_ANKLE;
    const idxFoot = side === 'left' ? POSE.LEFT_FOOT_INDEX : POSE.RIGHT_FOOT_INDEX;

    const upperLegBone: VRMHumanoidBoneName =
      side === 'left' ? 'leftUpperLeg' : 'rightUpperLeg';
    const lowerLegBone: VRMHumanoidBoneName =
      side === 'left' ? 'leftLowerLeg' : 'rightLowerLeg';
    const footBone: VRMHumanoidBoneName = side === 'left' ? 'leftFoot' : 'rightFoot';

    const hip = toVec(world[idxHip]);
    const knee = toVec(world[idxKnee]);
    const ankle = toVec(world[idxAnkle]);
    const foot = toVec(world[idxFoot]);

    // upperLeg
    const ulWorldDir = normalize(sub(knee, hip));
    const ulLocalDir = quatRotateVec(quatConj(hipsWorldQ), ulWorldDir);
    const upperLeg = quatFromUnitVectors(A_POSE_REFERENCE_DIR[upperLegBone], ulLocalDir);
    out.rotations[upperLegBone] = upperLeg;
    const upperLegWorldQ = quatMul(hipsWorldQ, upperLeg);
    out.ancestorWorldQ[upperLegBone] = upperLegWorldQ;

    // lowerLeg
    const llWorldDir = normalize(sub(ankle, knee));
    const llLocalDir = quatRotateVec(quatConj(upperLegWorldQ), llWorldDir);
    const lowerLeg = quatFromUnitVectors(A_POSE_REFERENCE_DIR[lowerLegBone], llLocalDir);
    out.rotations[lowerLegBone] = lowerLeg;
    const lowerLegWorldQ = quatMul(upperLegWorldQ, lowerLeg);
    out.ancestorWorldQ[lowerLegBone] = lowerLegWorldQ;

    // foot：ankle → foot_index 方向
    const footWorldDir = normalize(sub(foot, ankle));
    const footLocalDir = quatRotateVec(quatConj(lowerLegWorldQ), footWorldDir);
    const footQ = quatFromUnitVectors(A_POSE_REFERENCE_DIR[footBone], footLocalDir);
    out.rotations[footBone] = footQ;
    out.ancestorWorldQ[footBone] = quatMul(lowerLegWorldQ, footQ);
  }
}
