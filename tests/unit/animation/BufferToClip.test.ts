import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import {
  bufferToClip,
  getQuaternionBoneNames,
  hasHipsPositionTrack,
  getHipsPositionTrack,
} from '../../../src/animation/BufferToClip';
import type { CaptureBufferData } from '../../../src/video-converter/capture/types';
import { quatIdentity, quatFromAxisAngle } from '../../../src/video-converter/math/Quat';
import { v3 } from '../../../src/video-converter/math/Vector';

const makeData = (): CaptureBufferData => ({
  fps: 30,
  duration: 0.1,
  frames: [
    {
      timestampMs: 0,
      hipsTranslation: { x: 0, y: 1, z: 0 },
      boneRotations: {
        hips: quatIdentity(),
        spine: quatIdentity(),
        leftUpperArm: quatIdentity(),
      },
    },
    {
      timestampMs: 50,
      hipsTranslation: { x: 0.1, y: 1.05, z: 0 },
      boneRotations: {
        hips: quatFromAxisAngle(v3(0, 1, 0), 0.1),
        spine: quatIdentity(),
        leftUpperArm: quatFromAxisAngle(v3(0, 0, 1), 0.2),
      },
    },
    {
      timestampMs: 100,
      hipsTranslation: { x: 0.2, y: 1.1, z: 0 },
      boneRotations: {
        hips: quatFromAxisAngle(v3(0, 1, 0), 0.2),
        spine: quatIdentity(),
        leftUpperArm: quatFromAxisAngle(v3(0, 0, 1), 0.4),
      },
    },
  ],
});

describe('bufferToClip — 基本結構', () => {
  it('回傳 THREE.AnimationClip 實例', () => {
    const clip = bufferToClip(makeData(), 'test');
    expect(clip).toBeInstanceOf(THREE.AnimationClip);
    expect(clip.name).toBe('test');
  });

  it('clip duration 等於 data.duration（若 > 0）', () => {
    const clip = bufferToClip(makeData(), 'test');
    expect(clip.duration).toBeCloseTo(0.1, 9);
  });

  it('data.duration 為 0 時用實際時間範圍', () => {
    const data = makeData();
    data.duration = 0;
    const clip = bufferToClip(data, 'test');
    expect(clip.duration).toBeCloseTo(0.1, 9);
  });

  it('每根曾出現過的骨骼一條 quaternion track', () => {
    const clip = bufferToClip(makeData(), 'test');
    const bones = new Set(getQuaternionBoneNames(clip));
    expect(bones.has('hips')).toBe(true);
    expect(bones.has('spine')).toBe(true);
    expect(bones.has('leftUpperArm')).toBe(true);
    expect(bones.size).toBe(3);
  });
});

describe('bufferToClip — quaternion track 內容', () => {
  it('每條 track 含 3 個 keyframe（對應 3 幀）', () => {
    const clip = bufferToClip(makeData(), 'test');
    for (const t of clip.tracks) {
      if (t.name.endsWith('.quaternion')) {
        expect(t.times.length).toBe(3);
        expect(t.values.length).toBe(3 * 4); // x,y,z,w
      }
    }
  });

  it('時間戳從 0 開始（以第一幀為基準）', () => {
    const clip = bufferToClip(makeData(), 'test');
    const hipsTrack = clip.tracks.find((t) => t.name === 'hips.quaternion');
    // 註：KeyframeTrack 內部用 Float32Array，故精度為 f32（~7 位數）
    expect(hipsTrack!.times[0]).toBeCloseTo(0, 6);
    expect(hipsTrack!.times[2]).toBeCloseTo(0.1, 6);
  });

  it('quaternion 值正確序列化為 [x, y, z, w] flat array', () => {
    const clip = bufferToClip(makeData(), 'test');
    const hipsTrack = clip.tracks.find((t) => t.name === 'hips.quaternion')!;
    // 第一幀為 identity
    expect(hipsTrack.values[0]).toBeCloseTo(0, 9); // x
    expect(hipsTrack.values[1]).toBeCloseTo(0, 9); // y
    expect(hipsTrack.values[2]).toBeCloseTo(0, 9); // z
    expect(hipsTrack.values[3]).toBeCloseTo(1, 9); // w
  });
});

describe('bufferToClip — hips position track', () => {
  it('hips.position track 存在', () => {
    const clip = bufferToClip(makeData(), 'test');
    expect(hasHipsPositionTrack(clip)).toBe(true);
  });

  it('hips.position 是 VectorKeyframeTrack', () => {
    const clip = bufferToClip(makeData(), 'test');
    const t = getHipsPositionTrack(clip);
    expect(t).toBeInstanceOf(THREE.VectorKeyframeTrack);
  });

  it('hips.position 含 3 個 keyframe，每筆 [x,y,z]', () => {
    const clip = bufferToClip(makeData(), 'test');
    const t = getHipsPositionTrack(clip)!;
    expect(t.times.length).toBe(3);
    expect(t.values.length).toBe(3 * 3);
    // f32 精度
    expect(t.values[0]).toBeCloseTo(0, 6);
    expect(t.values[1]).toBeCloseTo(1, 6);
    expect(t.values[2]).toBeCloseTo(0, 6);
    expect(t.values[6]).toBeCloseTo(0.2, 6);
    expect(t.values[7]).toBeCloseTo(1.1, 6);
  });

  it('全部 hipsTranslation 為 null → 無 hips.position track', () => {
    const data: CaptureBufferData = {
      fps: 30,
      duration: 0.1,
      frames: [
        { timestampMs: 0, hipsTranslation: null, boneRotations: { hips: quatIdentity() } },
        { timestampMs: 50, hipsTranslation: null, boneRotations: { hips: quatIdentity() } },
      ],
    };
    const clip = bufferToClip(data, 'test');
    expect(hasHipsPositionTrack(clip)).toBe(false);
  });
});

describe('bufferToClip — carry forward 缺幀補值', () => {
  it('某幀缺骨骼時用前一幀的值', () => {
    const data: CaptureBufferData = {
      fps: 30,
      duration: 0.1,
      frames: [
        {
          timestampMs: 0,
          hipsTranslation: { x: 0, y: 1, z: 0 },
          boneRotations: {
            hips: quatIdentity(),
            leftUpperArm: quatFromAxisAngle(v3(0, 0, 1), 0.5),
          },
        },
        {
          timestampMs: 50,
          hipsTranslation: { x: 0, y: 1, z: 0 },
          boneRotations: { hips: quatIdentity() }, // 缺 leftUpperArm
        },
      ],
    };
    const clip = bufferToClip(data, 'test');
    const lua = clip.tracks.find((t) => t.name === 'leftUpperArm.quaternion');
    expect(lua).toBeDefined();
    expect(lua!.times.length).toBe(2);
    // 第二幀的 leftUpperArm 應該是第一幀的 carry forward
    expect(lua!.values[4]).toBeCloseTo(lua!.values[0], 9);
    expect(lua!.values[5]).toBeCloseTo(lua!.values[1], 9);
    expect(lua!.values[6]).toBeCloseTo(lua!.values[2], 9);
    expect(lua!.values[7]).toBeCloseTo(lua!.values[3], 9);
  });
});

describe('bufferToClip — 空 / 退化輸入', () => {
  it('空 frames 回傳空 tracks 的 clip', () => {
    const clip = bufferToClip({ fps: 30, duration: 0, frames: [] }, 'empty');
    expect(clip.tracks.length).toBe(0);
    expect(clip.duration).toBe(0);
  });
});
