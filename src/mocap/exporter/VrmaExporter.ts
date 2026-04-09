/**
 * VRMA 匯出器
 *
 * 將 MocapFrame[] 轉換為 .vrma 檔案的 Uint8Array。
 * .vrma = glTF 2.0 GLB + VRMC_vrm_animation 擴充。
 *
 * 實作策略（Phase 3 MVP）：
 *   - 扁平 node tree（不建骨骼階層）
 *     VRMA 透過 `humanoid.humanBones` 映射 bone → node，不依賴 node 階層，
 *     因此每個 bone 只需一個獨立的 node 物件，大幅簡化輸出結構。
 *   - 支援：rotation channels（每 bone 一組）+ 選擇性的 hips translation channel
 *   - 不支援：blendShape weights（Phase 2c MocapFrame.blendShapes 尚為空；
 *     Phase 4/5 引擎產生表情資料後再補 expressions 擴充欄位）
 *   - 插值：LINEAR（不用 CUBICSPLINE 以減半資料量）
 *
 * VRMA 規格參考：
 *   https://github.com/vrm-c/vrm-specification/tree/master/specification/VRMC_vrm_animation-1.0
 */

import { BufferBuilder, writeGlb } from './gltfWriter';
import type { MocapFrame, VrmHumanBoneName } from '../types';

export interface VrmaExportOptions {
  /** 寫入 asset.generator 的字串（預設為本專案識別字） */
  generator?: string;
  /** 動畫名稱（預設 'mocap'） */
  animationName?: string;
  /**
   * 來源 VRM 的 metaVersion（'0' 或 '1'）
   *
   * 用於處理 VRM 0.x vs 1.0 座標系差異。VRMA 規範期待 quaternion 儲存於
   * 「VRM 1.0 canonical frame」。若來源 VRM 是 0.x，MocapFrame 中的 quat
   * 是在 0.x 座標系的 local bone frame（與 setBoneRotations 直接套用結果一致），
   * exporter 會在寫入前對每個 quat 的 x/z 分量取負（等價於繞 Y 軸 180° 反轉），
   * 這樣 @pixiv/three-vrm-animation 載入時若目標也是 0.x，它會再 flip 一次
   * 剛好抵消；若目標是 1.0，flip 不發生，quat 已經在正確的 canonical frame。
   *
   * 若未提供或為 '1'，不做轉換（預設假設 source 是 1.0 canonical）。
   */
  sourceMetaVersion?: string | null;
}

interface AnimationChannel {
  sampler: number;
  target: { node: number; path: 'rotation' | 'translation' | 'scale' | 'weights' };
}

interface AnimationSampler {
  input: number;
  output: number;
  interpolation: 'LINEAR' | 'STEP' | 'CUBICSPLINE';
}

/**
 * 將 MocapFrame[] 匯出為 .vrma GLB Uint8Array
 *
 * @param frames  要匯出的幀陣列（至少一幀）
 * @param options 可選的 generator / animationName
 * @returns       完整的 .vrma 檔案內容
 */
