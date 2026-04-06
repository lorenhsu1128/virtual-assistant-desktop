import * as THREE from 'three';

/**
 * VRM 人形骨骼的 bone name ↔ node name 雙向映射
 *
 * 由 VRMController.getHumanoidBoneMapping() 提供，
 * 避免 AnimationMirror 直接依賴 @pixiv/three-vrm。
 */
export interface BoneMapping {
  /** node.name → VRM bone name */
  nodeNameToBone: Map<string, string>;
  /** VRM bone name → node.name */
  boneToNodeName: Map<string, string>;
}

/**
 * VRM 1.0 左右配對骨骼（24 pairs）
 *
 * 鏡像時互相交換 track 數據 + 套用 quaternion mirror。
 */
const PAIRED_BONES: readonly [string, string][] = [
  // Legs
  ['leftUpperLeg', 'rightUpperLeg'],
  ['leftLowerLeg', 'rightLowerLeg'],
  ['leftFoot', 'rightFoot'],
  ['leftToes', 'rightToes'],
  // Arms
  ['leftShoulder', 'rightShoulder'],
  ['leftUpperArm', 'rightUpperArm'],
  ['leftLowerArm', 'rightLowerArm'],
  ['leftHand', 'rightHand'],
  // Fingers — Thumb
  ['leftThumbMetacarpal', 'rightThumbMetacarpal'],
  ['leftThumbProximal', 'rightThumbProximal'],
  ['leftThumbDistal', 'rightThumbDistal'],
  // Fingers — Index
  ['leftIndexProximal', 'rightIndexProximal'],
  ['leftIndexIntermediate', 'rightIndexIntermediate'],
  ['leftIndexDistal', 'rightIndexDistal'],
  // Fingers — Middle
  ['leftMiddleProximal', 'rightMiddleProximal'],
  ['leftMiddleIntermediate', 'rightMiddleIntermediate'],
  ['leftMiddleDistal', 'rightMiddleDistal'],
  // Fingers — Ring
  ['leftRingProximal', 'rightRingProximal'],
  ['leftRingIntermediate', 'rightRingIntermediate'],
  ['leftRingDistal', 'rightRingDistal'],
  // Fingers — Little
  ['leftLittleProximal', 'rightLittleProximal'],
  ['leftLittleIntermediate', 'rightLittleIntermediate'],
  ['leftLittleDistal', 'rightLittleDistal'],
  // Eyes
  ['leftEye', 'rightEye'],
];

/**
 * VRM 1.0 中軸骨骼（7 bones）
 *
 * 鏡像時僅套用 quaternion/translation mirror，不做 swap。
 */
const CENTER_BONES: readonly string[] = [
  'hips', 'spine', 'chest', 'upperChest', 'neck', 'head', 'jaw',
];

/**
 * In-place 鏡像四元數值（YZ 平面反射）
 *
 * (x, y, z, w) → (x, -y, -z, w)
 *
 * 推導：反射將旋轉軸 (ax,ay,az)→(-ax,ay,az) 並反轉角度 θ→-θ，
 * 代入四元數公式得 x 不變、y/z 取反、w 不變。
 */
function mirrorQuaternionValues(values: Float32Array): void {
  for (let i = 0; i < values.length; i += 4) {
    // values[i]     = x (keep)
    values[i + 1] = -values[i + 1]; // y → -y
    values[i + 2] = -values[i + 2]; // z → -z
    // values[i + 3] = w (keep)
  }
}

/**
 * In-place 鏡像位移值（YZ 平面反射）
 *
 * (x, y, z) → (-x, y, z)
 */
function mirrorTranslationValues(values: Float32Array): void {
  for (let i = 0; i < values.length; i += 3) {
    values[i] = -values[i]; // x → -x
    // values[i + 1] = y (keep)
    // values[i + 2] = z (keep)
  }
}

/**
 * 從 track name 解析 node name 和 property
 *
 * Three.js track name 格式: `{nodeName}.{property}`
 * 其中 nodeName 可含 `|`（GLTF 節點名稱），property 為 quaternion/position 等。
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
 * 產生 AnimationClip 的 YZ 平面鏡像版本
 *
 * 適用於 VRM 1.0 humanoid 動畫。所有操作在記憶體中完成，
 * 原始 clip 不會被修改。
 *
 * 演算法：
 * 1. 配對骨骼（Left ↔ Right）：交換 track 數據（不修改數值）
 *    — VRM normalized bones 本地座標系已對稱，swap 即產生正確鏡像
 * 2. 中軸骨骼：quaternion mirror (x,-y,-z,w)
 * 3. Hips translation：negate X
 * 4. Expression / unknown tracks：保持不變
 *
 * @param clip 原始 AnimationClip
 * @param boneMapping VRM bone name ↔ node name 映射
 * @returns 鏡像後的新 AnimationClip
 */
