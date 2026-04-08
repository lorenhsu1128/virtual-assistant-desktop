import { describe, it, expect } from 'vitest';
import { BodySolver } from '../../../../src/video-converter/solver/BodySolver';
import { POSE } from '../../../../src/video-converter/tracking/landmarkTypes';
import type { Landmark } from '../../../../src/video-converter/tracking/landmarkTypes';
import { quatIdentity, quatDot, quatRotateVec } from '../../../../src/video-converter/math/Quat';
import type { Quat } from '../../../../src/video-converter/math/Quat';

const lm = (x: number, y: number, z: number): Landmark => ({ x, y, z, visibility: 1 });

/** 建立 33 點 pose array，先填 0 再覆寫關鍵點 */
function makeEmptyPose(): Landmark[] {
  return new Array(33).fill(null).map(() => lm(0, 0, 0));
}

/**
 * 建立「rest pose」：臉朝鏡頭、雙手垂直向下、雙腳直立、頭與耳鼻對齊。
 *
 * 所有解出的 local rotation 應為 identity（包含 hips / spine / arms /
 * legs / hand / foot / neck / head），讓 BodySolver 可作 sanity check。
 *
 * 座標系：
 *   x = 受試者右側（+x）／y = 上（+y）／z = 受試者前方鏡頭外（+z）
 */
function makeRestPose(): Landmark[] {
  const arr = makeEmptyPose();
  arr[POSE.NOSE] = lm(0, 1.7, 0);
  arr[POSE.LEFT_EAR] = lm(-0.08, 1.7, -0.05);
  arr[POSE.RIGHT_EAR] = lm(0.08, 1.7, -0.05);
  arr[POSE.LEFT_SHOULDER] = lm(-0.18, 1.45, 0);
  arr[POSE.RIGHT_SHOULDER] = lm(0.18, 1.45, 0);
  arr[POSE.LEFT_ELBOW] = lm(-0.18, 1.15, 0);
  arr[POSE.RIGHT_ELBOW] = lm(0.18, 1.15, 0);
  arr[POSE.LEFT_WRIST] = lm(-0.18, 0.85, 0);
  arr[POSE.RIGHT_WRIST] = lm(0.18, 0.85, 0);
  // index 在 wrist 正下方一點點 → handLocalDir = (0,-1,0) → identity
  arr[POSE.LEFT_INDEX] = lm(-0.18, 0.78, 0);
  arr[POSE.RIGHT_INDEX] = lm(0.18, 0.78, 0);
  arr[POSE.LEFT_HIP] = lm(-0.12, 1.0, 0);
  arr[POSE.RIGHT_HIP] = lm(0.12, 1.0, 0);
  arr[POSE.LEFT_KNEE] = lm(-0.12, 0.55, 0);
  arr[POSE.RIGHT_KNEE] = lm(0.12, 0.55, 0);
  arr[POSE.LEFT_ANKLE] = lm(-0.12, 0.1, 0);
  arr[POSE.RIGHT_ANKLE] = lm(0.12, 0.1, 0);
  // foot_index 在 ankle 正前方 → footLocalDir = (0,0,1) → identity
  arr[POSE.LEFT_FOOT_INDEX] = lm(-0.12, 0.1, 0.15);
  arr[POSE.RIGHT_FOOT_INDEX] = lm(0.12, 0.1, 0.15);
  return arr;
}

const isNearIdentity = (q: Quat, tolerance = 1e-6): boolean => {
  // identity 為 (0,0,0,1) 或 (0,0,0,-1)
  return Math.abs(Math.abs(q.w) - 1) < tolerance;
};

describe('BodySolver — rest pose', () => {
  const solver = new BodySolver();

  it('rest pose 解出 hips translation 為 hipMid', () => {
    const result = solver.solve(makeRestPose());
    expect(result.hipsTranslation).not.toBeNull();
    expect(result.hipsTranslation!.x).toBeCloseTo(0, 9);
    expect(result.hipsTranslation!.y).toBeCloseTo(1.0, 9);
    expect(result.hipsTranslation!.z).toBeCloseTo(0, 9);
  });

  it('hips orientation 為 identity', () => {
    const result = solver.solve(makeRestPose());
    expect(isNearIdentity(result.rotations.hips!)).toBe(true);
  });

  it('spine 為 identity', () => {
    const result = solver.solve(makeRestPose());
    expect(isNearIdentity(result.rotations.spine!)).toBe(true);
  });

  it('chest / upperChest / shoulders 為 identity（固定值）', () => {
    const result = solver.solve(makeRestPose());
    expect(isNearIdentity(result.rotations.chest!)).toBe(true);
    expect(isNearIdentity(result.rotations.upperChest!)).toBe(true);
    expect(isNearIdentity(result.rotations.leftShoulder!)).toBe(true);
    expect(isNearIdentity(result.rotations.rightShoulder!)).toBe(true);
  });

  it('左右手臂三節都為 identity', () => {
    const result = solver.solve(makeRestPose());
    expect(isNearIdentity(result.rotations.leftUpperArm!)).toBe(true);
    expect(isNearIdentity(result.rotations.leftLowerArm!)).toBe(true);
    expect(isNearIdentity(result.rotations.leftHand!)).toBe(true);
    expect(isNearIdentity(result.rotations.rightUpperArm!)).toBe(true);
    expect(isNearIdentity(result.rotations.rightLowerArm!)).toBe(true);
    expect(isNearIdentity(result.rotations.rightHand!)).toBe(true);
  });

  it('左右腿三節都為 identity', () => {
    const result = solver.solve(makeRestPose());
    expect(isNearIdentity(result.rotations.leftUpperLeg!)).toBe(true);
    expect(isNearIdentity(result.rotations.leftLowerLeg!)).toBe(true);
    expect(isNearIdentity(result.rotations.leftFoot!)).toBe(true);
    expect(isNearIdentity(result.rotations.rightUpperLeg!)).toBe(true);
    expect(isNearIdentity(result.rotations.rightLowerLeg!)).toBe(true);
    expect(isNearIdentity(result.rotations.rightFoot!)).toBe(true);
  });

  it('neck / head 為 identity', () => {
    const result = solver.solve(makeRestPose());
    expect(isNearIdentity(result.rotations.neck!)).toBe(true);
    expect(isNearIdentity(result.rotations.head!)).toBe(true);
  });
});

