import { describe, it, expect } from 'vitest';
import { serializeToVadJson, toVadJsonObject, VAD_JSON_VERSION } from '../../../../src/video-converter/export/VadJsonWriter';
import { parseVadJson, fromVadJsonObject, VadJsonParseError } from '../../../../src/video-converter/export/VadJsonReader';
import { quatIdentity, quatFromAxisAngle } from '../../../../src/video-converter/math/Quat';
import { v3 } from '../../../../src/video-converter/math/Vector';
import type { CaptureBufferData } from '../../../../src/video-converter/capture/types';

const makeData = (): CaptureBufferData => ({
  fps: 30,
  duration: 0.1,
  frames: [
    {
      timestampMs: 0,
      hipsTranslation: { x: 0, y: 1, z: 0 },
      boneRotations: { hips: quatIdentity(), spine: quatIdentity() },
    },
    {
      timestampMs: 50,
      hipsTranslation: { x: 0.1, y: 1.05, z: 0 },
      boneRotations: {
        hips: quatFromAxisAngle(v3(0, 1, 0), 0.3),
        spine: quatFromAxisAngle(v3(0, 0, 1), 0.2),
        leftUpperArm: quatFromAxisAngle(v3(1, 0, 0), -0.5),
      },
    },
    {
      timestampMs: 100,
      hipsTranslation: null,
      boneRotations: { hips: quatIdentity() },
    },
  ],
});

describe('VadJson round-trip', () => {
  it('serialize → parse 還原 fps / duration / frameCount', () => {
    const data = makeData();
    const json = serializeToVadJson(data);
    const parsed = parseVadJson(json);
    expect(parsed.fps).toBe(30);
    expect(parsed.duration).toBeCloseTo(0.1, 9);
    expect(parsed.frames.length).toBe(3);
  });

  it('timestampMs 精確還原', () => {
    const json = serializeToVadJson(makeData());
    const parsed = parseVadJson(json);
    expect(parsed.frames[0].timestampMs).toBe(0);
    expect(parsed.frames[1].timestampMs).toBe(50);
    expect(parsed.frames[2].timestampMs).toBe(100);
  });

  it('hipsTranslation 還原（含 null）', () => {
    const json = serializeToVadJson(makeData());
    const parsed = parseVadJson(json);
    expect(parsed.frames[0].hipsTranslation).toEqual({ x: 0, y: 1, z: 0 });
    expect(parsed.frames[1].hipsTranslation).toEqual({ x: 0.1, y: 1.05, z: 0 });
    expect(parsed.frames[2].hipsTranslation).toBeNull();
  });

  it('boneRotations 精確還原所有四元數分量', () => {
    const data = makeData();
    const json = serializeToVadJson(data);
    const parsed = parseVadJson(json);
    const original = data.frames[1].boneRotations.hips!;
    const restored = parsed.frames[1].boneRotations.hips!;
    expect(restored.x).toBeCloseTo(original.x, 12);
    expect(restored.y).toBeCloseTo(original.y, 12);
    expect(restored.z).toBeCloseTo(original.z, 12);
    expect(restored.w).toBeCloseTo(original.w, 12);
  });

  it('部分骨骼 frame 不影響其他 frame', () => {
    const json = serializeToVadJson(makeData());
    const parsed = parseVadJson(json);
    expect(Object.keys(parsed.frames[0].boneRotations)).toEqual(['hips', 'spine']);
    expect(Object.keys(parsed.frames[1].boneRotations).sort()).toEqual(
      ['hips', 'leftUpperArm', 'spine'].sort()
    );
    expect(Object.keys(parsed.frames[2].boneRotations)).toEqual(['hips']);
  });
});

describe('VadJson metadata', () => {
  it('metadata 含 version / fps / duration / frameCount / createdAt', () => {
    const obj = toVadJsonObject(makeData(), { createdAt: '2026-04-08T00:00:00Z' });
    expect(obj.version).toBe(VAD_JSON_VERSION);
    expect(obj.metadata.fps).toBe(30);
    expect(obj.metadata.duration).toBeCloseTo(0.1, 9);
    expect(obj.metadata.frameCount).toBe(3);
    expect(obj.metadata.createdAt).toBe('2026-04-08T00:00:00Z');
  });

  it('未指定 createdAt 自動填入 ISO string', () => {
    const obj = toVadJsonObject(makeData());
    expect(obj.metadata.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});

describe('VadJson parse errors', () => {
  it('非法 JSON 拋 VadJsonParseError', () => {
    expect(() => parseVadJson('not json')).toThrow(VadJsonParseError);
  });

  it('缺 version 拋錯', () => {
    expect(() => fromVadJsonObject({ metadata: {}, frames: [] })).toThrow(VadJsonParseError);
  });

  it('version 不支援拋錯', () => {
    expect(() =>
      fromVadJsonObject({ version: 999, metadata: {}, frames: [] })
    ).toThrow(/Unsupported version/);
  });

  it('frames 非陣列拋錯', () => {
    expect(() =>
      fromVadJsonObject({ version: 1, metadata: {}, frames: 'nope' })
    ).toThrow(/frames must be array/);
  });

  it('frame 缺 t 拋錯', () => {
    expect(() =>
      fromVadJsonObject({
        version: 1,
        metadata: { fps: 30, duration: 0, frameCount: 0 },
        frames: [{ b: {} }],
      })
    ).toThrow(/missing t/);
  });
});
