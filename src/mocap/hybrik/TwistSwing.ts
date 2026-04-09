/**
 * Twist-Swing 四元數工具（Phase 5b HybrIK-TS）
 *
 * 提供：
 *   - swingFromTo(u, v)：計算把單位向量 u 旋轉到單位向量 v 的最短弧 quaternion
 *   - decomposeTwistSwing(q, axis)：把四元數 q 分解為繞 axis 的 twist 與正交的 swing
 *   - rotationFromTwoAxes(restA, restB, targetA, targetB)：由兩組方向對擬合完整旋轉，
 *     解決單軸 swing 無法決定 twist 的問題
 *
 * 純數學模組，只依賴 three.js 的 Quaternion / Vector3。不依賴 DOM / VRM / MediaPipe。
 *
 * HybrIK 論文原版需要神經網路預測 twist 角度；本 TS port 使用：
 *   - 葉節點 / 單子節點：swingFromTo（zero-twist 近似）
 *   - 多子節點 joint（pelvis, spine3）：rotationFromTwoAxes（從兩組子方向解出 twist）
 * 這對整體 pose 方向足以使用，但細節 twist（例如手掌朝向）會與原動作略有差異。
 */

import * as THREE from 'three';

const EPSILON = 1e-8;
const NEAR_ONE = 1 - 1e-6;
const NEAR_NEG_ONE = -1 + 1e-6;

/** 暫存 Vector3，避免 hot path 反覆 new */
const tmpA = new THREE.Vector3();
const tmpB = new THREE.Vector3();
const tmpC = new THREE.Vector3();

/**
 * 計算把單位向量 `u` 旋轉到單位向量 `v` 的最短弧 quaternion
 *
 * 兩向量可以不是單位長度，會自動 normalize。
 * 退化情況：
 *   - u ≈ v：回傳 identity quaternion
 *   - u ≈ -v：回傳繞任一正交軸的 180° 旋轉
 *   - u 或 v 近零：回傳 identity 並 log 警告
 *
 * @param u   源方向
 * @param v   目標方向
 * @param out 結果寫入此 quaternion（避免 GC）；未提供則建立新 instance
 */
export function swingFromTo(
  u: THREE.Vector3,
  v: THREE.Vector3,
  out: THREE.Quaternion = new THREE.Quaternion(),
): THREE.Quaternion {
  const uLen = u.length();
  const vLen = v.length();
  if (uLen < EPSILON || vLen < EPSILON) {
    out.set(0, 0, 0, 1);
    return out;
  }

  tmpA.copy(u).divideScalar(uLen);
  tmpB.copy(v).divideScalar(vLen);
  const dot = tmpA.dot(tmpB);

  if (dot > NEAR_ONE) {
    // 已對齊 → identity
    out.set(0, 0, 0, 1);
    return out;
  }

  if (dot < NEAR_NEG_ONE) {
    // 180° 反向 → 找任一與 u 正交的軸
    // 選與 tmpA 分量最小的座標軸做叉積
    const ax = Math.abs(tmpA.x);
    const ay = Math.abs(tmpA.y);
    const az = Math.abs(tmpA.z);
    if (ax <= ay && ax <= az) {
      tmpC.set(1, 0, 0);
    } else if (ay <= az) {
      tmpC.set(0, 1, 0);
    } else {
      tmpC.set(0, 0, 1);
    }
    tmpC.cross(tmpA).normalize();
    out.set(tmpC.x, tmpC.y, tmpC.z, 0); // 180° 繞 tmpC
    return out;
  }

  // 一般情況：axis = u × v，angle 由 cos^{-1}(dot) 推得
  // 使用 Stan Melax 的半角技巧避免 acos：q = normalize( (u×v, |u||v| + u·v) )
  tmpC.crossVectors(tmpA, tmpB);
  out.set(tmpC.x, tmpC.y, tmpC.z, 1 + dot);
  out.normalize();
  return out;
}

/**
 * 將四元數 q 分解為繞給定 twist 軸的 twist 旋轉 × 正交 swing 旋轉
 *
 * 公式（swing-twist decomposition）：
 *   twist = normalize( (proj(q.xyz, axis), q.w) )
 *   swing = q * twist^{-1}
 *   → q = swing * twist
 *
 * 其中 proj(v, axis) = (v · axis) * axis。
 *
 * @param q     輸入 quaternion（不會被修改）
 * @param axis  單位 twist 軸（通常是骨骼 local +Y）
 * @param outTwist / outSwing 結果寫入（避免 GC）
 */
