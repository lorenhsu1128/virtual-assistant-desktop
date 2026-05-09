import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  MascotActionDispatcher,
  matchExpression,
} from '../../src/agent/MascotActionDispatcher';

/**
 * 測試 MascotActionDispatcher：純路由邏輯，注入 mock managers，
 * 不接 IPC（直接呼叫 handle 方法）。
 */

interface MockExpressionManager {
  available: string[];
  manualName: string | null;
  getAvailableExpressions: () => string[];
  setManualExpression: (name: string | null) => void;
}

interface MockAnimationManager {
  playByName: ReturnType<typeof vi.fn>;
  playByCategory: ReturnType<typeof vi.fn>;
}

function makeMocks(available: string[] = ['joy', 'angry', 'Surprised']): {
  exp: MockExpressionManager;
  anim: MockAnimationManager;
} {
  const exp: MockExpressionManager = {
    available,
    manualName: null,
    getAvailableExpressions: () => exp.available,
    setManualExpression: (name) => {
      exp.manualName = name;
    },
  };
  const anim: MockAnimationManager = {
    playByName: vi.fn(),
    playByCategory: vi.fn(),
  };
  return { exp, anim };
}

describe('matchExpression', () => {
  it('returns exact match', () => {
    expect(matchExpression('joy', ['joy', 'angry'])).toBe('joy');
  });
  it('returns case-insensitive match', () => {
    expect(matchExpression('joy', ['Joy', 'Angry'])).toBe('Joy');
  });
  it('returns null when no match', () => {
    expect(matchExpression('xyz', ['joy', 'angry'])).toBeNull();
  });
  it('prefers exact case match over insensitive', () => {
    // 兩個都符合時，先回 exact match
    expect(matchExpression('Joy', ['joy', 'Joy'])).toBe('Joy');
  });
});

describe('MascotActionDispatcher.handle', () => {
  let mocks: ReturnType<typeof makeMocks>;
  let dispatcher: MascotActionDispatcher;
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    mocks = makeMocks();
    dispatcher = new MascotActionDispatcher({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expressionManager: mocks.exp as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      animationManager: mocks.anim as any,
    });
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  describe('set_expression', () => {
    it('routes to setManualExpression with exact match', () => {
      dispatcher.handle({ id: 't1', kind: 'set_expression', name: 'joy' });
      expect(mocks.exp.manualName).toBe('joy');
    });

    it('case-insensitively matches and uses model casing', () => {
      dispatcher.handle({ id: 't1', kind: 'set_expression', name: 'surprised' });
      expect(mocks.exp.manualName).toBe('Surprised');
    });

    it('rejects unknown expression with warn, no setManual call', () => {
      dispatcher.handle({ id: 't1', kind: 'set_expression', name: 'xyz' });
      expect(mocks.exp.manualName).toBeNull();
      expect(warnSpy).toHaveBeenCalled();
    });
  });

  describe('play_animation', () => {
    it('routes name to playByName', () => {
      dispatcher.handle({
        id: 't1',
        kind: 'play_animation',
        name: 'SYS_WAVE_01.vrma',
      });
      expect(mocks.anim.playByName).toHaveBeenCalledWith('SYS_WAVE_01.vrma');
      expect(mocks.anim.playByCategory).not.toHaveBeenCalled();
    });

    it('routes category to playByCategory', () => {
      dispatcher.handle({ id: 't1', kind: 'play_animation', category: 'idle' });
      expect(mocks.anim.playByCategory).toHaveBeenCalledWith('idle');
      expect(mocks.anim.playByName).not.toHaveBeenCalled();
    });

    it('prefers name when both given', () => {
      dispatcher.handle({
        id: 't1',
        kind: 'play_animation',
        category: 'idle',
        name: 'SYS_WAVE_01.vrma',
      });
      expect(mocks.anim.playByName).toHaveBeenCalled();
      expect(mocks.anim.playByCategory).not.toHaveBeenCalled();
    });
  });

  describe('say / look_at_screen', () => {
    it('say does not throw (P2 just logs)', () => {
      expect(() =>
        dispatcher.handle({ id: 't1', kind: 'say', text: 'hi' }),
      ).not.toThrow();
    });

    it('look_at_screen does not throw (placeholder for v0.5)', () => {
      expect(() =>
        dispatcher.handle({ id: 't1', kind: 'look_at_screen', x: 100, y: 200 }),
      ).not.toThrow();
    });
  });
});
