import { describe, it, expect } from 'vitest';
import { parseGlbContainer, repackGlb } from '../../../../src/video-converter/export/VrmaExporter';

const GLB_MAGIC = 0x46546c67;
const CHUNK_TYPE_JSON = 0x4e4f534a;
const CHUNK_TYPE_BIN = 0x004e4942;

/** 建構一個最小合法 glb 用於測試 */
function buildGlb(jsonStr: string, binBytes: Uint8Array | null = null): ArrayBuffer {
  const jsonBytes = new TextEncoder().encode(jsonStr);
  // 先算 padding 後的長度
  const jsonPadLen = (4 - (jsonBytes.length % 4)) % 4;
  const paddedJsonLen = jsonBytes.length + jsonPadLen;
  const binPadLen = binBytes ? (4 - (binBytes.length % 4)) % 4 : 0;
  const paddedBinLen = binBytes ? binBytes.length + binPadLen : 0;

  const jsonChunkSize = 8 + paddedJsonLen;
  const binChunkSize = binBytes ? 8 + paddedBinLen : 0;
  const total = 12 + jsonChunkSize + binChunkSize;

  const buf = new ArrayBuffer(total);
  const dv = new DataView(buf);
  const u8 = new Uint8Array(buf);

  dv.setUint32(0, GLB_MAGIC, true);
  dv.setUint32(4, 2, true);
  dv.setUint32(8, total, true);

  dv.setUint32(12, paddedJsonLen, true);
  dv.setUint32(16, CHUNK_TYPE_JSON, true);
  u8.set(jsonBytes, 20);
  for (let i = 0; i < jsonPadLen; i++) u8[20 + jsonBytes.length + i] = 0x20;

  if (binBytes) {
    const binOffset = 20 + paddedJsonLen;
    dv.setUint32(binOffset, paddedBinLen, true);
    dv.setUint32(binOffset + 4, CHUNK_TYPE_BIN, true);
    u8.set(binBytes, binOffset + 8);
  }
  return buf;
}

describe('parseGlbContainer', () => {
  it('解析含 JSON chunk 的 glb', () => {
    const buf = buildGlb('{"hello":"world"}');
    const { jsonBytes, binBytes } = parseGlbContainer(buf);
    expect(new TextDecoder().decode(jsonBytes)).toContain('hello');
    expect(binBytes).toBeNull();
  });

  it('解析含 JSON + BIN chunk 的 glb', () => {
    const binData = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
    const buf = buildGlb('{"a":1}', binData);
    const { jsonBytes, binBytes } = parseGlbContainer(buf);
    expect(new TextDecoder().decode(jsonBytes).trim()).toContain('"a":1');
    expect(binBytes).not.toBeNull();
    expect(binBytes![0]).toBe(1);
    expect(binBytes![7]).toBe(8);
  });

  it('非 glb magic 拋錯', () => {
    const buf = new ArrayBuffer(20);
    const dv = new DataView(buf);
    dv.setUint32(0, 0xdeadbeef, true);
    dv.setUint32(4, 2, true);
    dv.setUint32(8, 20, true);
    expect(() => parseGlbContainer(buf)).toThrow(/Not a glb file/);
  });

  it('不支援的 version 拋錯', () => {
    const buf = new ArrayBuffer(20);
    const dv = new DataView(buf);
    dv.setUint32(0, GLB_MAGIC, true);
    dv.setUint32(4, 99, true);
    dv.setUint32(8, 20, true);
    expect(() => parseGlbContainer(buf)).toThrow(/Unsupported glb version/);
  });

  it('length 欄位不符拋錯', () => {
    const buf = new ArrayBuffer(40);
    const dv = new DataView(buf);
    dv.setUint32(0, GLB_MAGIC, true);
    dv.setUint32(4, 2, true);
    dv.setUint32(8, 20, true); // 宣稱 20 但實際 40
    expect(() => parseGlbContainer(buf)).toThrow(/length field/);
  });
});

describe('repackGlb', () => {
  it('round-trip：parse → repack 還原 JSON 內容', () => {
    const original = buildGlb('{"version":1,"nodes":[]}');
    const { jsonBytes } = parseGlbContainer(original);
    const repacked = repackGlb(jsonBytes, null);
    const { jsonBytes: roundTripJson } = parseGlbContainer(repacked);
    expect(new TextDecoder().decode(roundTripJson).trim()).toContain('"version":1');
  });

  it('round-trip：JSON + BIN 都還原', () => {
    const binData = new Uint8Array([10, 20, 30, 40]);
    const original = buildGlb('{"a":2}', binData);
    const { jsonBytes, binBytes } = parseGlbContainer(original);
    const repacked = repackGlb(jsonBytes, binBytes);
    const rt = parseGlbContainer(repacked);
    expect(new TextDecoder().decode(rt.jsonBytes).trim()).toContain('"a":2');
    expect(rt.binBytes![0]).toBe(10);
  });

  it('JSON chunk 以 0x20 (space) padding', () => {
    // 長度 1 的 JSON 需要 3 bytes padding
    const jsonBytes = new TextEncoder().encode('X');
    const repacked = repackGlb(jsonBytes, null);
    const u8 = new Uint8Array(repacked);
    // Header 12 bytes + chunk header 8 bytes = offset 20
    expect(u8[20]).toBe(0x58); // 'X'
    expect(u8[21]).toBe(0x20); // space padding
    expect(u8[22]).toBe(0x20);
    expect(u8[23]).toBe(0x20);
  });

  it('BIN chunk 以 0x00 padding', () => {
    const jsonBytes = new TextEncoder().encode('{}');
    const binBytes = new Uint8Array([0xff]); // 1 byte needs 3 bytes 0x00 pad
    const repacked = repackGlb(jsonBytes, binBytes);
    const u8 = new Uint8Array(repacked);
    // JSON chunk: 8 header + 4 padded ('{}  ') = 12 bytes at offset 12
    // BIN chunk header at offset 24
    // BIN data at offset 24 + 8 = 32
    expect(u8[32]).toBe(0xff);
    expect(u8[33]).toBe(0x00);
    expect(u8[34]).toBe(0x00);
    expect(u8[35]).toBe(0x00);
  });

  it('總長度欄位正確', () => {
    const jsonBytes = new TextEncoder().encode('{"test":true}');
    const repacked = repackGlb(jsonBytes, null);
    const dv = new DataView(repacked);
    expect(dv.getUint32(8, true)).toBe(repacked.byteLength);
  });

  it('4-byte alignment：所有 chunk 都對齊', () => {
    const cases = ['a', 'ab', 'abc', 'abcd', 'abcde'];
    for (const s of cases) {
      const jsonBytes = new TextEncoder().encode(s);
      const repacked = repackGlb(jsonBytes, null);
      expect(repacked.byteLength % 4).toBe(0);
    }
  });
});
