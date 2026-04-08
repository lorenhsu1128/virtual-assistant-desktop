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
import { sub, normalize, cross, length, angleBetween3DCoords } from '../math/Vector';
import { eulerToQuat } from '../math/Euler';
import type { Landmark } from '../tracking/landmarkTypes';
import { POSE, POSE_LANDMARK_COUNT } from '../tracking/landmarkTypes';
import {
  A_POSE_REFERENCE_DIR,
  type VRMHumanoidBoneName,
} from '../tracking/boneMapping';

export type RefDirMap = Partial<Record<VRMHumanoidBoneName, Vec3>>;

/** 預設能見度門檻（低於此值視為不可靠） */
export const DEFAULT_VISIBILITY_THRESHOLD = 0.5;

/**
 * 檢查 landmark 陣列中某個索引的能見度是否達到門檻。
 *
 * MediaPipe pose landmarks 的 visibility 欄位為 [0, 1]，數值越高表示該點
 * 越確定被相機看到。undefined 視為 1（向下相容沒有 visibility 的測試資料）。
 */
function isVisible(lm: Landmark[], idx: number, threshold: number): boolean {
  const v = lm[idx]?.visibility;
  if (v === undefined) return true;
  return v >= threshold;
}

/** 檢查多個 landmark 索引是否全部可見 */
function allVisible(lm: Landmark[], indices: number[], threshold: number): boolean {
  for (const i of indices) {
    if (!isVisible(lm, i, threshold)) return false;
  }
  return true;
}

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

/**
 * 退化輸入 (|cross| 過小) 時的安全閾值。小於此值視為三點共線或方向無效。
 */
const BASIS_EPSILON = 1e-6;

type Basis = { x: Vec3; y: Vec3; z: Vec3 };

/**
 * 從兩個軸候選向量組成正交右手基底（Y 作為主軸）。
 *
 * 策略：以 yHint 為主（須非退化），z = cross(xHint, y)，x = cross(y, z)。
 * 若中間任一步退化（cross 長度過小）則回傳 null。
 *
 * 結果滿足：|x| = |y| = |z| = 1 且彼此正交，cross(x, y) = z（右手系）。
 */
function orthoBasisYPrimary(xHint: Vec3, yHint: Vec3): Basis | null {
  const yLen = length(yHint);
  if (yLen < BASIS_EPSILON) return null;
  const y: Vec3 = { x: yHint.x / yLen, y: yHint.y / yLen, z: yHint.z / yLen };
  const zCross = cross(xHint, y);
  const zLen = length(zCross);
  if (zLen < BASIS_EPSILON) return null;
  const z: Vec3 = { x: zCross.x / zLen, y: zCross.y / zLen, z: zCross.z / zLen };
  const xCross = cross(y, z);
  const xLen = length(xCross);
  if (xLen < BASIS_EPSILON) return null;
  const x: Vec3 = { x: xCross.x / xLen, y: xCross.y / xLen, z: xCross.z / xLen };
  return { x, y, z };
}

/**
 * 從兩個軸候選向量組成正交右手基底（Z 作為主軸）。
 *
 * 策略：以 zHint 為主，y = cross(z, xHint)，x = cross(y, z)。
 */
function orthoBasisZPrimary(xHint: Vec3, zHint: Vec3): Basis | null {
  const zLen = length(zHint);
  if (zLen < BASIS_EPSILON) return null;
  const z: Vec3 = { x: zHint.x / zLen, y: zHint.y / zLen, z: zHint.z / zLen };
  const yCross = cross(z, xHint);
  const yLen = length(yCross);
  if (yLen < BASIS_EPSILON) return null;
  const y: Vec3 = { x: yCross.x / yLen, y: yCross.y / yLen, z: yCross.z / yLen };
  const xCross = cross(y, z);
  const xLen = length(xCross);
  if (xLen < BASIS_EPSILON) return null;
  const x: Vec3 = { x: xCross.x / xLen, y: xCross.y / xLen, z: xCross.z / xLen };
  return { x, y, z };
}

/**
 * 將世界空間的正交右手基底轉為「相對於 parentWorldQ 的 local quaternion」。
 *
 * 流程：
 *   1. 先組成世界矩陣（columns = x, y, z）並 quatFromMat3 得 worldQ
 *   2. localQ = conj(parentWorldQ) × worldQ
 *
 * 輸入的三軸必須已經是正交單位向量（通常來自 orthoBasis）。
 */
