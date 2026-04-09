/**
 * glTF 2.0 GLB 低階寫入器
 *
 * 負責組裝 GLB 二進位容器（header + JSON chunk + BIN chunk）。
 * 不知道 VRMA 格式細節，只處理純 glTF 2.0 的容器結構。
 * 由 VrmaExporter 呼叫。
 *
 * GLB 格式參考：https://registry.khronos.org/glTF/specs/2.0/glTF-2.0.html#binary-gltf-layout
 */

export type GltfAccessorType = 'SCALAR' | 'VEC3' | 'VEC4';

const COMPONENT_COUNT: Record<GltfAccessorType, number> = {
  SCALAR: 1,
  VEC3: 3,
  VEC4: 4,
};

/** glTF accessor（描述 binary 資料的型別、筆數、統計值） */
export interface GltfAccessor {
  bufferView: number;
  byteOffset?: number;
  componentType: number; // 5126 = FLOAT
  count: number;
  type: GltfAccessorType;
  min?: number[];
  max?: number[];
}

/** glTF bufferView（指向 binary buffer 的一個片段） */
export interface GltfBufferView {
  buffer: number;
  byteOffset: number;
  byteLength: number;
}

/**
 * BufferBuilder — 累積多個 Float32Array 到單一 binary buffer
 *
 * 使用流程：
 *   1. 對每個資料源呼叫 addFloat32Array → 回傳 accessor index
 *   2. 呼叫 build() 取得完整 binary
 *   3. 呼叫 getAccessors() / getBufferViews() 取得描述子
 *
 * Float32 自帶 4-byte alignment，bufferView 之間不需要額外 padding。
 */
export class BufferBuilder {
  private chunks: Uint8Array[] = [];
  private accessors: GltfAccessor[] = [];
  private bufferViews: GltfBufferView[] = [];
  private currentByteLength = 0;

  /**
   * 新增一個 Float32 陣列為新的 accessor + bufferView
   *
   * @param data  Float32Array 資料（長度必須能被 type 的分量數整除）
   * @param type  'SCALAR' | 'VEC3' | 'VEC4'
   * @returns     新增的 accessor index
   */
  addFloat32Array(data: Float32Array, type: GltfAccessorType): number {
    const numComponents = COMPONENT_COUNT[type];
    if (data.length % numComponents !== 0) {
      throw new Error(
        `[BufferBuilder] data.length ${data.length} not divisible by ${numComponents} for type ${type}`,
      );
    }
    const count = data.length / numComponents;

    const byteLength = data.byteLength;
    const byteOffset = this.currentByteLength;

    // 將 Float32Array view 轉為 Uint8Array view（不複製資料）
    this.chunks.push(new Uint8Array(data.buffer, data.byteOffset, byteLength));
    this.currentByteLength += byteLength;

    const bufferViewIndex = this.bufferViews.length;
    this.bufferViews.push({
      buffer: 0,
      byteOffset,
      byteLength,
    });

    const { min, max } = computeMinMax(data, numComponents);

    const accessorIndex = this.accessors.length;
    this.accessors.push({
      bufferView: bufferViewIndex,
      componentType: 5126, // FLOAT
      count,
      type,
      min,
      max,
    });

    return accessorIndex;
  }

