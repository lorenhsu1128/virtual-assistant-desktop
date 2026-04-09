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
    // Phase 2a 預設是寬鬆的 [-π, π]
    for (const l of SMPL_JOINT_AXIS_LIMITS) {
      expect(l.x[0]).toBe(-Math.PI);
      expect(l.x[1]).toBe(Math.PI);
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
