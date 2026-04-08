/**
 * 影片動作轉換器 — VRMA 匯出器（GLTFExporter + VRMC_vrm_animation 注入）
 *
 * 依 Phase 0 Spike B 驗證過的方案：
 *   1. 建一個最小 humanoid bone hierarchy 的 THREE.Scene（所有需要的
 *      VRM humanoid bones，以近似 rest 位置放置）
 *   2. 用 GLTFExporter.parseAsync({ binary: true, animations: [clip] })
 *      產出 glb ArrayBuffer
 *   3. 解析 glb container（magic + version + length + JSON chunk + BIN chunk）
 *   4. 把 VRMC_vrm_animation extension JSON 注入到 gltf JSON chunk
 *   5. 重新打包 glb（含 4-byte chunk alignment padding）
 *
 * 對應計畫：video-converter-plan.md 第 2.8 / 5.6 / 第 7 節 Phase 13
 *
 * **限制**：目前只輸出 body bones (hips/spine/chest/upperChest/neck/head/
 * shoulders/arms/legs/feet)，不含手指。Stage 1 預設 enableHands=false，
 * 未來開啟手指追蹤後擴充此處的 HUMANOID_BODY_SPEC 即可。
 */

import * as THREE from 'three';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';
import type { VRMHumanoidBoneName } from '../tracking/boneMapping';

// ─────────────────────────────────────────────────────────
// 內建 humanoid 骨架 spec
// ─────────────────────────────────────────────────────────

interface BoneSpec {
  name: VRMHumanoidBoneName;
  parent: VRMHumanoidBoneName | null;
  /** 相對 parent 的粗略 rest position（只需非零，具體數值不影響 VRMA 套用到其他 VRM 模型） */
  restPos: [number, number, number];
}

const HUMANOID_BODY_SPEC: readonly BoneSpec[] = [
  { name: 'hips', parent: null, restPos: [0, 1.0, 0] },
  { name: 'spine', parent: 'hips', restPos: [0, 0.1, 0] },
  { name: 'chest', parent: 'spine', restPos: [0, 0.15, 0] },
  { name: 'upperChest', parent: 'chest', restPos: [0, 0.1, 0] },
  { name: 'neck', parent: 'upperChest', restPos: [0, 0.15, 0] },
  { name: 'head', parent: 'neck', restPos: [0, 0.1, 0] },

  { name: 'leftShoulder', parent: 'upperChest', restPos: [0.1, 0.1, 0] },
  { name: 'leftUpperArm', parent: 'leftShoulder', restPos: [0.08, 0, 0] },
  { name: 'leftLowerArm', parent: 'leftUpperArm', restPos: [0.25, 0, 0] },
  { name: 'leftHand', parent: 'leftLowerArm', restPos: [0.25, 0, 0] },

  { name: 'rightShoulder', parent: 'upperChest', restPos: [-0.1, 0.1, 0] },
  { name: 'rightUpperArm', parent: 'rightShoulder', restPos: [-0.08, 0, 0] },
  { name: 'rightLowerArm', parent: 'rightUpperArm', restPos: [-0.25, 0, 0] },
  { name: 'rightHand', parent: 'rightLowerArm', restPos: [-0.25, 0, 0] },

  { name: 'leftUpperLeg', parent: 'hips', restPos: [0.08, -0.05, 0] },
  { name: 'leftLowerLeg', parent: 'leftUpperLeg', restPos: [0, -0.4, 0] },
  { name: 'leftFoot', parent: 'leftLowerLeg', restPos: [0, -0.4, 0] },

  { name: 'rightUpperLeg', parent: 'hips', restPos: [-0.08, -0.05, 0] },
  { name: 'rightLowerLeg', parent: 'rightUpperLeg', restPos: [0, -0.4, 0] },
  { name: 'rightFoot', parent: 'rightLowerLeg', restPos: [0, -0.4, 0] },
];

const HUMANOID_BODY_NAMES = new Set<string>(HUMANOID_BODY_SPEC.map((s) => s.name));

// ─────────────────────────────────────────────────────────
// glb container helpers
// ─────────────────────────────────────────────────────────

const GLB_MAGIC = 0x46546c67; // 'glTF'
const GLB_VERSION = 2;
const CHUNK_TYPE_JSON = 0x4e4f534a;
const CHUNK_TYPE_BIN = 0x004e4942;

export interface GlbChunks {
  jsonBytes: Uint8Array;
  binBytes: Uint8Array | null;
}

/** 解析 glb container 取出 JSON chunk 與 BIN chunk */
export function parseGlbContainer(buf: ArrayBuffer): GlbChunks {
  const dv = new DataView(buf);
  const magic = dv.getUint32(0, true);
  const version = dv.getUint32(4, true);
  const length = dv.getUint32(8, true);
  if (magic !== GLB_MAGIC) throw new Error(`Not a glb file (magic=0x${magic.toString(16)})`);
  if (version !== GLB_VERSION) throw new Error(`Unsupported glb version: ${version}`);
  if (length !== buf.byteLength) {
    throw new Error(`glb length field ${length} != actual ${buf.byteLength}`);
  }

  let offset = 12;
  let jsonBytes: Uint8Array | null = null;
  let binBytes: Uint8Array | null = null;

  while (offset < length) {
    const chunkLen = dv.getUint32(offset, true);
    const chunkType = dv.getUint32(offset + 4, true);
    const chunkData = new Uint8Array(buf, offset + 8, chunkLen);
    if (chunkType === CHUNK_TYPE_JSON) {
      jsonBytes = chunkData;
    } else if (chunkType === CHUNK_TYPE_BIN) {
      binBytes = chunkData;
    }
    offset += 8 + chunkLen;
  }

  if (!jsonBytes) throw new Error('glb missing JSON chunk');
  return { jsonBytes, binBytes };
}

