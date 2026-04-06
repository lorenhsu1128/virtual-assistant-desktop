import { describe, it, expect } from 'vitest';
import { CinematicRunner } from '../../src/cinematic/CinematicRunner';
import type { CinematicConfig } from '../../src/types/cinematic';

function makeConfig(overrides?: Partial<CinematicConfig>): CinematicConfig {
  return {
    screenWidth: 1920,
    screenHeight: 1080,
    characterWidth: 300,
    characterHeight: 500,
    originalPosition: { x: 800, y: 600 },
    originalScale: 1.0,
    availableExpressions: ['happy', 'angry', 'sad', 'relaxed', 'surprised', 'neutral'],
    ...overrides,
  };
}

describe('CinematicRunner', () => {
  it('starts in run-in phase', () => {
    const runner = new CinematicRunner(makeConfig());
    const frame = runner.tick(0.016);
    expect(frame.phase).toBe('run-in');
    expect(runner.isFinished()).toBe(false);
  });

  it('starts from original position', () => {
    const config = makeConfig({ originalPosition: { x: 400, y: 300 } });
    const runner = new CinematicRunner(config);
    const frame = runner.tick(0.001); // very small tick
    expect(frame.positionX).toBeCloseTo(400, 0);
    expect(frame.positionY).toBeCloseTo(300, 0);
  });

  it('scale increases during run-in', () => {
    const runner = new CinematicRunner(makeConfig());
    const frame1 = runner.tick(0.5);
    const frame2 = runner.tick(0.5);
    expect(frame2.scale).toBeGreaterThan(frame1.scale);
  });

  it('position moves toward end during run-in', () => {
    const runner = new CinematicRunner(makeConfig());
    const frame1 = runner.tick(0.5);
    const frame2 = runner.tick(0.5);
    expect(frame1.positionX).not.toBe(frame2.positionX);
  });

  it('transitions to hold phase after run-in duration', () => {
    const runner = new CinematicRunner(makeConfig());
    runner.tick(2.6);
    const frame = runner.tick(0.016);
    expect(frame.phase).toBe('hold');
  });

  it('hold phase has max scale and no walk', () => {
    const runner = new CinematicRunner(makeConfig());
    runner.tick(2.6);
    const frame = runner.tick(0.016);
    expect(frame.scale).toBe(6.0);
    expect(frame.walkSpeed).toBe(0);
    expect(frame.facingReversed).toBe(false);
  });

  it('endY positions head at screen center', () => {
    // With scale=6 and originalScale=1, model is 6x taller
    // Head should be near screenHeight/2
    const config = makeConfig({ screenHeight: 1080, characterHeight: 500, originalScale: 1.0 });
    const runner = new CinematicRunner(config);
    runner.tick(2.6);
    const frame = runner.tick(0.016);
    // endY = 1080/2 + 500*(6/1 - 1) = 540 + 2500 = 3040
    // feetY = 3040 + 500 = 3540
    // headY = 3540 - 500*6 = 3540 - 3000 = 540 = screen center ✓
    expect(frame.positionY).toBeCloseTo(3040, 0);
  });

  it('transitions to run-out phase after hold duration (all expressions × 3s)', () => {
    const runner = new CinematicRunner(makeConfig());
    runner.tick(2.6);  // past run-in
    runner.tick(18.1); // past hold (5 × 4s = 20s)
    const frame = runner.tick(0.016);
    expect(frame.phase).toBe('run-out');
  });

  it('run-out phase has reversed facing and walk', () => {
    const runner = new CinematicRunner(makeConfig());
    runner.tick(2.6);
    runner.tick(18.1);
    const frame = runner.tick(0.5);
    expect(frame.facingReversed).toBe(true);
    expect(frame.walkSpeed).toBeGreaterThan(0);
  });

  it('scale decreases during run-out', () => {
    const runner = new CinematicRunner(makeConfig());
    runner.tick(2.6);
    runner.tick(18.1);
    const frame1 = runner.tick(0.5);
    const frame2 = runner.tick(0.5);
    expect(frame2.scale).toBeLessThan(frame1.scale);
  });

  it('finishes after all phases complete', () => {
    const runner = new CinematicRunner(makeConfig());
    runner.tick(2.6);
    runner.tick(18.1);
    runner.tick(2.1);
    const frame = runner.tick(0.016);
    expect(frame.phase).toBe('done');
    expect(runner.isFinished()).toBe(true);
  });

  it('done frame restores original position and scale', () => {
    const config = makeConfig({ originalPosition: { x: 123, y: 456 }, originalScale: 1.5 });
    const runner = new CinematicRunner(config);
    runner.tick(2.6);
    runner.tick(18.1);
    runner.tick(2.1);
    const frame = runner.tick(0.016);
    expect(frame.positionX).toBe(123);
    expect(frame.positionY).toBe(456);
    expect(frame.scale).toBe(1.5);
    expect(frame.facingReversed).toBe(false);
  });

  it('shows expression during first 2s of hold cycle', () => {
    const runner = new CinematicRunner(makeConfig());
    runner.tick(2.6); // past run-in
    const frame = runner.tick(1.0); // 1s into hold → within first expression display
    expect(frame.expression).not.toBeNull();
  });

  it('clears expression during gap period', () => {
    const runner = new CinematicRunner(makeConfig());
    runner.tick(2.6);
    const frame = runner.tick(2.5); // 2.5s into hold → in gap (display=2s, gap=1s, cycle=3s)
    expect(frame.expression).toBeNull();
  });

  it('cycles through all available expressions', () => {
    const runner = new CinematicRunner(makeConfig());
    runner.tick(2.6);
    const expressions = new Set<string>();
    // Sample at the middle of each expression display period (cycle = 3s)
    for (let i = 0; i < 6; i++) {
      const frame = runner.tick(i === 0 ? 1.0 : 3.0); // first: 1s, rest: next cycle
      if (frame.expression) expressions.add(frame.expression);
    }
    expect(expressions.size).toBe(6);
  });

  it('run-in has no expression', () => {
    const runner = new CinematicRunner(makeConfig());
    const frame = runner.tick(1.0);
    expect(frame.expression).toBeNull();
  });

  it('no expressions when available list is empty', () => {
    const config = makeConfig({ availableExpressions: [] });
    const runner = new CinematicRunner(config);
    runner.tick(2.6);
    const frame = runner.tick(1.0);
    expect(frame.expression).toBeNull();
  });
});