function basisToLocalQ(
  basis: Basis,
  parentWorldQ: Quat,
): Quat {
  // row-major 3×3：row i = (x.i, y.i, z.i)
  const worldQ = quatFromMat3([
    basis.x.x, basis.y.x, basis.z.x,
    basis.x.y, basis.y.y, basis.z.y,
    basis.x.z, basis.y.z, basis.z.z,
  ]);
  return quatMul(quatConj(parentWorldQ), worldQ);
}

export class BodySolver {
  /**
   * 當前使用的參考方向 map。預設為 A_POSE_REFERENCE_DIR（plan 第 3 節
   * 寫死的初始值），可透過 setRefDirs() 用實際 VRM bind pose 校正後的
   * 值覆蓋（plan 第 8 節 Open Question 2 的解法）。
   */
  private refDirs: Required<RefDirMap> = { ...A_POSE_REFERENCE_DIR };

  /**
   * 能見度門檻（plan 第 8 節風險 #1）。
   *
   * MediaPipe pose landmarks 對畫面外 / 遮擋的部位仍會輸出低能見度估值，
   * 直接套用會產生雜訊姿勢。門檻以下的 bone 不寫入 rotations，呼叫端
   * 會自動保留前一幀狀態（Preview / CaptureBuffer 的預設行為）。
   */
  private visibilityThreshold = DEFAULT_VISIBILITY_THRESHOLD;

  /**
   * 用實際 VRM bind pose 校正後的 REF_DIR 覆蓋預設值。未在 map 中的
   * 骨骼維持預設值（A_POSE_REFERENCE_DIR）。
   *
   * 呼叫端通常為 PreviewCharacterScene.calibrateRefDirs() 的回傳值。
   */
  setRefDirs(map: RefDirMap): void {
    this.refDirs = { ...A_POSE_REFERENCE_DIR, ...map };
  }

  getRefDirs(): Required<RefDirMap> {
    return this.refDirs;
  }

  /** 設定能見度門檻，clamp 在 [0, 1] */
  setVisibilityThreshold(v: number): void {
    this.visibilityThreshold = Math.max(0, Math.min(1, v));
  }

  getVisibilityThreshold(): number {
    return this.visibilityThreshold;
  }

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

    const thresh = this.visibilityThreshold;

    // ── 1. Hips orientation（從髖肩四邊形推三軸）──
    const LH = toVec(world[POSE.LEFT_HIP]);
    const RH = toVec(world[POSE.RIGHT_HIP]);
    const LS = toVec(world[POSE.LEFT_SHOULDER]);
    const RS = toVec(world[POSE.RIGHT_SHOULDER]);

    const hipMid = midpoint(LH, RH);
    const shoulderMid = midpoint(LS, RS);

    // 能見度檢查：hips 依賴 LH / RH / LS / RS 四點
    const hipsVisible = allVisible(
      world,
      [POSE.LEFT_HIP, POSE.RIGHT_HIP, POSE.LEFT_SHOULDER, POSE.RIGHT_SHOULDER],
      thresh,
    );

    let hipsWorldQ: Quat;
    if (hipsVisible) {
      const hipRight = normalize(sub(RH, LH));
      const torsoUp = normalize(sub(shoulderMid, hipMid));
      // 用 cross 產生正交基底，確保三軸彼此正交（即使 right/up 不完全正交也成立）
      const hipForward = normalize(cross(hipRight, torsoUp));
      const hipUp = normalize(cross(hipForward, hipRight));

      // 把基底向量當成旋轉矩陣的「列」（每行儲一個分量）。
      // quatFromMat3 期望 row-major：第 i 列 j 行 = (right, up, forward)[j].(x|y|z)[i]
      hipsWorldQ = quatFromMat3([
        hipRight.x, hipUp.x, hipForward.x,
        hipRight.y, hipUp.y, hipForward.y,
        hipRight.z, hipUp.z, hipForward.z,
      ]);
      out.rotations.hips = hipsWorldQ;
      out.hipsTranslation = hipMid;
    } else {
      // 跳過 hips 旋轉（呼叫端保留前一幀），但仍提供 identity 作為下游
      // child bone 的累積世界 quat fallback，避免 undefined 壞掉計算
      hipsWorldQ = quatIdentity();
    }
    out.ancestorWorldQ.hips = hipsWorldQ;