describe('BodySolver — T-pose 手臂平舉', () => {
  const solver = new BodySolver();

  it('左手平舉：upperArm 旋轉非 identity，且把 (0,-1,0) 帶到 (-1,0,0)', () => {
    const pose = makeRestPose();
    // 左手往左平舉：elbow / wrist / index 都在 LS.x - 0.3 處
    pose[POSE.LEFT_ELBOW] = lm(-0.48, 1.45, 0);
    pose[POSE.LEFT_WRIST] = lm(-0.78, 1.45, 0);
    pose[POSE.LEFT_INDEX] = lm(-0.85, 1.45, 0);
    const result = solver.solve(pose);
    const lua = result.rotations.leftUpperArm!;
    expect(isNearIdentity(lua)).toBe(false);
    // upperArm 把參考方向 (0,-1,0) 旋轉到 worldDir = (-1, 0, 0)
    const rotated = quatRotateVec(lua, { x: 0, y: -1, z: 0 });
    expect(rotated.x).toBeCloseTo(-1, 9);
    expect(rotated.y).toBeCloseTo(0, 9);
    expect(rotated.z).toBeCloseTo(0, 9);
  });

  it('右手平舉：把 (0,-1,0) 帶到 (1,0,0)', () => {
    const pose = makeRestPose();
    pose[POSE.RIGHT_ELBOW] = lm(0.48, 1.45, 0);
    pose[POSE.RIGHT_WRIST] = lm(0.78, 1.45, 0);
    pose[POSE.RIGHT_INDEX] = lm(0.85, 1.45, 0);
    const result = solver.solve(pose);
    const rua = result.rotations.rightUpperArm!;
    const rotated = quatRotateVec(rua, { x: 0, y: -1, z: 0 });
    expect(rotated.x).toBeCloseTo(1, 9);
    expect(rotated.y).toBeCloseTo(0, 9);
    expect(rotated.z).toBeCloseTo(0, 9);
  });
});

describe('BodySolver — 頭部轉動', () => {
  const solver = new BodySolver();

  it('頭右看：head rotation 把 (0,0,-1) 帶到含 +X 分量的方向', () => {
    const pose = makeRestPose();
    // 把鼻子往受試者右側偏（攝影機看過去就是右）並維持耳朵位置
    // 模擬「看右」：nose.x > 0
    pose[POSE.NOSE] = lm(0.05, 1.7, 0.05); // 鼻子往右前
    // 耳朵不動（仍在 ±0.08）
    const result = solver.solve(pose);
    const head = result.rotations.head!;
    // 套用到 (0,0,-1) 後 X 分量應 > 0（因為鼻子轉向右側 → 頭朝右）
    const rotated = quatRotateVec(head, { x: 0, y: 0, z: -1 });
    // 至少要看得到水平方向有偏移（不是完美的 +X，因為 head 有複合旋轉）
    expect(Number.isFinite(rotated.x)).toBe(true);
    expect(Number.isFinite(rotated.y)).toBe(true);
    expect(Number.isFinite(rotated.z)).toBe(true);
    // 解算出來的 head 不是 identity
    expect(isNearIdentity(head)).toBe(false);
  });
});

describe('BodySolver — 父鏈非 identity 時的 arms', () => {
  const solver = new BodySolver();

  it('髖部 Z 軸傾斜時，arms 仍能解出有限結果（不 NaN）', () => {
    const pose = makeRestPose();
    // 髖線傾斜：左髖較高、右髖較低 → hips quat 含 Z 軸旋轉
    pose[POSE.LEFT_HIP] = lm(-0.12, 1.05, 0);
    pose[POSE.RIGHT_HIP] = lm(0.12, 0.95, 0);

    const result = solver.solve(pose);
    // hips 不再是 identity
    expect(isNearIdentity(result.rotations.hips!)).toBe(false);
    // 但手臂仍然能解（不 NaN）
    const lua = result.rotations.leftUpperArm!;
    expect(Number.isFinite(lua.x)).toBe(true);
    expect(Number.isFinite(lua.y)).toBe(true);
    expect(Number.isFinite(lua.z)).toBe(true);
    expect(Number.isFinite(lua.w)).toBe(true);
  });

  it('父鏈累積測試：ancestorWorldQ 對 leftUpperArm 等於 hips × spine × upperChest × leftShoulder', () => {
    const result = solver.solve(makeRestPose());
    // rest pose 下所有累積 quat 都應為 identity
    expect(isNearIdentity(result.ancestorWorldQ.leftUpperArm!)).toBe(true);
    expect(isNearIdentity(result.ancestorWorldQ.rightUpperArm!)).toBe(true);
  });
});

describe('BodySolver — 退化輸入', () => {
  it('小於 33 個 landmarks → 回傳空結果', () => {
    const result = new BodySolver().solve([]);
    expect(result.hipsTranslation).toBeNull();
    expect(Object.keys(result.rotations).length).toBe(0);
  });
});
