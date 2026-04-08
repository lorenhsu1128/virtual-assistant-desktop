import { describe, it, expect } from 'vitest';
import { CaptureBuffer } from '../../../../src/video-converter/capture/CaptureBuffer';
import type { CaptureFrame } from '../../../../src/video-converter/capture/types';
import { quatIdentity, quatFromAxisAngle, quatDot } from '../../../../src/video-converter/math/Quat';
import { v3 } from '../../../../src/video-converter/math/Vector';

const makeFrame = (t: number, hipsY: number, hipsRot = quatIdentity()): CaptureFrame => ({
  timestampMs: t,
  hipsTranslation: { x: 0, y: hipsY, z: 0 },
  boneRotations: { hips: hipsRot },
});

describe('CaptureBuffer — push / clear / length', () => {
  it('push 後 length 增加', () => {
    const buf = new CaptureBuffer();
    expect(buf.length).toBe(0);
    buf.push(makeFrame(0, 1));
    buf.push(makeFrame(33, 1));
    expect(buf.length).toBe(2);
    expect(buf.frames.length).toBe(2);
  });

  it('clear 重置為空', () => {
    const buf = new CaptureBuffer();
    buf.push(makeFrame(0, 1));
    buf.push(makeFrame(33, 1));
    buf.clear();
    expect(buf.length).toBe(0);
    expect(buf.frames.length).toBe(0);
  });
});

describe('CaptureBuffer — sampleAt 線性插值', () => {
  it('在兩幀中間：hips translation 線性插值', () => {
    const buf = new CaptureBuffer();
    buf.push(makeFrame(0, 1.0));
    buf.push(makeFrame(100, 2.0));
    const mid = buf.sampleAt(50);
    expect(mid).not.toBeNull();
    expect(mid!.hipsTranslation!.y).toBeCloseTo(1.5, 9);
  });

  it('25% 時間點 → 25% 內插', () => {
    const buf = new CaptureBuffer();
    buf.push(makeFrame(0, 0));
    buf.push(makeFrame(100, 4));
    const q = buf.sampleAt(25);
    expect(q!.hipsTranslation!.y).toBeCloseTo(1, 9);
  });

  it('時間早於第一幀 → 回傳第一幀拷貝', () => {
    const buf = new CaptureBuffer();
    buf.push(makeFrame(100, 5));
    buf.push(makeFrame(200, 10));
    const r = buf.sampleAt(0);
    expect(r!.hipsTranslation!.y).toBe(5);
  });

  it('時間晚於最後一幀 → 回傳最後一幀拷貝', () => {
    const buf = new CaptureBuffer();
    buf.push(makeFrame(100, 5));
    buf.push(makeFrame(200, 10));
    const r = buf.sampleAt(999);
    expect(r!.hipsTranslation!.y).toBe(10);
  });

  it('空緩衝 → null', () => {
    expect(new CaptureBuffer().sampleAt(0)).toBeNull();
  });

  it('quaternion slerp：兩端旋轉中間取半', () => {
    const buf = new CaptureBuffer();
    const q0 = quatIdentity();
    const q1 = quatFromAxisAngle(v3(0, 0, 1), Math.PI / 2);
    buf.push({
      timestampMs: 0,
      hipsTranslation: null,
      boneRotations: { hips: q0 },
    });
    buf.push({
      timestampMs: 100,
      hipsTranslation: null,
      boneRotations: { hips: q1 },
    });
    const mid = buf.sampleAt(50);
    const expected = quatFromAxisAngle(v3(0, 0, 1), Math.PI / 4);
    // 比較 dot 接近 1
    expect(quatDot(mid!.boneRotations.hips!, expected)).toBeCloseTo(1, 6);
  });
});

describe('CaptureBuffer — finalize', () => {
  it('duration = (last - first) / 1000', () => {
    const buf = new CaptureBuffer();
    buf.push(makeFrame(0, 0));
    buf.push(makeFrame(33, 0));
    buf.push(makeFrame(66, 0));
    buf.push(makeFrame(99, 0));
    const data = buf.finalize(30);
    expect(data.duration).toBeCloseTo(0.099, 9);
    expect(data.fps).toBe(30);
    expect(data.frames.length).toBe(4);
  });

  it('空緩衝 finalize → duration 0', () => {
    const data = new CaptureBuffer().finalize(30);
    expect(data.duration).toBe(0);
    expect(data.frames.length).toBe(0);
  });

  it('finalize 是深拷貝（修改原 buffer 不影響快照）', () => {
    const buf = new CaptureBuffer();
    buf.push(makeFrame(0, 1));
    const data = buf.finalize(30);
    buf.push(makeFrame(33, 2));
    expect(data.frames.length).toBe(1);
  });
});