export function exportMocapToVrma(
  frames: MocapFrame[],
  options: VrmaExportOptions = {},
): Uint8Array {
  if (frames.length === 0) {
    throw new Error('[VrmaExporter] cannot export empty MocapFrame array');
  }

  const t0 = frames[0].timestampMs;
  // VRM 0.x 補償：寫入前對 quat 的 x/z 取負（見 VrmaExportOptions.sourceMetaVersion）
  const needs0xFlip = options.sourceMetaVersion === '0';

  // 1. 蒐集所有出現過的 bone
  const usedBoneSet = new Set<VrmHumanBoneName>();
  for (const frame of frames) {
    for (const name of Object.keys(frame.boneRotations)) {
      usedBoneSet.add(name as VrmHumanBoneName);
    }
  }

  // 2. 若有任何幀帶 **有效的非零** hips 位移，確保 hips bone 被包含
  //
  // 重要：只有 null 檢查不夠——若所有幀 hipsWorldPosition 都是 (0,0,0)，
  // 代表「無 hip 運動」（fixture 產生器常用 (0,0,0) 當佔位符）。
  // 若此時仍輸出 translation channel，會把主視窗的 VRM hips 強制固定在
  // (0,0,0) 世界座標，覆寫 VRM rest pose，並可能觸發 VRMController
  // applyHipSmoothing 的 NaN 邊界條件，導致角色消失（已實測）。
  const hasHipsTranslation = frames.some((f) => {
    const p = f.hipsWorldPosition;
    if (p === null) return false;
    return Math.abs(p.x) > 1e-6 || Math.abs(p.y) > 1e-6 || Math.abs(p.z) > 1e-6;
  });
  if (hasHipsTranslation) {
    usedBoneSet.add('hips');
  }

  if (usedBoneSet.size === 0) {
    throw new Error('[VrmaExporter] no bones found in any frame');
  }

  const usedBones: VrmHumanBoneName[] = Array.from(usedBoneSet);

  // 3. 扁平 node list（每 bone 一個 node）
  const nodes: { name: string }[] = [];
  const boneNameToNodeIdx: Partial<Record<VrmHumanBoneName, number>> = {};
  for (const bone of usedBones) {
    boneNameToNodeIdx[bone] = nodes.length;
    nodes.push({ name: bone });
  }

  // 4. 時間軸（以秒為單位，相對於第一幀）
  const timeArray = new Float32Array(frames.length);
  for (let i = 0; i < frames.length; i++) {
    timeArray[i] = (frames[i].timestampMs - t0) / 1000;
  }

  // 5. 每 bone 的 rotation 陣列（缺幀補 identity）
  const rotationArrays = new Map<VrmHumanBoneName, Float32Array>();
  for (const bone of usedBones) {
    const arr = new Float32Array(frames.length * 4);
    for (let i = 0; i < frames.length; i++) {
      const q = frames[i].boneRotations[bone];
      if (q) {
        arr[i * 4 + 0] = needs0xFlip ? -q.x : q.x;
        arr[i * 4 + 1] = q.y;
        arr[i * 4 + 2] = needs0xFlip ? -q.z : q.z;
        arr[i * 4 + 3] = q.w;
      } else {
        // identity quaternion
        arr[i * 4 + 3] = 1;
      }
    }
    rotationArrays.set(bone, arr);
  }

  // 6. Hips translation 陣列（若有）
  let translationArray: Float32Array | null = null;
  if (hasHipsTranslation) {
    translationArray = new Float32Array(frames.length * 3);
    for (let i = 0; i < frames.length; i++) {
      const pos = frames[i].hipsWorldPosition;
      if (pos) {
        translationArray[i * 3 + 0] = pos.x;
        translationArray[i * 3 + 1] = pos.y;
        translationArray[i * 3 + 2] = pos.z;
      }
    }
  }

  // 7. 組 binary buffer + accessors
  const builder = new BufferBuilder();
  const timeAccessor = builder.addFloat32Array(timeArray, 'SCALAR');

  const rotationAccessors = new Map<VrmHumanBoneName, number>();
  for (const [bone, arr] of rotationArrays) {
    rotationAccessors.set(bone, builder.addFloat32Array(arr, 'VEC4'));
  }

  let translationAccessor: number | null = null;
  if (translationArray) {
    translationAccessor = builder.addFloat32Array(translationArray, 'VEC3');
  }

  // 8. 組 channels + samplers
  const samplers: AnimationSampler[] = [];
  const channels: AnimationChannel[] = [];

  for (const [bone, outAccessor] of rotationAccessors) {
    const samplerIdx = samplers.length;
    samplers.push({
      input: timeAccessor,
      output: outAccessor,
      interpolation: 'LINEAR',
    });
    channels.push({
      sampler: samplerIdx,
      target: {
        node: boneNameToNodeIdx[bone]!,
        path: 'rotation',
      },
    });
  }

  if (translationAccessor !== null) {
    const samplerIdx = samplers.length;
    samplers.push({
      input: timeAccessor,
      output: translationAccessor,
      interpolation: 'LINEAR',
    });
    channels.push({
      sampler: samplerIdx,
      target: {
        node: boneNameToNodeIdx['hips']!,
        path: 'translation',
      },
    });
  }

  // 9. humanBones 映射（VRMA 擴充要求）
  const humanBones: Record<string, { node: number }> = {};
  for (const bone of usedBones) {
    humanBones[bone] = { node: boneNameToNodeIdx[bone]! };
  }

  // 10. 組最終 glTF JSON
  const binary = builder.build();
  const gltfJson = {
    asset: {
      version: '2.0',
      generator: options.generator ?? 'virtual-assistant-desktop mocap exporter',
    },
    extensionsUsed: ['VRMC_vrm_animation'],
    extensions: {
      VRMC_vrm_animation: {
        specVersion: '1.0',
        humanoid: {
          humanBones,
        },
      },
    },
    scene: 0,
    scenes: [{ nodes: usedBones.map((_, i) => i) }],
    nodes,
    animations: [
      {
        name: options.animationName ?? 'mocap',
        channels,
        samplers,
      },
    ],
    accessors: builder.getAccessors(),
    bufferViews: builder.getBufferViews(),
    buffers: [{ byteLength: binary.byteLength }],
  };

  return writeGlb(gltfJson, binary);
}