export function decomposeTwistSwing(
  q: THREE.Quaternion,
  axis: THREE.Vector3,
  outTwist: THREE.Quaternion = new THREE.Quaternion(),
  outSwing: THREE.Quaternion = new THREE.Quaternion(),
): { twist: THREE.Quaternion; swing: THREE.Quaternion } {
  // proj(q.xyz, axis) = (q.xyz · axis) * axis
  const d = q.x * axis.x + q.y * axis.y + q.z * axis.z;
  let tx = axis.x * d;
  let ty = axis.y * d;
  let tz = axis.z * d;
  let tw = q.w;

  // normalize twist（當 q ≈ identity 且 axis 任意時可能趨近零，保險處理）
  const tLen = Math.sqrt(tx * tx + ty * ty + tz * tz + tw * tw);
  if (tLen < EPSILON) {
    outTwist.set(0, 0, 0, 1);
  } else {
    tx /= tLen;
    ty /= tLen;
    tz /= tLen;
    tw /= tLen;
    outTwist.set(tx, ty, tz, tw);
  }

  // swing = q * twist^{-1}
  outSwing.copy(outTwist).invert().premultiply(q);
  return { twist: outTwist, swing: outSwing };
}

/**
 * 由兩組「方向對」擬合一個旋轉 quaternion
 *
 * 求 R 使得：
 *   R · restA_hat ≈ targetA_hat   （primary 方向精確對齊）
 *   R · restB_hat ≈ targetB_hat   （secondary 方向盡量對齊）
 *
 * 做法：
 *   1. 構造 rest 正交基 (a, b', c) 其中 b' 是 restB 對 a 的正交化
 *   2. 同樣構造 target 正交基 (A, B', C)
 *   3. R = [A B' C] · [a b' c]^T
 *
 * 退化處理：
 *   - restA/targetA 近零 → 回傳 identity
 *   - restB 與 restA 共線（叉積近零） → 退化為 swingFromTo(restA, targetA)
 *
 * @param out 結果寫入此 quaternion
 */
export function rotationFromTwoAxes(
  restA: THREE.Vector3,
  restB: THREE.Vector3,
  targetA: THREE.Vector3,
  targetB: THREE.Vector3,
  out: THREE.Quaternion = new THREE.Quaternion(),
): THREE.Quaternion {
  const aLen = restA.length();
  const ALen = targetA.length();
  if (aLen < EPSILON || ALen < EPSILON) {
    out.set(0, 0, 0, 1);
    return out;
  }

  // Rest basis
  const a = new THREE.Vector3().copy(restA).divideScalar(aLen);
  const bRaw = new THREE.Vector3().copy(restB);
  const bDotA = bRaw.dot(a);
  const bProj = new THREE.Vector3().copy(a).multiplyScalar(bDotA);
  const b = bRaw.sub(bProj);
  if (b.lengthSq() < EPSILON) {
    // restB 與 restA 共線 → 退化到單軸 swing
    return swingFromTo(restA, targetA, out);
  }
  b.normalize();
  const c = new THREE.Vector3().crossVectors(a, b);

  // Target basis
  const A = new THREE.Vector3().copy(targetA).divideScalar(ALen);
  const BRaw = new THREE.Vector3().copy(targetB);
  const BDotA = BRaw.dot(A);
  const BProj = new THREE.Vector3().copy(A).multiplyScalar(BDotA);
  const B = BRaw.sub(BProj);
  if (B.lengthSq() < EPSILON) {
    // targetB 與 targetA 共線 → 退化到單軸 swing
    return swingFromTo(restA, targetA, out);
  }
  B.normalize();
  const C = new THREE.Vector3().crossVectors(A, B);

  // R = [A B C] · [a b c]^T
  // 列式展開：R.col(i) = A * a_i + B * b_i + C * c_i
  // 展開 3x3 matrix 元素：
  const m00 = A.x * a.x + B.x * b.x + C.x * c.x;
  const m01 = A.x * a.y + B.x * b.y + C.x * c.y;
  const m02 = A.x * a.z + B.x * b.z + C.x * c.z;
  const m10 = A.y * a.x + B.y * b.x + C.y * c.x;
  const m11 = A.y * a.y + B.y * b.y + C.y * c.y;
  const m12 = A.y * a.z + B.y * b.z + C.y * c.z;
  const m20 = A.z * a.x + B.z * b.x + C.z * c.x;
  const m21 = A.z * a.y + B.z * b.y + C.z * c.y;
  const m22 = A.z * a.z + B.z * b.z + C.z * c.z;

  // Matrix4 → quaternion（Three.js 的 Matrix4 是 column-major，但 elements 按列填）
  const m = new THREE.Matrix4();
  m.set(
    m00, m01, m02, 0,
    m10, m11, m12, 0,
    m20, m21, m22, 0,
    0, 0, 0, 1,
  );
  out.setFromRotationMatrix(m);
  return out;
}