    // ── 2. Spine 鏈：spine 承擔整段旋轉，chest / upperChest 維持 identity ──
    // 在 hips 局部空間下，spine 應指向 torsoUp 方向
    // 能見度不足時跳過 spine / chest / upperChest 旋轉
    if (hipsVisible) {
      const torsoUp = normalize(sub(shoulderMid, hipMid));
      const spineLocalDir = quatRotateVec(quatConj(hipsWorldQ), torsoUp);
      out.rotations.spine = quatFromUnitVectors(this.refDirs.spine, spineLocalDir);
      out.rotations.chest = quatIdentity();
      out.rotations.upperChest = quatIdentity();
    }

    // 累積 world quat：若沒寫入 spine（能見度不足），用 hips 的 world quat
    // 作 fallback（等同 spine = identity）
    const spineLocal = out.rotations.spine ?? quatIdentity();
    const spineWorldQ = quatMul(hipsWorldQ, spineLocal);
    const chestWorldQ = spineWorldQ; // chest = identity
    const upperChestWorldQ = chestWorldQ; // upperChest = identity
    out.ancestorWorldQ.spine = spineWorldQ;
    out.ancestorWorldQ.chest = chestWorldQ;
    out.ancestorWorldQ.upperChest = upperChestWorldQ;

    // ── 3. Neck（從鼻子方向推） ──
    // 能見度檢查：需要 NOSE + 肩膀中點（shoulderMid 來自 LS/RS）
    const neckVisible = allVisible(
      world,
      [POSE.NOSE, POSE.LEFT_SHOULDER, POSE.RIGHT_SHOULDER],
      thresh,
    );
    const NOSE = toVec(world[POSE.NOSE]);
    let neckWorldQ: Quat;
    if (neckVisible) {
      const neckWorldDir = normalize(sub(NOSE, shoulderMid));
      const neckLocalDir = quatRotateVec(quatConj(upperChestWorldQ), neckWorldDir);
      out.rotations.neck = quatFromUnitVectors(this.refDirs.neck, neckLocalDir);
      neckWorldQ = quatMul(upperChestWorldQ, out.rotations.neck);
    } else {
      neckWorldQ = upperChestWorldQ;
    }
    out.ancestorWorldQ.neck = neckWorldQ;

    // ── 4. Head（三點 rigid body 基底：耳線 + 鼻方向） ──
    //
    // 用 LEFT_EAR / RIGHT_EAR / NOSE 三點建立完整的頭部 world 基底，
    // 取代原本只約束 1 軸的 earMid→NOSE 方法。好處：旋轉 twist（roll）
    // 也被正確約束，頭部側向歪頭、點頭、搖頭皆可還原。
    //
    // 世界軸約定（VRM head 本地基底 bind = 與 neck 對齊）：
    //   X = 角色右方（LEFT_EAR → RIGHT_EAR）
    //   Z = 角色前方（earMid → NOSE）
    //   Y = 向上（cross(Z, X) 再 re-ortho）
    const headVisible = allVisible(
      world,
      [POSE.LEFT_EAR, POSE.RIGHT_EAR, POSE.NOSE],
      thresh,
    );
    if (headVisible) {
      const LE = toVec(world[POSE.LEFT_EAR]);
      const RE = toVec(world[POSE.RIGHT_EAR]);
      const earMid = midpoint(LE, RE);
      const headRightAxis = sub(RE, LE);
      const headForwardAxis = sub(NOSE, earMid);
      const headBasis = orthoBasisZPrimary(headRightAxis, headForwardAxis);
      out.rotations.head = headBasis
        ? basisToLocalQ(headBasis, neckWorldQ)
        : quatIdentity();
    }
    out.ancestorWorldQ.head = quatMul(neckWorldQ, out.rotations.head ?? quatIdentity());

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
    const idxPinky = side === 'left' ? POSE.LEFT_PINKY : POSE.RIGHT_PINKY;

    const upperArmBone: VRMHumanoidBoneName =
      side === 'left' ? 'leftUpperArm' : 'rightUpperArm';
    const lowerArmBone: VRMHumanoidBoneName =
      side === 'left' ? 'leftLowerArm' : 'rightLowerArm';
    const handBone: VRMHumanoidBoneName = side === 'left' ? 'leftHand' : 'rightHand';

