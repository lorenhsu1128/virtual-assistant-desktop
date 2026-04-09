/**
 * Phase 5b HybrIK-TS IK solver 單元測試
 *
 * 涵蓋：
 *   - SmplRestPose 常數合理性（bone length 非零、parent 鏈一致）
 *   - TwistSwing 基本屬性（swingFromTo / decomposeTwistSwing / rotationFromTwoAxes）
 *   - LandmarkToSmplJoint：rest T-pose 輸入 → pelvis 接近原點
 *   - SolverCore FK-IK 位置 round-trip：給 θ → FK → IK → FK → 位置應一致
 *   - 退化：零向量 / 低可見度不產生 NaN
 */

import { describe, it, expect } from 'vitest';
import * as THREE from 'three';

import {
  SMPL_REST_POSITIONS,
  SMPL_REST_BONE_LENGTHS,
  SMPL_REST_BONE_OFFSETS,
  SMPL_PRIMARY_CHILD,
} from '../../src/mocap/hybrik/SmplRestPose';
import { SMPL_JOINT_COUNT, SMPL_PARENT } from '../../src/mocap/smpl/SmplSkeleton';
import {
  swingFromTo,
  decomposeTwistSwing,
  rotationFromTwoAxes,
} from '../../src/mocap/hybrik/TwistSwing';
import {
  landmarksToSmplJointPositions,
  mediaPipeWorldToSmpl,
  MIN_VISIBILITY,
} from '../../src/mocap/hybrik/LandmarkToSmplJoint';
import {
  solveSmplFromJointPositions,
  forwardKinematics,
  axisAnglesToQuaternions,
  quaternionToAxisAngle,
  type AxisAngle,
} from '../../src/mocap/hybrik/SolverCore';
import { buildSmplTrackFromLandmarks } from '../../src/mocap/hybrik/buildSmplTrackFromLandmarks';
import type { PoseLandmark, PoseLandmarks } from '../../src/mocap/mediapipe/types';
import { clampSmplFrame } from '../../src/mocap/smpl/applyClamp';
import { SMPL_JOINT_AXIS_LIMITS } from '../../src/mocap/smpl/jointLimits';

// ═══════════════════════════════════════════════════════════
// SmplRestPose 常數
// ═══════════════════════════════════════════════════════════

