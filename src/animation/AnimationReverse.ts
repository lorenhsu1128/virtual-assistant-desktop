import * as THREE from 'three';
import type { BoneMapping } from './AnimationMirror';

/**
 * VRM humanoid 動畫的 Y 軸 180° 旋轉版本
 *
 * 用途：由 opendoor clip 生成 enterdoor clip。opendoor 是角色面向鏡頭從門內走出，
 * 套用 Y 軸 180° 旋轉後，hip translation 反轉，hip orientation 翻轉 180°，
 * 整個上半身（含子骨骼）跟著旋轉 → 角色背對鏡頭走入門內。
 *
 * 與 `mirrorAnimationClip`（YZ 平面反射 = 負 X）的差異：
 * - AnimationMirror 做的是左右鏡像（X 軸反射），需要 swap 左右配對骨骼
 * - AnimationReverse 做的是 Y 軸 180° 旋轉，不需要 swap 任何骨骼，
 *   因為 Y 旋轉對左右對稱的動作不影響左右手/腳的身份
 *
 * 演算法：
 * 1. Hips position track (x, y, z) → (-x, y, -z)
 *    （Y 軸 180° 旋轉對向量的作用：x → -x, y → y, z → -z）
 * 2. Hips quaternion track：pre-multiply by q_rotY(π) = (0, 1, 0, 0)
 *    Hamilton 四元數乘法推導：(x, y, z, w) → (z, w, -x, -y)
 * 3. 其他骨骼的所有 track：不動
 *    （父子階層中 hip 旋轉後，子骨骼的相對 transform 自動跟著旋轉）
 */

/** Hip quaternion 四元數值 in-place 套用 Y 軸 180° 前乘 */
function rotateHipsQuaternionValues(values: Float32Array): void {
  for (let i = 0; i < values.length; i += 4) {
    const x = values[i];
    const y = values[i + 1];
    const z = values[i + 2];
    const w = values[i + 3];
    // q_new = (0, 1, 0, 0) * (x, y, z, w) = (z, w, -x, -y)
    values[i] = z;
    values[i + 1] = w;
    values[i + 2] = -x;
    values[i + 3] = -y;
  }
}

/** Hip position 三元數值 in-place 套用 Y 軸 180° 旋轉 */
function rotateHipsPositionValues(values: Float32Array): void {
  for (let i = 0; i < values.length; i += 3) {
    values[i] = -values[i]; // x → -x
    // values[i + 1] = y (keep)
    values[i + 2] = -values[i + 2]; // z → -z
  }
}

/**
 * 從 track name 解析 node name 和 property
 *
 * Three.js track name 格式：`{nodeName}.{property}`
 */
function parseTrackName(trackName: string): { nodeName: string; property: string } {
  const lastDot = trackName.lastIndexOf('.');
  if (lastDot === -1) {
    return { nodeName: trackName, property: '' };
  }
  return {
    nodeName: trackName.substring(0, lastDot),
    property: trackName.substring(lastDot + 1),
  };
}

/**
 * 產生 opendoor → enterdoor 的反向 clip
 *
 * 原始 clip 不會被修改，回傳新的 AnimationClip instance。
 * 新 clip 的 name 加上 `:reversed` 後綴以利 debug / 辨識（避免
 * 與原 clip 共用同一 mixer action instance，見 LESSONS.md [2026-04-09]）。
 *
 * @param clip 原始 opendoor AnimationClip
 * @param boneMapping VRM bone name ↔ node name 映射（由 VRMController.getHumanoidBoneMapping() 提供）
 * @returns 反向後的新 AnimationClip
 */
export function reverseAnimationClipForEnterdoor(
  clip: THREE.AnimationClip,
  boneMapping: BoneMapping,
): THREE.AnimationClip {
  const hipsNodeName = boneMapping.boneToNodeName.get('hips');
  if (!hipsNodeName) {
    console.warn('[AnimationReverse] hips node not found in bone mapping, returning clip as-is');
    return clip.clone();
  }

  const reversed = clip.clone();
  reversed.name = `${clip.name}:reversed`;

  const hipsPositionTrackName = `${hipsNodeName}.position`;
  const hipsQuaternionTrackName = `${hipsNodeName}.quaternion`;

  for (const track of reversed.tracks) {
    const { nodeName, property } = parseTrackName(track.name);
    if (nodeName !== hipsNodeName) continue;

    // Deep copy values 再變換，避免汙染原 clip 的 Float32Array
    if (track.name === hipsPositionTrackName && property === 'position') {
      track.values = new Float32Array(track.values);
      rotateHipsPositionValues(track.values);
    } else if (track.name === hipsQuaternionTrackName && property === 'quaternion') {
      track.values = new Float32Array(track.values);
      rotateHipsQuaternionValues(track.values);
    }
  }

  return reversed;
}