    // 能見度檢查：整條手臂依賴 shoulder / elbow / wrist，三者任一不可見
    // 就整隻手臂跳過（保留前一幀），避免把部分可見的 bone 跟不可見的 bone
    // 混用造成斷裂
    if (!allVisible(world, [idxShoulder, idxElbow, idxWrist], this.visibilityThreshold)) {
      // 設定 ancestor world quat 為父鏈，避免 undefined 壞掉後續累積
      out.ancestorWorldQ[upperArmBone] = shoulderWorldQ;
      out.ancestorWorldQ[lowerArmBone] = shoulderWorldQ;
      out.ancestorWorldQ[handBone] = shoulderWorldQ;
      return;
    }

    const shoulder = toVec(world[idxShoulder]);
    const elbow = toVec(world[idxElbow]);
    const wrist = toVec(world[idxWrist]);

    // upperArm
    const uaWorldDir = normalize(sub(elbow, shoulder));
    const uaLocalDir = quatRotateVec(quatConj(shoulderWorldQ), uaWorldDir);
    const upperArm = quatFromUnitVectors(this.refDirs[upperArmBone], uaLocalDir);
    out.rotations[upperArmBone] = upperArm;
    const upperArmWorldQ = quatMul(shoulderWorldQ, upperArm);
    out.ancestorWorldQ[upperArmBone] = upperArmWorldQ;

    // lowerArm（1 DOF Z 軸，plan §5.2）
    //
    // 肘關節是 hinge joint，僅能繞前臂 X 軸（解剖學）或 Z 軸（VRM 本地）
    // 做單一自由度的彎曲。用 shoulder-elbow-wrist 夾角反推：
    //   bendAngle  = π 時手臂伸直 → Z = 0
    //   bendAngle → 0 時手臂完全折疊 → Z → -π
    // LEFT / RIGHT 鏡像 invert。
    const bendAngle = angleBetween3DCoords(shoulder, elbow, wrist);
    const invert = side === 'left' ? -1 : 1;
    const lowerArmZRaw = -(Math.PI - bendAngle) * invert;
    // clamp 到 [-2.14, 0]×invert 範圍（plan §5.2 數值）
    const lowerArmZ =
      invert > 0
        ? Math.max(-2.14, Math.min(0, lowerArmZRaw))
        : Math.min(2.14, Math.max(0, lowerArmZRaw));
    const lowerArm = eulerToQuat(0, 0, lowerArmZ, 'XYZ');
    out.rotations[lowerArmBone] = lowerArm;
    const lowerArmWorldQ = quatMul(upperArmWorldQ, lowerArm);
    out.ancestorWorldQ[lowerArmBone] = lowerArmWorldQ;

    // ── Hand（三點 rigid body 基底：wrist + index + pinky） ──
    //
    // 改善點（plan §14 Phase 12 偏差 #1）：舊版用 wrist→INDEX 單軸，忽略
    // 手掌平面 twist。改用三點建立完整基底。
    //
    // 語意約定（讓 A-pose rest 時 basis ≈ identity）：
    //   Y = wrist − midpoint(index, pinky)（從指尖往 wrist 方向 = 世界 +Y）
    //   palmNormal hint：兩手鏡像
    //       LEFT:  cross(wristToIndex, wristToPinky)
    //       RIGHT: cross(wristToPinky, wristToIndex)
    //   basis 由 orthoBasisYPrimary(palmNormal, Y) 建立
    //
    // 退化（三點共線 / 手離畫面）或 index/pinky 能見度不足時跳過手部。
    if (allVisible(world, [idxIndex, idxPinky], this.visibilityThreshold)) {
      const indexLm = toVec(world[idxIndex]);
      const pinkyLm = toVec(world[idxPinky]);
      const fingerToWrist = sub(wrist, midpoint(indexLm, pinkyLm));
      const wristToIndex = sub(indexLm, wrist);
      const wristToPinky = sub(pinkyLm, wrist);
      const palmNormal =
        side === 'left'
          ? cross(wristToIndex, wristToPinky)
          : cross(wristToPinky, wristToIndex);
      const handBasis = orthoBasisYPrimary(palmNormal, fingerToWrist);
      if (handBasis) {
        out.rotations[handBone] = basisToLocalQ(handBasis, lowerArmWorldQ);
      }
    }
    out.ancestorWorldQ[handBone] = quatMul(
      lowerArmWorldQ,
      out.rotations[handBone] ?? quatIdentity(),
    );
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
    const idxHeel = side === 'left' ? POSE.LEFT_HEEL : POSE.RIGHT_HEEL;
    const idxFoot = side === 'left' ? POSE.LEFT_FOOT_INDEX : POSE.RIGHT_FOOT_INDEX;

