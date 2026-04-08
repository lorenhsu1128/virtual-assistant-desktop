import { describe, it, expect, vi } from 'vitest';
import { BehaviorAnimationBridge } from '../../src/behavior/BehaviorAnimationBridge';
import type { BehaviorOutput } from '../../src/types/behavior';
import type { AnimationManager, LoadedPoolClip } from '../../src/animation/AnimationManager';

/** 建立模擬 AnimationManager（只 mock Bridge 實際呼叫的方法） */
function makeMockAnimationManager() {
  const fakeClip = { duration: 1.5 } as unknown as LoadedPoolClip['clip'];
  const fakePicked: LoadedPoolClip = { fileName: 'SYS_FAKE_01.vrma', clip: fakeClip };
  return {
    playStateRandom: vi.fn().mockReturnValue(fakePicked),
    stopStateAnimation: vi.fn(),
    hasStatePool: vi.fn().mockReturnValue(true),
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
    peekTargetHwnd: null,
    peekSide: null,
    ...overrides,
  };
}

describe('BehaviorAnimationBridge', () => {
  it('should not trigger animation when state has not changed', () => {
    const manager = makeMockAnimationManager();
    const bridge = new BehaviorAnimationBridge(manager);

    bridge.update(makeOutput({ stateChanged: false }));

    expect(manager.playStateRandom).not.toHaveBeenCalled();
    expect(manager.stopStateAnimation).not.toHaveBeenCalled();
  });

  it('should call stopStateAnimation on state change to idle', () => {
    const manager = makeMockAnimationManager();
    const bridge = new BehaviorAnimationBridge(manager);

    bridge.update(makeOutput({ currentState: 'idle', previousState: 'walk', stateChanged: true }));

    expect(manager.stopStateAnimation).toHaveBeenCalled();
    expect(manager.playStateRandom).not.toHaveBeenCalled();
  });

  it('should play random sit from sit pool on state change to sit', () => {
    const manager = makeMockAnimationManager();
    const bridge = new BehaviorAnimationBridge(manager);

    bridge.update(makeOutput({ currentState: 'sit', stateChanged: true }));

    expect(manager.playStateRandom).toHaveBeenCalledWith('sit');
  });

  it('should play fall pool on state change to fall', () => {
    const manager = makeMockAnimationManager();
    const bridge = new BehaviorAnimationBridge(manager);

    bridge.update(makeOutput({ currentState: 'fall', stateChanged: true }));

    expect(manager.playStateRandom).toHaveBeenCalledWith('fall');
  });

  it('should play peek with right side by default', () => {
    const manager = makeMockAnimationManager();
    const bridge = new BehaviorAnimationBridge(manager);

    bridge.update(makeOutput({ currentState: 'peek', stateChanged: true }));

    expect(manager.playStateRandom).toHaveBeenCalledWith('peek', 'right');
  });

  it('should play peek with left side when peekSide is left', () => {
    const manager = makeMockAnimationManager();
    const bridge = new BehaviorAnimationBridge(manager);

    // 先發送 peekSide='left' 的 output（stateChanged=false 也會更新 lastPeekSide）
    bridge.update(makeOutput({ peekSide: 'left', stateChanged: false }));
    // 再觸發狀態轉換
    bridge.update(makeOutput({ currentState: 'peek', peekSide: 'left', stateChanged: true }));

    expect(manager.playStateRandom).toHaveBeenCalledWith('peek', 'left');
  });

  it('should play walk pool and trigger onWalkClipPicked callback', () => {
    const manager = makeMockAnimationManager();
    const onWalkClipPicked = vi.fn();
    const bridge = new BehaviorAnimationBridge(manager, undefined, onWalkClipPicked);

    bridge.update(makeOutput({ currentState: 'walk', stateChanged: true }));

    expect(manager.playStateRandom).toHaveBeenCalledWith('walk');
    expect(onWalkClipPicked).toHaveBeenCalledTimes(1);
  });

  it('should play hide pool and trigger onWalkClipPicked callback', () => {
    const manager = makeMockAnimationManager();
    const onWalkClipPicked = vi.fn();
    const bridge = new BehaviorAnimationBridge(manager, undefined, onWalkClipPicked);

    bridge.update(makeOutput({ currentState: 'hide', stateChanged: true }));

    expect(manager.playStateRandom).toHaveBeenCalledWith('hide');
    expect(onWalkClipPicked).toHaveBeenCalledTimes(1);
  });

  it('should play drag pool on state change to drag', () => {
    const manager = makeMockAnimationManager();
    const bridge = new BehaviorAnimationBridge(manager);

    bridge.update(makeOutput({ currentState: 'drag', stateChanged: true }));

    expect(manager.playStateRandom).toHaveBeenCalledWith('drag');
  });

  it('should NOT call onWalkClipPicked when pool is empty (playStateRandom returns null)', () => {
    const manager = makeMockAnimationManager();
    (manager.playStateRandom as ReturnType<typeof vi.fn>).mockReturnValue(null);
    const onWalkClipPicked = vi.fn();
    const bridge = new BehaviorAnimationBridge(manager, undefined, onWalkClipPicked);

    bridge.update(makeOutput({ currentState: 'walk', stateChanged: true }));

    expect(onWalkClipPicked).not.toHaveBeenCalled();
  });

  it('should setWalkClipPickedCallback via method after construction', () => {
    const manager = makeMockAnimationManager();
    const bridge = new BehaviorAnimationBridge(manager);
    const onWalkClipPicked = vi.fn();
    bridge.setWalkClipPickedCallback(onWalkClipPicked);

    bridge.update(makeOutput({ currentState: 'walk', stateChanged: true }));

    expect(onWalkClipPicked).toHaveBeenCalledTimes(1);
  });
});