describe('SmplRestPose constants', () => {
  it('provides 24 joint positions', () => {
    expect(SMPL_REST_POSITIONS.length).toBe(SMPL_JOINT_COUNT);
  });

  it('pelvis at origin', () => {
    const p = SMPL_REST_POSITIONS[0];
    expect(p.x).toBe(0);
    expect(p.y).toBe(0);
    expect(p.z).toBe(0);
  });

  it('all non-root bone lengths are positive', () => {
    for (let i = 1; i < SMPL_JOINT_COUNT; i++) {
      expect(SMPL_REST_BONE_LENGTHS[i]).toBeGreaterThan(0);
    }
  });

  it('bone offsets match child - parent difference', () => {
    for (let i = 1; i < SMPL_JOINT_COUNT; i++) {
      const p = SMPL_PARENT[i];
      const expected = {
        x: SMPL_REST_POSITIONS[i].x - SMPL_REST_POSITIONS[p].x,
        y: SMPL_REST_POSITIONS[i].y - SMPL_REST_POSITIONS[p].y,
        z: SMPL_REST_POSITIONS[i].z - SMPL_REST_POSITIONS[p].z,
      };
      expect(SMPL_REST_BONE_OFFSETS[i].x).toBeCloseTo(expected.x, 6);
      expect(SMPL_REST_BONE_OFFSETS[i].y).toBeCloseTo(expected.y, 6);
      expect(SMPL_REST_BONE_OFFSETS[i].z).toBeCloseTo(expected.z, 6);
    }
  });

  it('primary child table has 24 entries', () => {
    expect(SMPL_PRIMARY_CHILD.length).toBe(SMPL_JOINT_COUNT);
  });

  it('leaf joints have null primary child', () => {
    // 10 leftToes, 11 rightToes, 15 head, 22 leftHand, 23 rightHand
    expect(SMPL_PRIMARY_CHILD[10]).toBeNull();
    expect(SMPL_PRIMARY_CHILD[11]).toBeNull();
    expect(SMPL_PRIMARY_CHILD[15]).toBeNull();
    expect(SMPL_PRIMARY_CHILD[22]).toBeNull();
    expect(SMPL_PRIMARY_CHILD[23]).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════
// TwistSwing
// ═══════════════════════════════════════════════════════════

describe('swingFromTo', () => {
  it('returns identity for aligned vectors', () => {
    const u = new THREE.Vector3(1, 0, 0);
    const v = new THREE.Vector3(1, 0, 0);
    const q = swingFromTo(u, v);
    expect(q.x).toBeCloseTo(0, 6);
    expect(q.y).toBeCloseTo(0, 6);
    expect(q.z).toBeCloseTo(0, 6);
    expect(q.w).toBeCloseTo(1, 6);
  });

  it('rotates +X to +Y by 90° around +Z', () => {
    const u = new THREE.Vector3(1, 0, 0);
    const v = new THREE.Vector3(0, 1, 0);
    const q = swingFromTo(u, v);
    const rotated = u.clone().applyQuaternion(q);
    expect(rotated.x).toBeCloseTo(0, 5);
    expect(rotated.y).toBeCloseTo(1, 5);
    expect(rotated.z).toBeCloseTo(0, 5);
  });

  it('handles 180° opposite vectors without NaN', () => {
    const u = new THREE.Vector3(1, 0, 0);
    const v = new THREE.Vector3(-1, 0, 0);
    const q = swingFromTo(u, v);
    const rotated = u.clone().applyQuaternion(q);
    expect(Number.isFinite(rotated.x)).toBe(true);
    expect(rotated.x).toBeCloseTo(-1, 4);
  });

  it('returns identity when either vector is near zero', () => {
    const u = new THREE.Vector3(0, 0, 0);
    const v = new THREE.Vector3(1, 0, 0);
    const q = swingFromTo(u, v);
    expect(q.w).toBeCloseTo(1, 6);
  });
});

describe('decomposeTwistSwing', () => {
  it('round-trip: swing * twist ≈ original', () => {
    // 構造一個含 twist 的 rotation：繞 Y 90° + 繞 X 30°
    const q1 = new THREE.Quaternion().setFromAxisAngle(
      new THREE.Vector3(0, 1, 0),
      Math.PI / 2,
    );
    const q2 = new THREE.Quaternion().setFromAxisAngle(
      new THREE.Vector3(1, 0, 0),
      Math.PI / 6,
    );
    const q = q1.clone().multiply(q2);
    const axis = new THREE.Vector3(0, 1, 0);
    const { twist, swing } = decomposeTwistSwing(q, axis);
    const reconstructed = swing.clone().multiply(twist);
    // 四元數可能差負號但代表同一 rotation → 取點積絕對值
    const dot =
      q.x * reconstructed.x +
      q.y * reconstructed.y +
      q.z * reconstructed.z +
      q.w * reconstructed.w;
    expect(Math.abs(dot)).toBeCloseTo(1, 4);
  });
});

describe('rotationFromTwoAxes', () => {
  it('recovers identity when rest == target', () => {
    const restA = new THREE.Vector3(0, 1, 0);
    const restB = new THREE.Vector3(1, 0, 0);
    const targetA = new THREE.Vector3(0, 1, 0);
    const targetB = new THREE.Vector3(1, 0, 0);
    const q = rotationFromTwoAxes(restA, restB, targetA, targetB);
    expect(q.w).toBeCloseTo(1, 4);
  });

  it('recovers 90° Y-rotation: (+Y,+X) → (+Y,-Z)', () => {
    const restA = new THREE.Vector3(0, 1, 0);
    const restB = new THREE.Vector3(1, 0, 0);
    const targetA = new THREE.Vector3(0, 1, 0);
    const targetB = new THREE.Vector3(0, 0, -1);
    const q = rotationFromTwoAxes(restA, restB, targetA, targetB);
    // 套到 restB 應產生 targetB
    const rotated = restB.clone().applyQuaternion(q);
    expect(rotated.x).toBeCloseTo(0, 4);
    expect(rotated.y).toBeCloseTo(0, 4);
    expect(rotated.z).toBeCloseTo(-1, 4);
  });

  it('falls back gracefully when restB is collinear with restA', () => {
    const restA = new THREE.Vector3(0, 1, 0);
    const restB = new THREE.Vector3(0, 2, 0);
    const targetA = new THREE.Vector3(1, 0, 0);
    const targetB = new THREE.Vector3(3, 0, 0);
    const q = rotationFromTwoAxes(restA, restB, targetA, targetB);
    // 不應為 NaN
    expect(Number.isFinite(q.x)).toBe(true);
    expect(Number.isFinite(q.w)).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════
// LandmarkToSmplJoint
// ═══════════════════════════════════════════════════════════

/** 產生 33 個 fully-visible landmark，座標以函式提供 */
function makeLandmarks(
  getXyz: (index: number) => [number, number, number],
  visibility = 1.0,
): PoseLandmark[] {
  const result: PoseLandmark[] = new Array(33);
  for (let i = 0; i < 33; i++) {
    const [x, y, z] = getXyz(i);
    result[i] = { x, y, z, visibility };
  }
  return result;
}

describe('LandmarkToSmplJoint', () => {
  it('mediaPipeWorldToSmpl flips Y and Z', () => {
    const out = new THREE.Vector3();
    mediaPipeWorldToSmpl({ x: 1, y: 2, z: 3, visibility: 1 }, out);
    expect(out.x).toBe(1);
    expect(out.y).toBe(-2);
    expect(out.z).toBe(-3);
  });

  it('returns rest pose when all landmarks invisible', () => {
    const lms = makeLandmarks(() => [0, 0, 0], 0);
    const positions = landmarksToSmplJointPositions(lms);
    expect(positions.length).toBe(SMPL_JOINT_COUNT);
    // pelvis 應等於 rest pose pelvis（原點）
    expect(positions[0].x).toBeCloseTo(0, 6);
    expect(positions[0].y).toBeCloseTo(0, 6);
    expect(positions[0].z).toBeCloseTo(0, 6);
  });

  it('pelvis = average of left/right hips (in SMPL frame)', () => {
    const lms = makeLandmarks((i) => {
      if (i === 23) return [0.1, -0.9, 0]; // leftHip
      if (i === 24) return [-0.1, -0.9, 0]; // rightHip
      if (i === 11) return [0.1, -0.5, 0]; // leftShoulder
      if (i === 12) return [-0.1, -0.5, 0]; // rightShoulder
      return [0, 0, 0];
    });
    const positions = landmarksToSmplJointPositions(lms);
    // SMPL pelvis = avg(lh, rh) with Y flipped
    expect(positions[0].x).toBeCloseTo(0, 5);
    expect(positions[0].y).toBeCloseTo(0.9, 5); // -(-0.9)
    expect(positions[0].z).toBeCloseTo(0, 5);
  });

  it('neck sits above pelvis when torso visible', () => {
    const lms = makeLandmarks((i) => {
      if (i === 23) return [0.1, 0.5, 0]; // leftHip (MP y=0.5 → SMPL y=-0.5)
      if (i === 24) return [-0.1, 0.5, 0]; // rightHip
      if (i === 11) return [0.1, -0.3, 0]; // leftShoulder (MP y=-0.3 → SMPL y=0.3)
      if (i === 12) return [-0.1, -0.3, 0]; // rightShoulder
      return [0, 0, 0];
    });
    const positions = landmarksToSmplJointPositions(lms);
    // neck y 應 > pelvis y
    expect(positions[12].y).toBeGreaterThan(positions[0].y);
  });

  it('low visibility landmarks fall back to rest positions', () => {
    const lms = makeLandmarks((i) => {
      if (i === 23) return [0.1, 0.5, 0];
      if (i === 24) return [-0.1, 0.5, 0];
      if (i === 11) return [0.1, -0.3, 0];
      if (i === 12) return [-0.1, -0.3, 0];
      return [99, 99, 99]; // 其他可見度設低會被忽略
    }, 1.0);
    // 把 knees/ankles 設為低可見度
    [25, 26, 27, 28, 31, 32].forEach((idx) => {
      lms[idx] = { x: 99, y: 99, z: 99, visibility: MIN_VISIBILITY - 0.1 };
    });
    const positions = landmarksToSmplJointPositions(lms);
    // leftKnee (4) 應為 rest pose
    expect(positions[4].x).toBeCloseTo(SMPL_REST_POSITIONS[4].x, 5);
    expect(positions[4].y).toBeCloseTo(SMPL_REST_POSITIONS[4].y, 5);
  });
});

// ═══════════════════════════════════════════════════════════
// SolverCore
// ═══════════════════════════════════════════════════════════

describe('quaternionToAxisAngle', () => {
  it('identity → [0, 0, 0]', () => {
    const aa = quaternionToAxisAngle(new THREE.Quaternion(0, 0, 0, 1));
    expect(aa[0]).toBeCloseTo(0, 6);
    expect(aa[1]).toBeCloseTo(0, 6);
    expect(aa[2]).toBeCloseTo(0, 6);
  });

  it('90° around Z → [0, 0, π/2]', () => {
    const q = new THREE.Quaternion().setFromAxisAngle(
      new THREE.Vector3(0, 0, 1),
      Math.PI / 2,
    );
    const aa = quaternionToAxisAngle(q);
    expect(aa[0]).toBeCloseTo(0, 5);
    expect(aa[1]).toBeCloseTo(0, 5);
    expect(aa[2]).toBeCloseTo(Math.PI / 2, 5);
  });
});

describe('forwardKinematics', () => {
  it('identity rotations produce rest pose positions', () => {
    const localRots: THREE.Quaternion[] = new Array(SMPL_JOINT_COUNT);
    for (let i = 0; i < SMPL_JOINT_COUNT; i++) {
      localRots[i] = new THREE.Quaternion();
    }
    const positions = forwardKinematics(localRots, [0, 0, 0]);
    for (let i = 0; i < SMPL_JOINT_COUNT; i++) {
      expect(positions[i].x).toBeCloseTo(SMPL_REST_POSITIONS[i].x, 5);
      expect(positions[i].y).toBeCloseTo(SMPL_REST_POSITIONS[i].y, 5);
      expect(positions[i].z).toBeCloseTo(SMPL_REST_POSITIONS[i].z, 5);
    }
  });
});

describe('solveSmplFromJointPositions', () => {
  it('rest pose input → identity solution → rest pose FK', () => {
    const targets = SMPL_REST_POSITIONS.map((p) => new THREE.Vector3(p.x, p.y, p.z));
    const result = solveSmplFromJointPositions(targets);
    expect(result.axisAngles.length).toBe(SMPL_JOINT_COUNT);
    // FK 後應接近原輸入
    const quats = axisAnglesToQuaternions(result.axisAngles);
    const fkPositions = forwardKinematics(quats, result.rootTranslation);
    for (let i = 0; i < SMPL_JOINT_COUNT; i++) {
      expect(fkPositions[i].x).toBeCloseTo(targets[i].x, 4);
      expect(fkPositions[i].y).toBeCloseTo(targets[i].y, 4);
      expect(fkPositions[i].z).toBeCloseTo(targets[i].z, 4);
    }
  });

  it('single-joint rotation (left elbow bent 90°) FK round-trip', () => {
    // 從 rest 開始，構造 leftElbow 彎曲 90°（繞 +Z 軸，讓手肘往下屈）
    const srcLocal: THREE.Quaternion[] = new Array(SMPL_JOINT_COUNT);
    for (let i = 0; i < SMPL_JOINT_COUNT; i++) {
      srcLocal[i] = new THREE.Quaternion();
    }
    srcLocal[18] = new THREE.Quaternion().setFromAxisAngle(
      new THREE.Vector3(0, 0, 1),
      -Math.PI / 2,
    );
    const srcPositions = forwardKinematics(srcLocal, [0, 0, 0]);

    // 跑 solver
    const result = solveSmplFromJointPositions(srcPositions);
    const recoveredQuats = axisAnglesToQuaternions(result.axisAngles);
    const recoveredPositions = forwardKinematics(recoveredQuats, result.rootTranslation);

    // 比對位置（不比對 axis-angle，因為 zero-twist 限制可能讓 θ 不同但位置等效）
    for (let i = 0; i < SMPL_JOINT_COUNT; i++) {
      expect(recoveredPositions[i].x).toBeCloseTo(srcPositions[i].x, 3);
      expect(recoveredPositions[i].y).toBeCloseTo(srcPositions[i].y, 3);
      expect(recoveredPositions[i].z).toBeCloseTo(srcPositions[i].z, 3);
    }
  });

  it('FK round-trip recovers arm-raise pose positions', () => {
    // 左肩（SMPL joint 16）向上舉 90°
    const srcLocal: THREE.Quaternion[] = new Array(SMPL_JOINT_COUNT);
    for (let i = 0; i < SMPL_JOINT_COUNT; i++) {
      srcLocal[i] = new THREE.Quaternion();
    }
    // 左手臂 rest 沿 +X 延伸，想把它轉到 +Y → 繞 +Z 軸旋轉 +90°
    srcLocal[16] = new THREE.Quaternion().setFromAxisAngle(
      new THREE.Vector3(0, 0, 1),
      Math.PI / 2,
    );
    const srcPositions = forwardKinematics(srcLocal, [0, 0, 0]);

    // 確認 forward kinematics 把 wrist 拉到 +Y 方向
    expect(srcPositions[20].y).toBeGreaterThan(srcPositions[16].y);

    const result = solveSmplFromJointPositions(srcPositions);
    const recoveredQuats = axisAnglesToQuaternions(result.axisAngles);
    const recoveredPositions = forwardKinematics(recoveredQuats, result.rootTranslation);

    for (let i = 0; i < SMPL_JOINT_COUNT; i++) {
      expect(recoveredPositions[i].x).toBeCloseTo(srcPositions[i].x, 3);
      expect(recoveredPositions[i].y).toBeCloseTo(srcPositions[i].y, 3);
      expect(recoveredPositions[i].z).toBeCloseTo(srcPositions[i].z, 3);
    }
  });

  it('throws when targets array is too short', () => {
    const tooShort = new Array(10).fill(null).map(() => new THREE.Vector3());
    expect(() => solveSmplFromJointPositions(tooShort)).toThrow();
  });

  it('preserves root translation', () => {
    const targets = SMPL_REST_POSITIONS.map(
      (p) => new THREE.Vector3(p.x + 1.5, p.y + 2.0, p.z - 0.5),
    );
    const result = solveSmplFromJointPositions(targets);
    expect(result.rootTranslation[0]).toBeCloseTo(1.5, 5);
    expect(result.rootTranslation[1]).toBeCloseTo(2.0, 5);
    expect(result.rootTranslation[2]).toBeCloseTo(-0.5, 5);
  });
});

// ═══════════════════════════════════════════════════════════
// buildSmplTrackFromLandmarks
// ═══════════════════════════════════════════════════════════

describe('buildSmplTrackFromLandmarks', () => {
  /** 從 rest pose 構造一組完整 MediaPipe-like landmarks（SMPL→MP 反轉） */
  function makeRestPoseLandmarks(): PoseLandmarks {
    const lm: PoseLandmark[] = new Array(33);
    // 預設低可見度，避免未填入的點誤觸發 (0,0,0) 輸入
    for (let i = 0; i < 33; i++) {
      lm[i] = { x: 0, y: 0, z: 0, visibility: 0 };
    }
    // SMPL→MediaPipe 反轉：mp = (smpl.x, -smpl.y, -smpl.z)
    const fromSmpl = (smplIdx: number): PoseLandmark => {
      const p = SMPL_REST_POSITIONS[smplIdx];
      return { x: p.x, y: -p.y, z: -p.z, visibility: 1 };
    };
    const avgSmpl = (a: number, b: number): PoseLandmark => {
      const pa = SMPL_REST_POSITIONS[a];
      const pb = SMPL_REST_POSITIONS[b];
      return {
        x: (pa.x + pb.x) * 0.5,
        y: -(pa.y + pb.y) * 0.5,
        z: -(pa.z + pb.z) * 0.5,
        visibility: 1,
      };
    };
    // 軀幹
    lm[23] = fromSmpl(1); // leftHip
    lm[24] = fromSmpl(2); // rightHip
    lm[11] = fromSmpl(16); // leftShoulder → SMPL upper arm start
    lm[12] = fromSmpl(17); // rightShoulder
    // 腿
    lm[25] = fromSmpl(4); // leftKnee
    lm[26] = fromSmpl(5); // rightKnee
    lm[27] = fromSmpl(7); // leftAnkle
    lm[28] = fromSmpl(8); // rightAnkle
    lm[31] = fromSmpl(10); // leftFootIndex
    lm[32] = fromSmpl(11); // rightFootIndex
    // 臂
    lm[13] = fromSmpl(18); // leftElbow
    lm[14] = fromSmpl(19); // rightElbow
    lm[15] = fromSmpl(20); // leftWrist
    lm[16] = fromSmpl(21); // rightWrist
    // 手指（index + pinky 皆對應 SMPL hand）
    lm[17] = fromSmpl(22); // leftPinky
    lm[19] = fromSmpl(22); // leftIndex
    lm[18] = fromSmpl(23); // rightPinky
    lm[20] = fromSmpl(23); // rightIndex
    // 頭
    lm[7] = fromSmpl(15); // leftEar
    lm[8] = fromSmpl(15); // rightEar
    // 使 avgSmpl 的指令不被 linter 標為 unused
    void avgSmpl;
    return { image: lm, world: lm };
  }

  it('produces 3 frames from 3 landmark results', () => {
    const frames = [makeRestPoseLandmarks(), makeRestPoseLandmarks(), makeRestPoseLandmarks()];
    const track = buildSmplTrackFromLandmarks(frames, 30);
    expect(track.version).toBe(1);
    expect(track.fps).toBe(30);
    expect(track.frameCount).toBe(3);
    expect(track.frames.length).toBe(3);
    expect(track.trans.length).toBe(3);
    expect(track.frames[0].length).toBe(SMPL_JOINT_COUNT);
    expect(track.frames[0][0].length).toBe(3);
  });

  it('null frames fall back to rest pose (all zero axis-angle)', () => {
    const track = buildSmplTrackFromLandmarks([null, null], 30);
    expect(track.frameCount).toBe(2);
    for (let j = 0; j < SMPL_JOINT_COUNT; j++) {
      expect(track.frames[0][j]).toEqual([0, 0, 0]);
      expect(track.frames[1][j]).toEqual([0, 0, 0]);
    }
  });

  it('does not produce NaN for noisy low-visibility input', () => {
    const lms: PoseLandmarks = {
      image: Array.from({ length: 33 }, () => ({ x: NaN, y: NaN, z: NaN, visibility: 0 })),
      world: Array.from({ length: 33 }, () => ({ x: NaN, y: NaN, z: NaN, visibility: 0 })),
    };
    const track = buildSmplTrackFromLandmarks([lms], 30);
    for (let j = 0; j < SMPL_JOINT_COUNT; j++) {
      for (let k = 0; k < 3; k++) {
        expect(Number.isNaN(track.frames[0][j][k])).toBe(false);
      }
    }
  });

  it('Phase 5c: extreme noise gets clamped on torso joints', () => {
    // 造一個 24 × 3 都是極大值的 frame，clamp 後脊椎 / 頸應被拉到 ±π/3
    const noisy: number[][] = Array.from({ length: SMPL_JOINT_COUNT }, () => [10, 10, 10]);
    clampSmplFrame(noisy, SMPL_JOINT_AXIS_LIMITS);
    const torsoIndices = [3, 6, 9, 12]; // spine1/2/3, neck
    for (const i of torsoIndices) {
      expect(noisy[i][0]).toBeCloseTo(Math.PI / 3, 5);
      expect(noisy[i][1]).toBeCloseTo(Math.PI / 3, 5);
      expect(noisy[i][2]).toBeCloseTo(Math.PI / 3, 5);
    }
    // hip (寬鬆) 被拉到 ±π
    expect(noisy[1][0]).toBeCloseTo(Math.PI, 5);
    // toes (最緊) 被拉到 ±π/6
    expect(noisy[10][0]).toBeCloseTo(Math.PI / 6, 5);
  });

  it('Phase 5c: rest pose output survives clamp without modification', () => {
    const restFrame: number[][] = Array.from({ length: SMPL_JOINT_COUNT }, () => [0, 0, 0]);
    const before = JSON.stringify(restFrame);
    clampSmplFrame(restFrame, SMPL_JOINT_AXIS_LIMITS);
    expect(JSON.stringify(restFrame)).toBe(before);
  });

  it('output axis-angle lengths are finite and reasonable', () => {
    const track = buildSmplTrackFromLandmarks([makeRestPoseLandmarks()], 30);
    for (let j = 0; j < SMPL_JOINT_COUNT; j++) {
      const aa = track.frames[0][j] as AxisAngle;
      const len = Math.sqrt(aa[0] * aa[0] + aa[1] * aa[1] + aa[2] * aa[2]);
      expect(Number.isFinite(len)).toBe(true);
      // 對 rest pose 輸入，rotation 應很接近 identity（< ~10°）
      expect(len).toBeLessThan(0.5);
    }
  });
});