function padTo4(bytes: Uint8Array, padByte: number): Uint8Array {
  const remainder = bytes.byteLength % 4;
  if (remainder === 0) return bytes;
  const padLen = 4 - remainder;
  const padded = new Uint8Array(bytes.byteLength + padLen);
  padded.set(bytes);
  for (let i = bytes.byteLength; i < padded.byteLength; i++) {
    padded[i] = padByte;
  }
  return padded;
}

/** 重新打包 glb container（JSON chunk 以 0x20 空白 padding、BIN chunk 以 0x00 padding） */
export function repackGlb(jsonBytes: Uint8Array, binBytes: Uint8Array | null): ArrayBuffer {
  const paddedJson = padTo4(jsonBytes, 0x20);
  const paddedBin = binBytes ? padTo4(binBytes, 0x00) : null;

  const jsonChunkSize = 8 + paddedJson.byteLength;
  const binChunkSize = paddedBin ? 8 + paddedBin.byteLength : 0;
  const totalSize = 12 + jsonChunkSize + binChunkSize;

  const out = new ArrayBuffer(totalSize);
  const dv = new DataView(out);
  const u8 = new Uint8Array(out);

  dv.setUint32(0, GLB_MAGIC, true);
  dv.setUint32(4, GLB_VERSION, true);
  dv.setUint32(8, totalSize, true);

  dv.setUint32(12, paddedJson.byteLength, true);
  dv.setUint32(16, CHUNK_TYPE_JSON, true);
  u8.set(paddedJson, 20);

  if (paddedBin) {
    const binOffset = 20 + paddedJson.byteLength;
    dv.setUint32(binOffset, paddedBin.byteLength, true);
    dv.setUint32(binOffset + 4, CHUNK_TYPE_BIN, true);
    u8.set(paddedBin, binOffset + 8);
  }

  return out;
}

// ─────────────────────────────────────────────────────────
// VrmaExporter
// ─────────────────────────────────────────────────────────

export interface VrmaExportOptions {
  specVersion?: string;
}

const DEFAULT_OPTIONS: Required<VrmaExportOptions> = {
  specVersion: '1.0',
};

export class VrmaExporter {
  /**
   * 匯出 AnimationClip 為 .vrma 二進位 ArrayBuffer。
   *
   * @param clip THREE.AnimationClip（通常由 BufferToClip 從 CaptureBufferData 產出）
   * @param opts 匯出選項（specVersion）
   */
  async export(
    clip: THREE.AnimationClip,
    opts: VrmaExportOptions = {}
  ): Promise<ArrayBuffer> {
    const finalOpts = { ...DEFAULT_OPTIONS, ...opts };

    // 1. 建 humanoid scene
    const scene = this.buildHumanoidScene();

    // 2. GLTFExporter → glb
    const exporter = new GLTFExporter();
    const result = await exporter.parseAsync(scene, {
      binary: true,
      animations: [clip],
      trs: true,
      onlyVisible: false,
      embedImages: false,
    });
    if (!(result instanceof ArrayBuffer)) {
      throw new Error('GLTFExporter returned non-ArrayBuffer (binary mode expected)');
    }

    // 3. 注入 VRMC_vrm_animation extension
    return this.injectVrmAnimationExtension(result, finalOpts.specVersion);
  }

  /** 建最小 humanoid bone scene（內部用） */
  private buildHumanoidScene(): THREE.Scene {
    const scene = new THREE.Scene();
    const bones = new Map<VRMHumanoidBoneName, THREE.Bone>();

    for (const spec of HUMANOID_BODY_SPEC) {
      const bone = new THREE.Bone();
      bone.name = spec.name;
      bone.position.set(spec.restPos[0], spec.restPos[1], spec.restPos[2]);
      bones.set(spec.name, bone);
    }

    for (const spec of HUMANOID_BODY_SPEC) {
      const bone = bones.get(spec.name)!;
      if (spec.parent) {
        bones.get(spec.parent)!.add(bone);
      }
    }

    const hips = bones.get('hips')!;
    scene.add(hips);

    // 確保 THREE.Scene updateMatrix，GLTFExporter 需要矩陣資訊
    scene.updateMatrixWorld(true);
    return scene;
  }

  /** 注入 VRMC_vrm_animation extension 到 glb 的 JSON chunk */
  private injectVrmAnimationExtension(glb: ArrayBuffer, specVersion: string): ArrayBuffer {
    const { jsonBytes, binBytes } = parseGlbContainer(glb);

    const jsonText = new TextDecoder('utf-8').decode(jsonBytes);
    const gltf = JSON.parse(jsonText) as {
      extensionsUsed?: string[];
      extensions?: Record<string, unknown>;
      nodes?: Array<{ name?: string }>;
    };

    // 建 boneName → node index map
    const humanBones: Record<string, { node: number }> = {};
    gltf.nodes?.forEach((node, idx) => {
      if (node.name && HUMANOID_BODY_NAMES.has(node.name)) {
        humanBones[node.name] = { node: idx };
      }
    });

    // 注入 extension
    gltf.extensionsUsed = Array.from(
      new Set([...(gltf.extensionsUsed ?? []), 'VRMC_vrm_animation'])
    );
    gltf.extensions = gltf.extensions ?? {};
    gltf.extensions.VRMC_vrm_animation = {
      specVersion,
      humanoid: { humanBones },
    };

    const newJsonBytes = new TextEncoder().encode(JSON.stringify(gltf));
    return repackGlb(newJsonBytes, binBytes);
  }
}
