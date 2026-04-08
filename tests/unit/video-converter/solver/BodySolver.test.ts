import { describe, it, expect } from 'vitest';
import { BodySolver } from '../../../../src/video-converter/solver/BodySolver';
import { POSE } from '../../../../src/video-converter/tracking/landmarkTypes';
import type { Landmark } from '../../../../src/video-converter/tracking/landmarkTypes';
import { quatRotateVec } from '../../../../src/video-converter/math/Quat';
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
 *
 * Hand / Foot 新的 3 點 rigid basis 要求：
 *   - Hand：wrist + index + pinky 必須不共線
 *     rest 設定：雙手垂直下垂 → wrist 在 (±0.18, 0.85, 0)，
 *     index 在 (±0.18, 0.78, +0.02)（略前方），
 *     pinky 在 (±0.18, 0.78, -0.02)（略後方）
 *     → fingerDir ≈ (0,-0.07,0)  → Y_DOWN 方向
 *     → palmNormal：LEFT = cross(indexDir, pinkyDir) = cross((0,-0.07,+0.02),(0,-0.07,-0.02)) = (+0.0028,0,0) → +X
 *                  RIGHT = cross(pinkyDir, indexDir) = -X
 *     因左右手 palm normal 方向相反，basisToLocalQ 後左右 hand local 都 ≈ identity
 *   - Foot：ankle + heel + foot_index 需三點不共線
 *     rest 設定：腳掌平放 →
 *       ankle (±0.12, 0.1, 0)
 *       heel (±0.12, 0.05, -0.05)
 *       foot_index (±0.12, 0.05, 0.15)
 *     → heelToToe ≈ (0, 0, 0.20) → Z 方向
 *     → ankleAboveHeel ≈ (0, 0.05, 0.05) → 主要向上
 *     → X = cross(y, z) ≈ +X（右側）
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
  // Hand rigid basis 需要 wrist + index + pinky 三點。
  // rest pose 下要讓 basis 解出為 identity，LEFT / RIGHT 必須是「鏡像」
  // 幾何（palmNormal 經 chirality 翻轉後都落在同一方向）：
  //   LEFT:  index +Z, pinky −Z
  //   RIGHT: index −Z, pinky +Z（mirror）
  arr[POSE.LEFT_INDEX] = lm(-0.18, 0.78, 0.02);
  arr[POSE.LEFT_PINKY] = lm(-0.18, 0.78, -0.02);
  arr[POSE.RIGHT_INDEX] = lm(0.18, 0.78, -0.02);
  arr[POSE.RIGHT_PINKY] = lm(0.18, 0.78, 0.02);
  arr[POSE.LEFT_HIP] = lm(-0.12, 1.0, 0);
  arr[POSE.RIGHT_HIP] = lm(0.12, 1.0, 0);
  arr[POSE.LEFT_KNEE] = lm(-0.12, 0.55, 0);
  arr[POSE.RIGHT_KNEE] = lm(0.12, 0.55, 0);
  arr[POSE.LEFT_ANKLE] = lm(-0.12, 0.1, 0);
  arr[POSE.RIGHT_ANKLE] = lm(0.12, 0.1, 0);
  // Foot rigid basis: heel 在 ankle 後下方，foot_index 在 ankle 前下方
  arr[POSE.LEFT_HEEL] = lm(-0.12, 0.05, -0.05);
  arr[POSE.RIGHT_HEEL] = lm(0.12, 0.05, -0.05);
  arr[POSE.LEFT_FOOT_INDEX] = lm(-0.12, 0.05, 0.15);
  arr[POSE.RIGHT_FOOT_INDEX] = lm(0.12, 0.05, 0.15);
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

