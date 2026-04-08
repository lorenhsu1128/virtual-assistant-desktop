import { describe, it, expect } from 'vitest';
import { smoothCaptureBufferData } from '../../../../src/video-converter/capture/smoothBuffer';
import { GaussianQuatSmoother } from '../../../../src/video-converter/filters/GaussianQuatSmoother';
import { quatIdentity, quatFromAxisAngle, quatDot } from '../../../../src/video-converter/math/Quat';
import { v3 } from '../../../../src/video-converter/math/Vector';
import type { CaptureBufferData } from '../../../../src/video-converter/capture/types';

describe('smoothCaptureBufferData', () => {
  const makeSmoother = (): GaussianQuatSmoother =>
    new GaussianQuatSmoother({ halfWindow: 2, sigma: 1.0 });

  it('空 frames 回傳空 frames', () => {
    const data: CaptureBufferData = { fps: 30, duration: 0, frames: [] };
    const out = smoothCaptureBufferData(data, makeSmoother());
    expect(out.frames.length).toBe(0);
    expect(out.fps).toBe(30);
  });

  it('保留 timestampMs 與 fps / duration', () => {
    const data: CaptureBufferData = {
      fps: 30,
      duration: 0.1,
      frames: [
        { timestampMs: 0, hipsTranslation: null, boneRotations: { hips: quatIdentity() } },
        { timestampMs: 50, hipsTranslation: null, boneRotations: { hips: quatIdentity() } },
      ],
    };
    const out = smoothCaptureBufferData(data, makeSmoother());
    expect(out.fps).toBe(30);
    expect(out.duration).toBeCloseTo(0.1, 9);
    expect(out.frames[0].timestampMs).toBe(0);
    expect(out.frames[1].timestampMs).toBe(50);
  });

  it('全 identity 序列保持 identity', () => {
    const frames = new Array(10).fill(null).map((_, i) => ({
      timestampMs: i * 33,
      hipsTranslation: null,
      boneRotations: { hips: quatIdentity(), spine: quatIdentity() },
    }));
    const data: CaptureBufferData = { fps: 30, duration: 0.3, frames };
    const out = smoothCaptureBufferData(data, makeSmoother());
    for (const f of out.frames) {
      expect(f.boneRotations.hips!.w).toBeCloseTo(1, 6);
      expect(f.boneRotations.spine!.w).toBeCloseTo(1, 6);
    }
  });

  it('尖刺被衰減：中心點更接近鄰幀', () => {
    const spike = quatFromAxisAngle(v3(0, 0, 1), Math.PI / 2);
    const frames = [
      { timestampMs: 0, hipsTranslation: null, boneRotations: { hips: quatIdentity() } },
      { timestampMs: 33, hipsTranslation: null, boneRotations: { hips: quatIdentity() } },
      { timestampMs: 66, hipsTranslation: null, boneRotations: { hips: quatIdentity() } },
      { timestampMs: 99, hipsTranslation: null, boneRotations: { hips: spike } },
      { timestampMs: 132, hipsTranslation: null, boneRotations: { hips: quatIdentity() } },
      { timestampMs: 165, hipsTranslation: null, boneRotations: { hips: quatIdentity() } },
      { timestampMs: 198, hipsTranslation: null, boneRotations: { hips: quatIdentity() } },
    ];
    const data: CaptureBufferData = { fps: 30, duration: 0.2, frames };
    const out = smoothCaptureBufferData(data, makeSmoother());

    const spikeDot = Math.abs(quatDot(spike, quatIdentity()));
    const smoothedDot = Math.abs(quatDot(out.frames[3].boneRotations.hips!, quatIdentity()));
    // 平滑後應該更接近 identity（dot 絕對值更大）
    expect(smoothedDot).toBeGreaterThan(spikeDot);
  });

  it('多根骨骼獨立處理', () => {
    const q1 = quatFromAxisAngle(v3(1, 0, 0), 0.5);
    const q2 = quatFromAxisAngle(v3(0, 1, 0), 0.3);
    const frames = [
      {
        timestampMs: 0,
        hipsTranslation: null,
        boneRotations: { hips: q1, spine: q2, leftUpperArm: quatIdentity() },
      },
      {
        timestampMs: 33,
        hipsTranslation: null,
        boneRotations: { hips: q1, spine: q2, leftUpperArm: quatIdentity() },
      },
      {
        timestampMs: 66,
        hipsTranslation: null,
        boneRotations: { hips: q1, spine: q2, leftUpperArm: quatIdentity() },
      },
    ];
    const data: CaptureBufferData = { fps: 30, duration: 0.09, frames };
    const out = smoothCaptureBufferData(data, makeSmoother());
    // 所有骨骼都在輸出中
    expect(out.frames[1].boneRotations.hips).toBeDefined();
    expect(out.frames[1].boneRotations.spine).toBeDefined();
    expect(out.frames[1].boneRotations.leftUpperArm).toBeDefined();
    // 常數輸入 → 輸出趨近常數
    expect(quatDot(out.frames[1].boneRotations.hips!, q1)).toBeCloseTo(1, 6);
  });

  it('hipsTranslation 保留但不平滑', () => {
    const frames = [
      {
        timestampMs: 0,
        hipsTranslation: { x: 1, y: 2, z: 3 },
        boneRotations: { hips: quatIdentity() },
      },
      {
        timestampMs: 33,
        hipsTranslation: { x: 1.5, y: 2.5, z: 3.5 },
        boneRotations: { hips: quatIdentity() },
      },
    ];
    const data: CaptureBufferData = { fps: 30, duration: 0.033, frames };
    const out = smoothCaptureBufferData(data, makeSmoother());
    expect(out.frames[0].hipsTranslation).toEqual({ x: 1, y: 2, z: 3 });
    expect(out.frames[1].hipsTranslation).toEqual({ x: 1.5, y: 2.5, z: 3.5 });
  });

  it('深拷貝 hipsTranslation（修改 output 不影響 input）', () => {
    const frames = [
      {
        timestampMs: 0,
        hipsTranslation: { x: 1, y: 2, z: 3 },
        boneRotations: { hips: quatIdentity() },
      },
    ];
    const data: CaptureBufferData = { fps: 30, duration: 0, frames };
    const out = smoothCaptureBufferData(data, makeSmoother());
    out.frames[0].hipsTranslation!.x = 999;
    expect(frames[0].hipsTranslation!.x).toBe(1);
  });
});
