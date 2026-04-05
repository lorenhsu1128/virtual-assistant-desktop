import { describe, it, expect, vi } from 'vitest';
import { BehaviorAnimationBridge } from '../../src/behavior/BehaviorAnimationBridge';
import type { BehaviorOutput } from '../../src/types/behavior';
import type { AnimationManager } from '../../src/animation/AnimationManager';

function makeMockAnimationManager() {
  return {
    playByCategory: vi.fn().mockReturnValue(true),
    hasCategory: vi.fn().mockReturnValue(true),
    isSystemAnimationPlaying: vi.fn().mockReturnValue(false),
    playSystemAnimation: vi.fn().mockReturnValue(true),
    stopSystemAnimation: vi.fn(),
  } as unknown as AnimationManager;
}

function makeOutput(overrides?: Partial<BehaviorOutput>): BehaviorOutput {
  return {
    currentState: 'idle',
    previousState: 'idle',
    stateChanged: false,
    targetPosition: null,
    facingDirection: 1,
    attachedWindowHwnd: null,
    traversingWindowHwnd: null,
    ...overrides,
  };
}

describe('BehaviorAnimationBridge', () => {
  it('should not trigger animation when state has not changed', () => {
    const manager = makeMockAnimationManager();
    const bridge = new BehaviorAnimationBridge(manager);

    bridge.update(makeOutput({ stateChanged: false }));

    expect(manager.playByCategory).not.toHaveBeenCalled();
  });

  it('should trigger idle animation on state change to idle', () => {
    const manager = makeMockAnimationManager();
    const bridge = new BehaviorAnimationBridge(manager);

    bridge.update(makeOutput({ currentState: 'idle', stateChanged: true }));

    expect(manager.playByCategory).toHaveBeenCalledWith('idle');
  });

  it('should trigger sit animation on state change to sit', () => {
    const manager = makeMockAnimationManager();
    const bridge = new BehaviorAnimationBridge(manager);

    bridge.update(makeOutput({ currentState: 'sit', stateChanged: true }));

    expect(manager.playByCategory).toHaveBeenCalledWith('sit');
  });

  it('should trigger fall animation on state change to fall', () => {
    const manager = makeMockAnimationManager();
    const bridge = new BehaviorAnimationBridge(manager);

    bridge.update(makeOutput({ currentState: 'fall', stateChanged: true }));

    expect(manager.playByCategory).toHaveBeenCalledWith('fall');
  });

  it('should trigger peek animation on state change to peek', () => {
    const manager = makeMockAnimationManager();
    const bridge = new BehaviorAnimationBridge(manager);

    bridge.update(makeOutput({ currentState: 'peek', stateChanged: true }));

    expect(manager.playByCategory).toHaveBeenCalledWith('peek');
  });

  it('should play system animation for walk state', () => {
    const manager = makeMockAnimationManager();
    const bridge = new BehaviorAnimationBridge(manager);

    bridge.update(makeOutput({ currentState: 'walk', stateChanged: true }));

    expect(manager.playSystemAnimation).toHaveBeenCalledWith('walk');
  });

  it('should play system animation for drag state', () => {
    const manager = makeMockAnimationManager();
    const bridge = new BehaviorAnimationBridge(manager);

    bridge.update(makeOutput({ currentState: 'drag', stateChanged: true }));

    expect(manager.playSystemAnimation).toHaveBeenCalledWith('drag');
  });

  it('should stop system animation when leaving walk state', () => {
    const manager = makeMockAnimationManager();
    (manager.isSystemAnimationPlaying as ReturnType<typeof vi.fn>).mockReturnValue(true);
    const bridge = new BehaviorAnimationBridge(manager);

    bridge.update(makeOutput({ currentState: 'idle', previousState: 'walk', stateChanged: true }));

    expect(manager.stopSystemAnimation).toHaveBeenCalled();
  });

  it('should fallback to idle when target category has no animation', () => {
    const manager = makeMockAnimationManager();
    (manager.playByCategory as ReturnType<typeof vi.fn>)
      .mockReturnValueOnce(false) // sit failed
      .mockReturnValueOnce(true); // idle succeeded
    const bridge = new BehaviorAnimationBridge(manager);

    bridge.update(makeOutput({ currentState: 'sit', stateChanged: true }));

    expect(manager.playByCategory).toHaveBeenCalledTimes(2);
    expect(manager.playByCategory).toHaveBeenNthCalledWith(1, 'sit');
    expect(manager.playByCategory).toHaveBeenNthCalledWith(2, 'idle');
  });

  it('should not reference collide animation (bounce removed)', () => {
    const manager = makeMockAnimationManager();
    const bridge = new BehaviorAnimationBridge(manager);

    // No state change → no animation call
    bridge.update(makeOutput({ stateChanged: false }));

    expect(manager.playByCategory).not.toHaveBeenCalled();
  });
});
