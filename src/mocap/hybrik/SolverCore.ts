/**
 * HybrIK IK 核心求解器（Phase 5b HybrIK-TS）
 *
 * 把 24 個 SMPL joint 的目標 3D 位置逆向求解為每個 joint 的 local rotation，
 * 輸出為 axis-angle (exponential map) 格式，與 `SmplTrack.frames[f]` 相容。
 *
 * 演算法（簡化 HybrIK，zero-twist 近似）：
 *   1. root (pelvis) world rotation 由 rest pose 的 (spine1, leftHip) 與
 *      target 的 (spine1, leftHip) 做 two-axis fit 解出
 *   2. 以拓撲順序 (pelvis → leaf) 遍歷每個 joint i：
 *        - primaryChild = SMPL_PRIMARY_CHILD[i]
 *        - restDir = restPos[primaryChild] - restPos[i]                  (rest 座標系)
 *        - targetDir = targets[primaryChild] - targets[i]                (target 座標系)
 *        - 若 i 有 secondaryChild → two-axis fit，否則 → swingFromTo
 *        - 得 worldRot[i]
 *        - localRot[i] = worldRot[parent[i]]^{-1} * worldRot[i]
 *   3. 葉節點：沒有子節點可定向，localRot[leaf] = identity
 *   4. 轉 localRot 為 axis-angle，寫入輸出
 *
 * 已知限制（zero-twist）：
 *   - 完整 HybrIK 需神經網路預測每段骨骼的 twist（繞骨骼長軸的扭轉），
 *     本 port 對葉節點為 identity、對有子節點的 joint 以 swing 決定
 *     → 手掌朝向 / 前臂旋轉等細節會與真實動作略有差異
 *   - pelvis 與 spine3 透過 two-axis fit 解出完整 3x3 rotation，
 *     軀幹面向正確；但 spine1 / spine2 仍是單軸 swing，若中段扭轉大時會失真
 *   - 不做 bone length 一致性修正：輸出只含旋轉，下游 FK 會沿用
 *     `SMPL_REST_BONE_LENGTHS` 維持骨骼長度，target 距離差異不影響 output
 *
 * 模組邊界：純數學模組，只依賴 three.js Quaternion/Vector3 與
 * `SmplSkeleton` / `SmplRestPose` / `TwistSwing`。不依賴 DOM / VRM / MediaPipe。
 */

import * as THREE from 'three';
import { SMPL_JOINT_COUNT, SMPL_PARENT } from '../smpl/SmplSkeleton';
import {
  SMPL_REST_POSITIONS,
  SMPL_PRIMARY_CHILD,
  SMPL_SECONDARY_CHILD,
} from './SmplRestPose';
import { swingFromTo, rotationFromTwoAxes } from './TwistSwing';

/** 單一 axis-angle（exponential map，長度等於旋轉角度 radians） */
export type AxisAngle = [number, number, number];

/** IK 求解結果 */
export interface SolveResult {
  /** 24 個 joint 的 axis-angle 旋轉 */
  axisAngles: AxisAngle[];
  /** 根部世界位置（取自 targets[0]） */
  rootTranslation: [number, number, number];
}

// Hot-path 暫存
const tmpVec1 = new THREE.Vector3();
const tmpVec2 = new THREE.Vector3();
const tmpVec3 = new THREE.Vector3();
const tmpVec4 = new THREE.Vector3();
const tmpQuat = new THREE.Quaternion();
const invParent = new THREE.Quaternion();

/**
 * 從 24 個 SMPL joint 的 target 3D 位置求解 local rotations
 *
 * @param targets 長度 24 的 THREE.Vector3 陣列，每個代表對應 SMPL joint 的
 *                目標世界座標（SMPL 座標系：Y up）
 * @returns 每個 joint 的 axis-angle + 根部平移
 */
export function solveSmplFromJointPositions(
  targets: readonly THREE.Vector3[],
): SolveResult {
  if (targets.length < SMPL_JOINT_COUNT) {
    throw new Error(
      `[SolverCore] targets 長度不足：expected ${SMPL_JOINT_COUNT}, got ${targets.length}`,
    );
  }

  // 每個 joint 的 world rotation（相對於 global frame）
  const worldRots: THREE.Quaternion[] = new Array(SMPL_JOINT_COUNT);
  for (let i = 0; i < SMPL_JOINT_COUNT; i++) {
    worldRots[i] = new THREE.Quaternion();
  }

  // 以拓撲順序（0..23，SMPL index 本身已是拓撲序）遍歷
  for (let i = 0; i < SMPL_JOINT_COUNT; i++) {
    const primaryChild = SMPL_PRIMARY_CHILD[i];
    if (primaryChild === null) {
      // 葉節點：無法定向，world rotation 沿用 parent（localRot 最終為 identity）
      const parent = SMPL_PARENT[i];
      if (parent >= 0) {
        worldRots[i].copy(worldRots[parent]);
      } // else root leaf（不會發生，pelvis 一定有 children）
      continue;
    }

    // rest 方向：restPos[primaryChild] - restPos[i]，在 rest global frame
    const rp = SMPL_REST_POSITIONS[primaryChild];
    const rm = SMPL_REST_POSITIONS[i];
    tmpVec1.set(rp.x - rm.x, rp.y - rm.y, rp.z - rm.z);

    // target 方向：targets[primaryChild] - targets[i]
    tmpVec2.copy(targets[primaryChild]).sub(targets[i]);

    const secondaryChild = SMPL_SECONDARY_CHILD[i];
    if (secondaryChild !== undefined) {
      // two-axis fit
      const sp = SMPL_REST_POSITIONS[secondaryChild];
      tmpVec3.set(sp.x - rm.x, sp.y - rm.y, sp.z - rm.z);
      tmpVec4.copy(targets[secondaryChild]).sub(targets[i]);
      rotationFromTwoAxes(tmpVec1, tmpVec3, tmpVec2, tmpVec4, worldRots[i]);
    } else {
      // 單軸 swing
      swingFromTo(tmpVec1, tmpVec2, worldRots[i]);
    }
  }

  // 把 worldRot 轉回 localRot：localRot[i] = worldRot[parent]^{-1} * worldRot[i]
  // 注意：必須先備份 worldRot，因為 localRot 要覆寫到同一陣列前必須先用原 worldRot[parent]
  const axisAngles: AxisAngle[] = new Array(SMPL_JOINT_COUNT);
  const localRots: THREE.Quaternion[] = new Array(SMPL_JOINT_COUNT);
  for (let i = 0; i < SMPL_JOINT_COUNT; i++) {
    const parent = SMPL_PARENT[i];
    const local = new THREE.Quaternion();
    if (parent < 0) {
      local.copy(worldRots[i]);
    } else {
      invParent.copy(worldRots[parent]).invert();
      local.copy(invParent).multiply(worldRots[i]);
    }
    localRots[i] = local;
    axisAngles[i] = quaternionToAxisAngle(local);
  }

  // 對葉節點強制 identity（雖然計算結果已是 identity，但保險）
  for (let i = 0; i < SMPL_JOINT_COUNT; i++) {
    if (SMPL_PRIMARY_CHILD[i] === null) {
      axisAngles[i] = [0, 0, 0];
    }
  }

  const pelvis = targets[0];
  return {
    axisAngles,
    rootTranslation: [pelvis.x, pelvis.y, pelvis.z],
  };
}

