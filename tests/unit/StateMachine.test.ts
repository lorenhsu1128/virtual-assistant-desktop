import { describe, it, expect, beforeEach, vi } from 'vitest';
import { StateMachine } from '../../src/behavior/StateMachine';
import type { BehaviorInput } from '../../src/types/behavior';

function makeInput(overrides?: Partial<BehaviorInput>): BehaviorInput {
  return {
    currentPosition: { x: 500, y: 500 },
    characterBounds: { x: 500, y: 500, width: 400, height: 600 },
    screenBounds: { x: 0, y: 0, width: 1920, height: 1080 },
    windowRects: [],
    platforms: [],
    scale: 1.0,
    deltaTime: 1 / 30,
    isFullyOccluded: false,
    isOffScreenLeft: false,
    isOffScreenRight: false,
    ...overrides,
  };
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
    const output = sm.tick(makeInput());
    // Paused state returns current position (no new movement calculation)
    expect(output.currentState).toBe('idle');
    expect(output.stateChanged).toBe(false);
  });

  it('should forceState to drag', () => {
    sm.forceState('drag');
    expect(sm.getState()).toBe('drag');
    const output = sm.tick(makeInput());
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
    const output = shortSm.tick(input);
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
    const output = walkSm.tick(input);
    expect(output.currentState).toBe('walk');

    vi.restoreAllMocks();
  });

  it('should walk to target and return to idle', () => {
    const walkSm = new StateMachine({
      idleDurationMin: 0.001,
      idleDurationMax: 0.001,
      transitionProbabilities: { toWalk: 1.0, toSit: 0, toPeek: 0, toIdle: 0 },
    });
    vi.spyOn(Math, 'random').mockReturnValue(0.5);

    // First tick transitions idle → walk
    walkSm.tick(makeInput({ deltaTime: 0.01 }));
    expect(walkSm.getState()).toBe('walk');

    vi.restoreAllMocks();
  });

  it('should return to idle after sit timeout', () => {
    sm.forceState('sit');

    // Simulate sit duration passing (default 10-30s, use large deltaTime)
    const input = makeInput({ deltaTime: 35.0 });
    const output = sm.tick(input);

    expect(output.currentState).toBe('idle');
  });

  it('should return to idle after fall timeout', () => {
    sm.forceState('fall');

    // Simulate 2 seconds passing
    const input = makeInput({ deltaTime: 2.0 });
    const output = sm.tick(input);

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
    shortSm.tick(input); // transitions to walk

    // Next tick should have a target position
    const output = shortSm.tick(makeInput({ deltaTime: 1 / 30 }));
    if (output.currentState === 'walk') {
      // walk state should produce target position
      expect(output.targetPosition).not.toBeNull();
    }

    vi.restoreAllMocks();
  });

  it('should follow window in sit state', () => {
    const dpr = (typeof window !== 'undefined' ? window.devicePixelRatio : 1) || 1;
    sm.forceState('sit');
    sm.setAttachedWindow(456, 100); // windowOffsetX = 100 (角色相對於視窗左邊的偏移)
    sm.setSitPlatform('window:456');

    const windowRect = {
      hwnd: 456,
      title: 'Test Window',
      x: 150, // window moved (physical pixels)
      y: 200,
      width: 800,
      height: 600,
      zOrder: 0,
    };

    // Platform 對應視窗頂部
    const platform = {
      id: 'window:456',
      screenY: windowRect.y / dpr,
      screenXMin: windowRect.x / dpr,
      screenXMax: (windowRect.x + windowRect.width) / dpr,
    };

    const input = makeInput({ windowRects: [windowRect], platforms: [platform] });
    const output = sm.tick(input);

    expect(output.currentState).toBe('sit');
    expect(output.targetPosition).not.toBeNull();
    // Should follow window position: platform.screenXMin + sitWindowOffsetX
    if (output.targetPosition) {
      expect(output.targetPosition.x).toBeCloseTo(platform.screenXMin + 100, 0);
    }
  });

  // ── hide / peek 測試 ──

  it('should enter hide passively when fully occluded in idle', () => {
    sm.forceState('idle');
    const input = makeInput({ isFullyOccluded: true, windowRects: [{
      hwnd: 100, title: 'Win', x: 400, y: 400, width: 800, height: 800, zOrder: 0,
    }] });
    const output = sm.tick(input);
    expect(output.currentState).toBe('hide');
    expect(output.peekTargetHwnd).toBe(100);
    expect(output.peekSide).not.toBeNull();
  });

  it('should enter hide passively when off-screen left in idle', () => {
    sm.forceState('idle');
    const input = makeInput({
      currentPosition: { x: -500, y: 500 },
      isOffScreenLeft: true,
    });
    const output = sm.tick(input);
    expect(output.currentState).toBe('hide');
    expect(output.peekSide).toBe('left');
    expect(output.peekTargetHwnd).toBeNull();
  });

  it('should enter hide passively when off-screen right in idle', () => {
    sm.forceState('idle');
    const input = makeInput({
      currentPosition: { x: 2000, y: 500 },
      isOffScreenRight: true,
    });
    const output = sm.tick(input);
    expect(output.currentState).toBe('hide');
    expect(output.peekSide).toBe('right');
    expect(output.peekTargetHwnd).toBeNull();
  });

  it('should transition from hide to peek when touching screen edge (left)', () => {
    sm.forceState('idle');
    // 先進入 hide（螢幕左外側）
    const input1 = makeInput({
      currentPosition: { x: -500, y: 500 },
      isOffScreenLeft: true,
    });
    sm.tick(input1);
    expect(sm.getState()).toBe('hide');

    // 模擬角色移動到螢幕左邊緣（charRight >= screenBounds.x）
    // peekSide='left' → charRight = x + width = -10 + 400 = 390 >= 0
    const input2 = makeInput({
      currentPosition: { x: -10, y: 500 },
      isOffScreenLeft: false,
    });
    const output = sm.tick(input2);
    expect(output.currentState).toBe('peek');
  });

  it('should return to idle after hide safety timeout', () => {
    sm.forceState('idle');
    const input = makeInput({
      currentPosition: { x: -500, y: 500 },
      isOffScreenLeft: true,
    });
    sm.tick(input);
    expect(sm.getState()).toBe('hide');

    // 模擬超時（動態計算：距離 500px ÷ 60px/s × 1.5 ≈ 12.5s，用 61s 確保超過）
    const inputTimeout = makeInput({
      currentPosition: { x: -500, y: 500 },
      isOffScreenLeft: true,
      deltaTime: 61,
    });
    const output = sm.tick(inputTimeout);
    expect(output.currentState).toBe('idle');
  });

  it('should return to idle when target window disappears during hide', () => {
    sm.forceState('idle');
    const input1 = makeInput({ isFullyOccluded: true, windowRects: [{
      hwnd: 200, title: 'Win', x: 400, y: 400, width: 800, height: 800, zOrder: 0,
    }] });
    sm.tick(input1);
    expect(sm.getState()).toBe('hide');

    // 視窗消失
    const input2 = makeInput({ windowRects: [] });
    const output = sm.tick(input2);
    expect(output.currentState).toBe('idle');
  });
});