  /** 組合所有 chunks 為單一 Uint8Array */
  build(): Uint8Array {
    const total = new Uint8Array(this.currentByteLength);
    let offset = 0;
    for (const chunk of this.chunks) {
      total.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return total;
  }

  getAccessors(): GltfAccessor[] {
    return this.accessors;
  }

  getBufferViews(): GltfBufferView[] {
    return this.bufferViews;
  }

  getTotalByteLength(): number {
    return this.currentByteLength;
  }
}

/** 計算 Float32 資料的分量 min/max（用於 accessor 描述） */
function computeMinMax(
  data: Float32Array,
  numComponents: number,
): { min: number[]; max: number[] } {
  if (data.length === 0) {
    return {
      min: new Array(numComponents).fill(0),
      max: new Array(numComponents).fill(0),
    };
  }
  const min = new Array<number>(numComponents).fill(Number.POSITIVE_INFINITY);
  const max = new Array<number>(numComponents).fill(Number.NEGATIVE_INFINITY);
  for (let i = 0; i < data.length; i += numComponents) {
    for (let c = 0; c < numComponents; c++) {
      const v = data[i + c];
      if (v < min[c]) min[c] = v;
      if (v > max[c]) max[c] = v;
    }
  }
  return { min, max };
}

// ── GLB 常數 ──
const GLB_MAGIC = 0x46546c67; // 'glTF' (little-endian: 0x46 0x54 0x6c 0x67)
const GLB_VERSION = 2;
const CHUNK_TYPE_JSON = 0x4e4f534a; // 'JSON'
const CHUNK_TYPE_BIN = 0x004e4942; // 'BIN\0'

/** 將 Uint8Array 填充到 4-byte 邊界 */
function padToFour(data: Uint8Array, fillByte: number): Uint8Array {
  const padding = (4 - (data.byteLength % 4)) % 4;
  if (padding === 0) return data;
  const padded = new Uint8Array(data.byteLength + padding);
  padded.set(data, 0);
  padded.fill(fillByte, data.byteLength);
  return padded;
}

/**
 * 將 glTF JSON + binary buffer 寫成 GLB 檔案
 *
 * 格式：
 *   [Header 12 bytes]
 *     magic (uint32 LE) | version (uint32 LE) | totalLength (uint32 LE)
 *   [JSON chunk]
 *     chunkLength (uint32 LE) | chunkType (uint32 LE) | padded JSON bytes
 *   [BIN chunk]
 *     chunkLength (uint32 LE) | chunkType (uint32 LE) | padded binary bytes
 *
 * JSON 用 0x20（空白）填充，BIN 用 0x00 填充，各自對齊到 4-byte。
 *
 * @param json   glTF JSON 物件
 * @param binary 對應的 binary buffer（可為空）
 * @returns      完整 GLB Uint8Array
 */
export function writeGlb(json: unknown, binary: Uint8Array): Uint8Array {
  const jsonText = JSON.stringify(json);
  const jsonBytesRaw = new TextEncoder().encode(jsonText);
  const jsonBytes = padToFour(jsonBytesRaw, 0x20);
  const binBytes = padToFour(binary, 0x00);

  const totalLength =
    12 + // header
    8 + jsonBytes.byteLength + // json chunk header + padded data
    8 + binBytes.byteLength; // bin chunk header + padded data

  const out = new Uint8Array(totalLength);
  const dv = new DataView(out.buffer, out.byteOffset, out.byteLength);

  // Header
  dv.setUint32(0, GLB_MAGIC, true);
  dv.setUint32(4, GLB_VERSION, true);
  dv.setUint32(8, totalLength, true);

  // JSON chunk
  dv.setUint32(12, jsonBytes.byteLength, true);
  dv.setUint32(16, CHUNK_TYPE_JSON, true);
  out.set(jsonBytes, 20);

  // BIN chunk
  const binChunkOffset = 20 + jsonBytes.byteLength;
  dv.setUint32(binChunkOffset, binBytes.byteLength, true);
  dv.setUint32(binChunkOffset + 4, CHUNK_TYPE_BIN, true);
  out.set(binBytes, binChunkOffset + 8);

  return out;
}

/**
 * 將 GLB Uint8Array 解析回 { json, binary }
 *
 * 用於單元測試的 round-trip 驗證，或未來需要讀取自家輸出的場景。
 */
export function parseGlb(bytes: Uint8Array): { json: unknown; binary: Uint8Array } {
  if (bytes.byteLength < 12) {
    throw new Error('[parseGlb] file too small for header');
  }
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  const magic = dv.getUint32(0, true);
  if (magic !== GLB_MAGIC) {
    throw new Error(`[parseGlb] invalid magic 0x${magic.toString(16)}`);
  }
  const version = dv.getUint32(4, true);
  if (version !== GLB_VERSION) {
    throw new Error(`[parseGlb] unsupported version ${version}`);
  }
  const totalLength = dv.getUint32(8, true);
  if (totalLength !== bytes.byteLength) {
    throw new Error(
      `[parseGlb] length mismatch: header ${totalLength} vs actual ${bytes.byteLength}`,
    );
  }

  // JSON chunk
  if (bytes.byteLength < 20) {
    throw new Error('[parseGlb] no JSON chunk');
  }
  const jsonChunkLength = dv.getUint32(12, true);
  const jsonChunkType = dv.getUint32(16, true);
  if (jsonChunkType !== CHUNK_TYPE_JSON) {
    throw new Error(`[parseGlb] expected JSON chunk, got 0x${jsonChunkType.toString(16)}`);
  }
  const jsonBytes = bytes.slice(20, 20 + jsonChunkLength);
  // 去除尾端空白 padding
  const jsonText = new TextDecoder().decode(jsonBytes).replace(/\x20+$/, '');
  const json = JSON.parse(jsonText) as unknown;

  // BIN chunk（可選）
  const binChunkOffset = 20 + jsonChunkLength;
  let binary = new Uint8Array(0);
  if (binChunkOffset + 8 <= bytes.byteLength) {
    const binChunkLength = dv.getUint32(binChunkOffset, true);
    const binChunkType = dv.getUint32(binChunkOffset + 4, true);
    if (binChunkType !== CHUNK_TYPE_BIN) {
      throw new Error(`[parseGlb] expected BIN chunk, got 0x${binChunkType.toString(16)}`);
    }
    binary = bytes.slice(binChunkOffset + 8, binChunkOffset + 8 + binChunkLength);
  }

  return { json, binary };
}
