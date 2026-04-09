import { describe, it, expect } from 'vitest';
import { clampSmplFrame, clampSmplTrack } from '../../src/mocap/smpl/applyClamp';
import { SMPL_JOINT_AXIS_LIMITS, type AxisLimits } from '../../src/mocap/smpl/jointLimits';
import { SMPL_JOINT_COUNT } from '../../src/mocap/smpl/SmplSkeleton';
import type { SmplTrack } from '../../src/mocap/types';

function makeLimits(x0: number, x1: number, y0: number, y1: number, z0: number, z1: number): AxisLimits {
  return { x: [x0, x1], y: [y0, y1], z: [z0, z1] };
}

describe('clampSmplFrame', () => {
  it('clamps out-of-range values to limits', () => {
    const frame = [[10, -10, 5]];
    const limits = [makeLimits(-1, 1, -2, 2, -3, 3)];
    clampSmplFrame(frame, limits);
    expect(frame[0]).toEqual([1, -2, 3]);
  });

  it('passes through in-range values unchanged', () => {
    const frame = [[0.5, -1, 2]];
    const limits = [makeLimits(-1, 1, -2, 2, -3, 3)];
    clampSmplFrame(frame, limits);
    expect(frame[0]).toEqual([0.5, -1, 2]);
  });

  it('handles multiple joints independently', () => {
    const frame = [
      [100, 100, 100],
      [0, 0, 0],
      [-50, -50, -50],
    ];
    const wide = makeLimits(-Math.PI, Math.PI, -Math.PI, Math.PI, -Math.PI, Math.PI);
    clampSmplFrame(frame, [wide, wide, wide]);
    expect(frame[0]).toEqual([Math.PI, Math.PI, Math.PI]);
    expect(frame[1]).toEqual([0, 0, 0]);
    expect(frame[2]).toEqual([-Math.PI, -Math.PI, -Math.PI]);
  });

  it('does not crash on shorter axis-angle entries', () => {
    const frame = [[10], [10, -10], [10, -10, 5]];
    const wide = makeLimits(-1, 1, -1, 1, -1, 1);
    expect(() => clampSmplFrame(frame, [wide, wide, wide])).not.toThrow();
    expect(frame[0][0]).toBe(1);
    expect(frame[1][0]).toBe(1);
    expect(frame[1][1]).toBe(-1);
    expect(frame[2]).toEqual([1, -1, 1]);
  });

  it('skips joints whose limits entry is missing', () => {
    const frame = [[10, 10, 10]];
    // 空 limits 陣列 → 不套用
    expect(() => clampSmplFrame(frame, [])).not.toThrow();
    expect(frame[0]).toEqual([10, 10, 10]); // unchanged
  });
});

describe('clampSmplTrack', () => {
  it('clamps all frames in a track', () => {
    const track: SmplTrack = {
      version: 1,
      fps: 30,
      frameCount: 2,
      frames: [
        [[100, 0, 0], ...Array.from({ length: SMPL_JOINT_COUNT - 1 }, () => [0, 0, 0])],
        [[-100, 0, 0], ...Array.from({ length: SMPL_JOINT_COUNT - 1 }, () => [0, 0, 0])],
      ],
      trans: [
        [0, 0, 0],
        [0, 0, 0],
      ],
    };
    clampSmplTrack(track);
    expect(track.frames[0][0][0]).toBeLessThanOrEqual(Math.PI);
    expect(track.frames[1][0][0]).toBeGreaterThanOrEqual(-Math.PI);
  });

  it('handles empty track without crashing', () => {
    const track: SmplTrack = {
      version: 1,
      fps: 30,
      frameCount: 0,
      frames: [],
      trans: [],
    };
    expect(() => clampSmplTrack(track)).not.toThrow();
  });

  it('uses SMPL_JOINT_AXIS_LIMITS as default', () => {
    expect(SMPL_JOINT_AXIS_LIMITS.length).toBe(SMPL_JOINT_COUNT);
    // Phase 5c：每 joint 的每軸 min < max 且為有限值
    for (const l of SMPL_JOINT_AXIS_LIMITS) {
      for (const axis of [l.x, l.y, l.z] as const) {
        expect(Number.isFinite(axis[0])).toBe(true);
        expect(Number.isFinite(axis[1])).toBe(true);
        expect(axis[0]).toBeLessThan(axis[1]);
        // 限制對稱（±bound）且至少不小於 ±30° 避免過度裁切
        expect(axis[1]).toBeGreaterThanOrEqual(Math.PI / 6 - 1e-9);
      }
    }
  });

  it('tightens torso joints below π (spine / neck / collar)', () => {
    // Phase 5c：脊椎 / 頸 / collar 應收緊到 < π
    const torsoIndices = [3, 6, 9, 12, 13, 14]; // spine1/2/3, neck, leftCollar, rightCollar
    for (const i of torsoIndices) {
      const l = SMPL_JOINT_AXIS_LIMITS[i];
      expect(l.x[1]).toBeLessThan(Math.PI);
      expect(l.y[1]).toBeLessThan(Math.PI);
      expect(l.z[1]).toBeLessThan(Math.PI);
    }
  });

  it('keeps large-range joints wide (hip / shoulder / knee / elbow)', () => {
    // 這些 joint 需要完整 ±π 範圍；per-axis clamp 過緊會裁掉正確姿態
    const wideIndices = [0, 1, 2, 4, 5, 16, 17, 18, 19]; // pelvis, hip, knee, shoulder, elbow
    for (const i of wideIndices) {
      const l = SMPL_JOINT_AXIS_LIMITS[i];
      expect(l.x[1]).toBeCloseTo(Math.PI, 5);
      expect(l.x[0]).toBeCloseTo(-Math.PI, 5);
    }
  });

  it('accepts custom limits parameter', () => {
    const track: SmplTrack = {
      version: 1,
      fps: 30,
      frameCount: 1,
      frames: [Array.from({ length: SMPL_JOINT_COUNT }, () => [0.5, 0.5, 0.5])],
      trans: [[0, 0, 0]],
    };
    const tight = Array.from({ length: SMPL_JOINT_COUNT }, () => makeLimits(-0.1, 0.1, -0.1, 0.1, -0.1, 0.1));
    clampSmplTrack(track, tight);
    expect(track.frames[0][0]).toEqual([0.1, 0.1, 0.1]);
  });
});