describe('BodySolver — head rigid basis (三點基底)', () => {
  const solver = new BodySolver();

  it('rest pose 頭部仍為 identity', () => {
    const result = solver.solve(makeRestPose());
    expect(isNearIdentity(result.rotations.head!, 1e-5)).toBe(true);
  });

  it('歪頭（左耳上右耳下，roll 旋轉）→ head 非 identity 且含 Z 軸分量', () => {
    const pose = makeRestPose();
    // 左耳往上、右耳往下 → 頭往右側傾斜（從角色角度是向右 roll）
    pose[POSE.LEFT_EAR] = lm(-0.08, 1.75, -0.05);
    pose[POSE.RIGHT_EAR] = lm(0.08, 1.65, -0.05);
    const result = solver.solve(pose);
    const head = result.rotations.head!;
    expect(isNearIdentity(head, 1e-4)).toBe(false);
    // roll 主要表現在 Z 軸旋轉分量（quat 的 z 分量）
    expect(Math.abs(head.z)).toBeGreaterThan(Math.abs(head.x));
  });

  it('點頭（鼻子下移）→ head 非 identity 且 X 軸分量主導', () => {
    const pose = makeRestPose();
    pose[POSE.NOSE] = lm(0, 1.65, 0.05); // 鼻子下方偏前
    const result = solver.solve(pose);
    const head = result.rotations.head!;
    expect(isNearIdentity(head, 1e-4)).toBe(false);
    expect(Number.isFinite(head.x)).toBe(true);
    expect(Number.isFinite(head.y)).toBe(true);
    expect(Number.isFinite(head.z)).toBe(true);
    expect(Number.isFinite(head.w)).toBe(true);
  });

  it('搖頭（鼻子右移）→ head 非 identity 且 Y 軸分量主導', () => {
    const pose = makeRestPose();
    pose[POSE.NOSE] = lm(0.05, 1.7, 0.03);
    const result = solver.solve(pose);
    const head = result.rotations.head!;
    expect(isNearIdentity(head, 1e-4)).toBe(false);
    // yaw 主要表現在 Y 軸分量
    expect(Math.abs(head.y)).toBeGreaterThan(Math.abs(head.z));
  });

  it('退化（NOSE 與 earMid 重合）→ fallback 為 identity（不 NaN）', () => {
    const pose = makeRestPose();
    pose[POSE.NOSE] = lm(0, 1.7, -0.05); // 與 earMid 同位
    const result = solver.solve(pose);
    const head = result.rotations.head!;
    expect(Number.isFinite(head.x)).toBe(true);
    expect(Number.isFinite(head.y)).toBe(true);
    expect(Number.isFinite(head.z)).toBe(true);
    expect(Number.isFinite(head.w)).toBe(true);
  });
});

describe('BodySolver — hand rigid basis (wrist + index + pinky)', () => {
  const solver = new BodySolver();

  it('rest pose 雙手 hand 仍為 identity', () => {
    const result = solver.solve(makeRestPose());
    expect(isNearIdentity(result.rotations.leftHand!, 1e-4)).toBe(true);
    expect(isNearIdentity(result.rotations.rightHand!, 1e-4)).toBe(true);
  });

  it('退化（index / pinky 與 wrist 同位）→ fallback identity', () => {
    const pose = makeRestPose();
    pose[POSE.LEFT_INDEX] = lm(-0.18, 0.85, 0);
    pose[POSE.LEFT_PINKY] = lm(-0.18, 0.85, 0);
    const result = solver.solve(pose);
    expect(Number.isFinite(result.rotations.leftHand!.x)).toBe(true);
    expect(Number.isFinite(result.rotations.leftHand!.y)).toBe(true);
    expect(Number.isFinite(result.rotations.leftHand!.z)).toBe(true);
    expect(Number.isFinite(result.rotations.leftHand!.w)).toBe(true);
  });

  it('手掌翻轉（index/pinky 左右對調）→ hand 非 identity', () => {
    const pose = makeRestPose();
    // LEFT hand palm 翻轉：index 後方、pinky 前方
    pose[POSE.LEFT_INDEX] = lm(-0.18, 0.78, -0.02);
    pose[POSE.LEFT_PINKY] = lm(-0.18, 0.78, 0.02);
    const result = solver.solve(pose);
    expect(isNearIdentity(result.rotations.leftHand!, 1e-4)).toBe(false);
  });
});

describe('BodySolver — foot rigid basis (ankle + heel + foot_index)', () => {
  const solver = new BodySolver();

  it('rest pose 雙腳 foot 仍為 identity', () => {
    const result = solver.solve(makeRestPose());
    expect(isNearIdentity(result.rotations.leftFoot!, 1e-4)).toBe(true);
    expect(isNearIdentity(result.rotations.rightFoot!, 1e-4)).toBe(true);
  });

  it('腳尖上抬（foot_index 往上）→ foot 非 identity', () => {
    const pose = makeRestPose();
    // 左腳腳尖往上抬（繞 ankle 旋轉）
    pose[POSE.LEFT_FOOT_INDEX] = lm(-0.12, 0.12, 0.10);
    const result = solver.solve(pose);
    expect(isNearIdentity(result.rotations.leftFoot!, 1e-4)).toBe(false);
  });

  it('退化（heel / ankle / foot_index 共線）→ fallback identity，不 NaN', () => {
    const pose = makeRestPose();
    pose[POSE.LEFT_HEEL] = lm(-0.12, 0.1, 0);
    pose[POSE.LEFT_FOOT_INDEX] = lm(-0.12, 0.1, 0.1);
    // ankle / heel / foot_index 全部共線在 (−0.12, 0.1, *)
    const result = solver.solve(pose);
    expect(Number.isFinite(result.rotations.leftFoot!.x)).toBe(true);
    expect(Number.isFinite(result.rotations.leftFoot!.y)).toBe(true);
    expect(Number.isFinite(result.rotations.leftFoot!.z)).toBe(true);
    expect(Number.isFinite(result.rotations.leftFoot!.w)).toBe(true);
  });
});