/**
 * 將 quaternion 轉為 axis-angle (exponential map)
 *
 * 公式：angle = 2 * acos(w)，axis = (x, y, z) / sin(angle/2)
 * 輸出 [ax*angle, ay*angle, az*angle]（長度 = angle）
 * 退化（角度近 0）→ [0, 0, 0]
 */
export function quaternionToAxisAngle(q: THREE.Quaternion): AxisAngle {
  // 規範化以避免累積誤差
  const n = Math.sqrt(q.x * q.x + q.y * q.y + q.z * q.z + q.w * q.w);
  if (n < 1e-8) return [0, 0, 0];
  const qx = q.x / n;
  const qy = q.y / n;
  const qz = q.z / n;
  let qw = q.w / n;

  // 確保短弧：w >= 0
  let sx = qx;
  let sy = qy;
  let sz = qz;
  if (qw < 0) {
    sx = -sx;
    sy = -sy;
    sz = -sz;
    qw = -qw;
  }

  const sinHalfSq = sx * sx + sy * sy + sz * sz;
  if (sinHalfSq < 1e-12) {
    return [0, 0, 0];
  }
  const sinHalf = Math.sqrt(sinHalfSq);
  const angle = 2 * Math.atan2(sinHalf, qw);
  const k = angle / sinHalf;
  return [sx * k, sy * k, sz * k];
}

/**
 * Forward Kinematics：給定 local rotations 與根位置，計算每個 joint 的世界座標
 *
 * 主要用於單元測試與 IK 回驗：solve → FK → 比對 targets。
 * 使用 rest pose 的 bone offset，bone length 永遠等於 rest length。
 *
 * @param localRots  長度 24 的 local rotation（在各自 parent frame 內）
 * @param rootTrans  根位置 (x, y, z)
 * @returns          長度 24 的世界座標
 */
export function forwardKinematics(
  localRots: readonly THREE.Quaternion[],
  rootTrans: readonly [number, number, number],
): THREE.Vector3[] {
  if (localRots.length < SMPL_JOINT_COUNT) {
    throw new Error(
      `[SolverCore] forwardKinematics: localRots 長度不足：${localRots.length}`,
    );
  }
  const worldPos: THREE.Vector3[] = new Array(SMPL_JOINT_COUNT);
  const worldRot: THREE.Quaternion[] = new Array(SMPL_JOINT_COUNT);
  for (let i = 0; i < SMPL_JOINT_COUNT; i++) {
    worldPos[i] = new THREE.Vector3();
    worldRot[i] = new THREE.Quaternion();
  }

  worldPos[0].set(rootTrans[0], rootTrans[1], rootTrans[2]);
  worldRot[0].copy(localRots[0]);

  for (let i = 1; i < SMPL_JOINT_COUNT; i++) {
    const p = SMPL_PARENT[i];
    // offset in rest parent frame = restPos[i] - restPos[p]
    const rp = SMPL_REST_POSITIONS[i];
    const rpa = SMPL_REST_POSITIONS[p];
    tmpVec1.set(rp.x - rpa.x, rp.y - rpa.y, rp.z - rpa.z);
    // rotate by parent's world rotation
    tmpVec1.applyQuaternion(worldRot[p]);
    worldPos[i].copy(worldPos[p]).add(tmpVec1);
    // world rotation accumulates
    tmpQuat.copy(worldRot[p]).multiply(localRots[i]);
    worldRot[i].copy(tmpQuat);
  }

  return worldPos;
}

/**
 * 把 axis-angle 陣列轉為 THREE.Quaternion 陣列（便於餵進 forwardKinematics）
 */
export function axisAnglesToQuaternions(aas: readonly AxisAngle[]): THREE.Quaternion[] {
  return aas.map((aa) => {
    const [x, y, z] = aa;
    const angle = Math.sqrt(x * x + y * y + z * z);
    const q = new THREE.Quaternion();
    if (angle < 1e-8) {
      q.set(0, 0, 0, 1);
    } else {
      const half = angle * 0.5;
      const s = Math.sin(half) / angle;
      q.set(x * s, y * s, z * s, Math.cos(half));
    }
    return q;
  });
}
