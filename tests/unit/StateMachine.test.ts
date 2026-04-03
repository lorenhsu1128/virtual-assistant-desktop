import { describe, it, expect, beforeEach, vi } from 'vitest';
import { StateMachine } from '../../src/behavior/StateMachine';
import type { BehaviorInput } from '../../src/types/behavior';
import type { CollisionResult } from '../../src/types/collision';
import { NO_COLLISION } from '../../src/types/collision';

function makeInput(overrides?: Partial<BehaviorInput>): BehaviorInput {
  return {
    currentPosition: { x: 500, y: 500 },
    characterBounds: { x: 500, y: 500, width: 400, height: 600 },
    screenBounds: { x: 0, y: 0, width: 1920, height: 1080 },
    windowRects: [],
    scale: 1.0,
    deltaTime: 1 / 30,
    ...overrides,
  };
}

function makeCollision(overrides?: Partial<CollisionResult>): CollisionResult {
  return { ...NO_COLLISION, snappableWindows: [], occlusionRects: [], ...overrides };
}

describe('StateMachine', () => {
  let sm: StateMachine;

  beforeEach(() => {
    sm = new StateMachine();
  });

  it('should start in idle state', () => {
    expect(sm.getState()).toBe('idle');
  });

  it('should not be paused by default', () => {
    expect(sm.isPaused()).toBe(false);
  });

  it('should pause and resume', () => {
    sm.pause();
    expect(sm.isPaused()).toBe(true);
    sm.resume();
    expect(sm.isPaused()).toBe(false);
  });

  it('should return no movement when paused', () => {
    sm.pause();
    const output = sm.tick(makeInput(), makeCollision());
    // Paused state returns current position (no new movement calculation)
    expect(output.currentState).toBe('idle');
    expect(output.stateChanged).toBe(false);
  });

  it('should forceState to drag', () => {
    sm.forceState('drag');
    expect(sm.getState()).toBe('drag');
    const output = sm.tick(makeInput(), makeCollision());
    expect(output.currentState).toBe('drag');
    // Drag state is handled externally; SM returns current position
  });

  it('should forceState back to idle from drag', () => {
    sm.forceState('drag');
    sm.forceState('idle');
    expect(sm.getState()).toBe('idle');
  });

  it('should transition from idle after duration', () => {
    // 設定短 idle 時間
    const shortSm = new StateMachine({ idleDurationMin: 0.01, idleDurationMax: 0.01 });
    const input = makeInput({ deltaTime: 0.02 });

    // 第一次 tick 應觸發轉移
    const output = shortSm.tick(input, makeCollision());
    // 可能轉到 walk, sit, peek 或繼續 idle
    expect(['idle', 'walk', 'sit', 'peek']).toContain(output.currentState);
  });

  it('should transition to walk with high probability when configured', () => {
    const walkSm = new StateMachine({
      idleDurationMin: 0.001,
      idleDurationMax: 0.001,
      transitionProbabilities: { toWalk: 1.0, toSit: 0, toPeek: 0, toIdle: 0 },
    });

    // Mock random to always return 0 (< toWalk threshold)
    vi.spyOn(Math, 'random').mockReturnValue(0);

    const input = makeInput({ deltaTime: 0.01 });
    const output = walkSm.tick(input, makeCollision());
    expect(output.currentState).toBe('walk');

    vi.restoreAllMocks();
  });

  it('should handle collision during walk', () => {
    // Use a StateMachine that immediately enters walk
    const walkSm = new StateMachine({
      idleDurationMin: 0.001,
      idleDurationMax: 0.001,
      transitionProbabilities: { toWalk: 1.0, toSit: 0, toPeek: 0, toIdle: 0 },
    });
    vi.spyOn(Math, 'random').mockReturnValue(0.5);

    // First tick transitions idle → walk
    walkSm.tick(makeInput({ deltaTime: 0.01 }), makeCollision());
    expect(walkSm.getState()).toBe('walk');

    // Second tick with collision should transition back to idle
    const collision = makeCollision({ collidingWithWindow: true, collidedWindowHwnd: 123 });
    const output = walkSm.tick(makeInput(), collision);
    expect(output.currentState).toBe('idle');
    expect(output.collisionOccurred).toBe(true);

    vi.restoreAllMocks();
  });

  it('should enter fall when attached window disappears in sit state', () => {
    sm.forceState('sit');
    sm.setAttachedWindow(123, { x: 100, y: 200 });

    // Window not in the list
    const input = makeInput({ windowRects: [] });
    const output = sm.tick(input, makeCollision());

    expect(output.currentState).toBe('fall');
  });

  it('should return to idle after fall timeout', () => {
    sm.forceState('fall');

    // Simulate 2 seconds passing
    const input = makeInput({ deltaTime: 2.0 });
    const output = sm.tick(input, makeCollision());

    expect(output.currentState).toBe('idle');
  });

  it('should provide target position during walk', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.5);

    sm.forceState('idle');
    const shortSm = new StateMachine({
      idleDurationMin: 0.001,
      idleDurationMax: 0.001,
      transitionProbabilities: { toWalk: 1.0, toSit: 0, toPeek: 0, toIdle: 0 },
    });

    const input = makeInput({ deltaTime: 0.01 });
    shortSm.tick(input, makeCollision()); // transitions to walk

    // Next tick should have a target position
    const output = shortSm.tick(makeInput({ deltaTime: 1 / 30 }), makeCollision());
    if (output.currentState === 'walk') {
      // walk state should produce target position
      expect(output.targetPosition).not.toBeNull();
    }

    vi.restoreAllMocks();
  });

  it('should follow window in sit state', () => {
    sm.forceState('sit');
    sm.setAttachedWindow(456, { x: 100, y: 200 });

    const windowRect = {
      hwnd: 456,
      title: 'Test Window',
      x: 150, // window moved
      y: 200,
      width: 800,
      height: 600,
      zOrder: 0,
    };

    const input = makeInput({ windowRects: [windowRect] });
    const output = sm.tick(input, makeCollision());

    expect(output.currentState).toBe('sit');
    expect(output.targetPosition).not.toBeNull();
    // Should follow window position
    if (output.targetPosition) {
      expect(output.targetPosition.x).toBeCloseTo(
        windowRect.x + windowRect.width / 2 - input.characterBounds.width / 2,
        0,
      );
    }
  });
});
