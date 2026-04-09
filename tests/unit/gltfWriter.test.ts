import { describe, it, expect } from 'vitest';
import {
  BufferBuilder,
  writeGlb,
  parseGlb,
} from '../../src/mocap/exporter/gltfWriter';

describe('BufferBuilder', () => {
  it('initial state is empty', () => {
    const b = new BufferBuilder();
    expect(b.getAccessors()).toHaveLength(0);
    expect(b.getBufferViews()).toHaveLength(0);
    expect(b.getTotalByteLength()).toBe(0);
    expect(b.build().byteLength).toBe(0);
  });

  it('addFloat32Array SCALAR creates accessor with correct count and min/max', () => {
    const b = new BufferBuilder();
    const data = new Float32Array([1, 2, 3, 4, 5]);
    const idx = b.addFloat32Array(data, 'SCALAR');
    expect(idx).toBe(0);
    const acc = b.getAccessors()[0];
    expect(acc.count).toBe(5);
    expect(acc.type).toBe('SCALAR');
    expect(acc.componentType).toBe(5126);
    expect(acc.min).toEqual([1]);
    expect(acc.max).toEqual([5]);
  });

  it('addFloat32Array VEC4 computes component-wise min/max', () => {
    const b = new BufferBuilder();
    // 2 quats: (0,0,0,1), (0.5,0.5,0.5,0.5)
    const data = new Float32Array([0, 0, 0, 1, 0.5, 0.5, 0.5, 0.5]);
    b.addFloat32Array(data, 'VEC4');
    const acc = b.getAccessors()[0];
    expect(acc.count).toBe(2);
    expect(acc.type).toBe('VEC4');
    expect(acc.min).toEqual([0, 0, 0, 0.5]);
    expect(acc.max).toEqual([0.5, 0.5, 0.5, 1]);
  });

  it('addFloat32Array VEC3 works', () => {
    const b = new BufferBuilder();
    const data = new Float32Array([1, 2, 3, 4, 5, 6]);
    b.addFloat32Array(data, 'VEC3');
    const acc = b.getAccessors()[0];
    expect(acc.count).toBe(2);
    expect(acc.type).toBe('VEC3');
    expect(acc.min).toEqual([1, 2, 3]);
    expect(acc.max).toEqual([4, 5, 6]);
  });

  it('multiple arrays have sequential byte offsets', () => {
    const b = new BufferBuilder();
    b.addFloat32Array(new Float32Array([1, 2, 3, 4]), 'SCALAR'); // 16 bytes
    b.addFloat32Array(new Float32Array([5, 6, 7]), 'VEC3'); // 12 bytes
    const views = b.getBufferViews();
    expect(views).toHaveLength(2);
    expect(views[0].byteOffset).toBe(0);
    expect(views[0].byteLength).toBe(16);
    expect(views[1].byteOffset).toBe(16);
    expect(views[1].byteLength).toBe(12);
    expect(b.getTotalByteLength()).toBe(28);
  });

  it('throws on length not divisible by component count', () => {
    const b = new BufferBuilder();
    expect(() => b.addFloat32Array(new Float32Array([1, 2, 3]), 'VEC4')).toThrow();
  });

  it('build() concatenates chunks into a single Uint8Array', () => {
    const b = new BufferBuilder();
    b.addFloat32Array(new Float32Array([1, 2]), 'SCALAR');
    b.addFloat32Array(new Float32Array([3, 4]), 'SCALAR');
    const bytes = b.build();
    expect(bytes.byteLength).toBe(16);
    const view = new Float32Array(bytes.buffer, bytes.byteOffset, 4);
    expect(Array.from(view)).toEqual([1, 2, 3, 4]);
  });
});