export function mirrorAnimationClip(
  clip: THREE.AnimationClip,
  boneMapping: BoneMapping,
): THREE.AnimationClip {
  // ── 建立原始 track 數據快照（避免 swap 時互相覆蓋） ──
  const originalData = new Map<string, { times: Float32Array; values: Float32Array }>();
  for (const track of clip.tracks) {
    originalData.set(track.name, {
      times: track.times,
      values: track.values,
    });
  }

  // ── 建立 node name 交換對照表（paired bones） ──
  const nodeSwapMap = new Map<string, string>();
  for (const [leftBone, rightBone] of PAIRED_BONES) {
    const leftNode = boneMapping.boneToNodeName.get(leftBone);
    const rightNode = boneMapping.boneToNodeName.get(rightBone);
    if (leftNode && rightNode) {
      nodeSwapMap.set(leftNode, rightNode);
      nodeSwapMap.set(rightNode, leftNode);
    }
  }

  // ── 建立 center bone node name set ──
  const centerNodeNames = new Set<string>();
  for (const bone of CENTER_BONES) {
    const nodeName = boneMapping.boneToNodeName.get(bone);
    if (nodeName) {
      centerNodeNames.add(nodeName);
    }
  }

  // ── Clone clip，逐 track 處理 ──
  const mirrored = clip.clone();
  const newTracks: THREE.KeyframeTrack[] = [];
  const processed = new Set<string>();

  for (const track of mirrored.tracks) {
    if (processed.has(track.name)) continue;

    const { nodeName, property } = parseTrackName(track.name);
    const boneName = boneMapping.nodeNameToBone.get(nodeName);

    // ── 非骨骼 track（expression 等）→ 不處理 ──
    if (!boneName) {
      newTracks.push(track);
      processed.add(track.name);
      continue;
    }

    const pairedNodeName = nodeSwapMap.get(nodeName);

    if (pairedNodeName) {
      // ── 配對骨骼：swap only ──
      // VRM normalized bones 的本地座標系已經是鏡像對稱的，
      // 相同的 local rotation 在左右配對骨骼上自然產生鏡像視覺效果，
      // 因此只需交換數據，不需要額外的 quaternion mirror。
      const pairedTrackName = `${pairedNodeName}.${property}`;
      const pairedOriginal = originalData.get(pairedTrackName);

      if (pairedOriginal && !processed.has(pairedTrackName)) {
        // 雙側都有 track：交叉複製（不修改數值）
        const thisOriginal = originalData.get(track.name)!;

        // 此 track ← 對側原始數據（deep copy）
        track.times = new Float32Array(pairedOriginal.times);
        track.values = new Float32Array(pairedOriginal.values);

        // 對側 track ← 此側原始數據（deep copy）
        const pairedTrack = mirrored.tracks.find((t) => t.name === pairedTrackName);
        if (pairedTrack) {
          pairedTrack.times = new Float32Array(thisOriginal.times);
          pairedTrack.values = new Float32Array(thisOriginal.values);

          newTracks.push(track);
          newTracks.push(pairedTrack);
          processed.add(track.name);
          processed.add(pairedTrackName);
        }
      } else if (!pairedOriginal) {
        // 只有單側有 track：搬到對側（不修改數值）
        track.name = pairedTrackName;
        track.times = new Float32Array(track.times);
        track.values = new Float32Array(track.values);

        newTracks.push(track);
        processed.add(track.name);
      }
      // 如果 pairedOriginal 存在但 processed 已包含 pairedTrackName，
      // 代表已由對側的迭代處理過，跳過

    } else if (centerNodeNames.has(nodeName)) {
      // ── 中軸骨骼：mirror only ──
      track.values = new Float32Array(track.values);

      if (property === 'quaternion') {
        mirrorQuaternionValues(track.values);
      } else if (property === 'position') {
        mirrorTranslationValues(track.values);
      }

      newTracks.push(track);
      processed.add(track.name);

    } else {
      // ── 其他骨骼 / 未知 → 保持不變 ──
      newTracks.push(track);
      processed.add(track.name);
    }
  }

  // ── 處理只存在於對側的 paired tracks（原始 clip 有 rightHand 但無 leftHand） ──
  // 上面的迴圈只遍歷 mirrored.tracks（= clone 的 tracks），
  // 如果原始 clip 缺某側，clone 也缺，所以不需額外處理。
  // 單側情況已在 `!pairedOriginal` 分支搬移。

  mirrored.tracks = newTracks;
  mirrored.resetDuration();
  return mirrored;
}