    const upperLegBone: VRMHumanoidBoneName =
      side === 'left' ? 'leftUpperLeg' : 'rightUpperLeg';
    const lowerLegBone: VRMHumanoidBoneName =
      side === 'left' ? 'leftLowerLeg' : 'rightLowerLeg';
    const footBone: VRMHumanoidBoneName = side === 'left' ? 'leftFoot' : 'rightFoot';

    // 能見度檢查：整條腿依賴 hip / knee / ankle
    if (!allVisible(world, [idxHip, idxKnee, idxAnkle], this.visibilityThreshold)) {
      out.ancestorWorldQ[upperLegBone] = hipsWorldQ;
      out.ancestorWorldQ[lowerLegBone] = hipsWorldQ;
      out.ancestorWorldQ[footBone] = hipsWorldQ;
      return;
    }

    const hip = toVec(world[idxHip]);
    const knee = toVec(world[idxKnee]);
    const ankle = toVec(world[idxAnkle]);
    const heel = toVec(world[idxHeel]);
    const footIdx = toVec(world[idxFoot]);

    // upperLeg
    const ulWorldDir = normalize(sub(knee, hip));
    const ulLocalDir = quatRotateVec(quatConj(hipsWorldQ), ulWorldDir);
    const upperLeg = quatFromUnitVectors(this.refDirs[upperLegBone], ulLocalDir);
    out.rotations[upperLegBone] = upperLeg;
    const upperLegWorldQ = quatMul(hipsWorldQ, upperLeg);
    out.ancestorWorldQ[upperLegBone] = upperLegWorldQ;

    // lowerLeg
    const llWorldDir = normalize(sub(ankle, knee));
    const llLocalDir = quatRotateVec(quatConj(upperLegWorldQ), llWorldDir);
    const lowerLeg = quatFromUnitVectors(this.refDirs[lowerLegBone], llLocalDir);
    out.rotations[lowerLegBone] = lowerLeg;
    const lowerLegWorldQ = quatMul(upperLegWorldQ, lowerLeg);
    out.ancestorWorldQ[lowerLegBone] = lowerLegWorldQ;

    // ── Foot（三點 rigid body 基底：ankle + heel + foot_index） ──
    //
    // 改善點（plan §14 Phase 12 偏差 #3）：舊版只用 ankle→foot_index 單軸，
    // 腳掌旋轉（腳尖指向）被 under-constrained。
    //
    // 構造方式（讓 rest 時 basis ≈ identity）：
    //   Z（腳掌前方）= foot_index − heel
    //   X hint（角色右側）= cross(ankle→toe, ankle→heel)
    //     此 cross 結果在兩腳同樣的 ankle 比 heel/toe 高的幾何下，兩腳皆
    //     得到 +X 世界方向，無需 L/R 鏡像翻轉。
    //   basis = orthoBasisZPrimary(xHint, heelToToe)
    //
    // 退化 / heel 或 foot_index 能見度不足時跳過 foot。
    if (allVisible(world, [idxHeel, idxFoot], this.visibilityThreshold)) {
      const heelToToe = sub(footIdx, heel);
      const ankleToHeel = sub(heel, ankle);
      const ankleToToe = sub(footIdx, ankle);
      const footRightHint = cross(ankleToToe, ankleToHeel);
      const footBasis = orthoBasisZPrimary(footRightHint, heelToToe);
      if (footBasis) {
        out.rotations[footBone] = basisToLocalQ(footBasis, lowerLegWorldQ);
      }
    }
    out.ancestorWorldQ[footBone] = quatMul(
      lowerLegWorldQ,
      out.rotations[footBone] ?? quatIdentity(),
    );
  }
}