describe('writeGlb + parseGlb', () => {
  it('writes and parses a minimal glTF', () => {
    const json = { asset: { version: '2.0' } };
    const binary = new Uint8Array(0);
    const glb = writeGlb(json, binary);
    const parsed = parseGlb(glb);
    expect(parsed.json).toEqual(json);
    expect(parsed.binary.byteLength).toBe(0);
  });

  it('header has correct magic, version, and length', () => {
    const glb = writeGlb({ asset: { version: '2.0' } }, new Uint8Array(0));
    const dv = new DataView(glb.buffer, glb.byteOffset, glb.byteLength);
    expect(dv.getUint32(0, true)).toBe(0x46546c67); // 'glTF'
    expect(dv.getUint32(4, true)).toBe(2);
    expect(dv.getUint32(8, true)).toBe(glb.byteLength);
  });

  it('JSON chunk type is 0x4E4F534A', () => {
    const glb = writeGlb({ asset: { version: '2.0' } }, new Uint8Array(0));
    const dv = new DataView(glb.buffer, glb.byteOffset, glb.byteLength);
    expect(dv.getUint32(16, true)).toBe(0x4e4f534a);
  });

  it('JSON chunk length is padded to 4-byte boundary', () => {
    const glb = writeGlb({ a: 1 }, new Uint8Array(0));
    const dv = new DataView(glb.buffer, glb.byteOffset, glb.byteLength);
    const jsonLen = dv.getUint32(12, true);
    expect(jsonLen % 4).toBe(0);
  });

  it('JSON padding uses space character (0x20)', () => {
    // `{"a":1}` = 7 bytes → needs 1 byte of padding
    const glb = writeGlb({ a: 1 }, new Uint8Array(0));
    const dv = new DataView(glb.buffer, glb.byteOffset, glb.byteLength);
    const jsonLen = dv.getUint32(12, true);
    // Last byte of the JSON chunk should be a space
    const lastByte = glb[20 + jsonLen - 1];
    expect(lastByte).toBe(0x20);
  });

  it('round-trips binary data of various sizes (content preserved, padded to 4-byte)', () => {
    // BIN chunk length in GLB spec is padded to 4-byte boundary.
    // parseGlb returns the padded length; original bytes are preserved at the start,
    // trailing bytes (if padding added) are zero per spec.
    for (const size of [0, 1, 2, 3, 4, 5, 7, 16, 100, 1000]) {
      const binary = new Uint8Array(size);
      for (let i = 0; i < size; i++) binary[i] = (i * 7) & 0xff;
      const glb = writeGlb({ asset: { version: '2.0' } }, binary);
      const parsed = parseGlb(glb);
      // Parsed length >= original size, and is 4-byte aligned
      expect(parsed.binary.byteLength).toBeGreaterThanOrEqual(size);
      expect(parsed.binary.byteLength % 4).toBe(0);
      // Original bytes preserved at the start
      for (let i = 0; i < size; i++) {
        expect(parsed.binary[i]).toBe((i * 7) & 0xff);
      }
      // Padding bytes (if any) should be zero
      for (let i = size; i < parsed.binary.byteLength; i++) {
        expect(parsed.binary[i]).toBe(0);
      }
    }
  });

  it('round-trips nested JSON structures', () => {
    const json = {
      asset: { version: '2.0', generator: 'test' },
      extensionsUsed: ['VRMC_vrm_animation'],
      extensions: {
        VRMC_vrm_animation: {
          specVersion: '1.0',
          humanoid: { humanBones: { hips: { node: 0 } } },
        },
      },
      nodes: [{ name: 'hips' }, { name: 'spine' }],
    };
    const glb = writeGlb(json, new Uint8Array(0));
    const parsed = parseGlb(glb);
    expect(parsed.json).toEqual(json);
  });

  it('total length matches header length field', () => {
    const json = { asset: { version: '2.0' } };
    const binary = new Uint8Array(17); // odd size
    const glb = writeGlb(json, binary);
    const dv = new DataView(glb.buffer, glb.byteOffset, glb.byteLength);
    expect(dv.getUint32(8, true)).toBe(glb.byteLength);
    expect(glb.byteLength % 4).toBe(0);
  });

  it('parseGlb throws on invalid magic', () => {
    const bad = new Uint8Array(20);
    bad[0] = 0xff;
    expect(() => parseGlb(bad)).toThrow();
  });

  it('parseGlb throws on unsupported version', () => {
    const glb = writeGlb({ a: 1 }, new Uint8Array(0));
    const dv = new DataView(glb.buffer, glb.byteOffset, glb.byteLength);
    dv.setUint32(4, 99, true);
    dv.setUint32(8, glb.byteLength, true); // keep length valid
    expect(() => parseGlb(glb)).toThrow();
  });

  it('parseGlb throws on too-small input', () => {
    expect(() => parseGlb(new Uint8Array(5))).toThrow();
  });

  it('round-trips larger binary with Float32 data', () => {
    const floatData = new Float32Array(100);
    for (let i = 0; i < 100; i++) floatData[i] = Math.sin(i) * 10;
    const binary = new Uint8Array(floatData.buffer);
    const glb = writeGlb({ asset: { version: '2.0' } }, binary);
    const parsed = parseGlb(glb);
    const parsedFloats = new Float32Array(
      parsed.binary.buffer,
      parsed.binary.byteOffset,
      100,
    );
    for (let i = 0; i < 100; i++) {
      expect(parsedFloats[i]).toBeCloseTo(floatData[i]);
    }
  });
});
