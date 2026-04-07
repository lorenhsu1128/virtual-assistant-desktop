import { describe, it, expect, beforeEach } from 'vitest';
import { ExpressionManager } from '../../src/expression/ExpressionManager';

/** 過渡完成所需的時間（略大於 TRANSITION_DURATION 0.5s） */
const TRANSITION_COMPLETE = 0.6;

describe('ExpressionManager', () => {
  let em: ExpressionManager;

  beforeEach(() => {
    em = new ExpressionManager();
    em.setAvailableExpressions(['happy', 'sad', 'angry', 'surprised', 'neutral']);
    em.setAutoEnabled(false); // 預設關掉自動，避免干擾手動測試
  });

  describe('manual expression', () => {
    it('should return manual expression after transition completes', () => {
      em.setManualExpression('happy');
      em.update(TRANSITION_COMPLETE);
      const state = em.resolve();
      expect(state.current?.name).toBe('happy');
      expect(state.current?.value).toBe(1.0);
    });

    it('should start at value 0 immediately after setManualExpression', () => {
      em.setManualExpression('happy');
      // 不呼叫 update（或 update(0)）→ value 仍為初始 0
      const state = em.resolve();
      expect(state.current?.name).toBe('happy');
      expect(state.current?.value).toBe(0);
    });

    it('should fade in linearly across transition duration', () => {
      em.setManualExpression('happy');
      em.update(0.25); // 大約一半的過渡時長 (0.5s)
      const mid = em.resolve();
      expect(mid.current?.value).toBeGreaterThan(0.4);
      expect(mid.current?.value).toBeLessThan(0.6);
    });

    it('should clear manual expression with null and fade out', () => {
      em.setManualExpression('happy');
      em.update(TRANSITION_COMPLETE); // happy at 1.0
      em.setManualExpression(null);
      // null 後 happy 進入 previous slot fading out
      const state = em.resolve();
      expect(state.previous?.name).toBe('happy');
      expect(state.previous?.value).toBe(1.0); // 還沒推進
      expect(state.current).toBeNull();

      em.update(TRANSITION_COMPLETE);
      const after = em.resolve();
      expect(after.previous).toBeNull();
      expect(after.current).toBeNull();
    });

    it('switching expression should crossfade old out, new in', () => {
      em.setManualExpression('happy');
      em.update(TRANSITION_COMPLETE); // happy at 1.0

      em.setManualExpression('sad');
      // 切換瞬間：happy 進 previous（仍 1.0），sad 進 current（從 0）
      const init = em.resolve();
      expect(init.previous?.name).toBe('happy');
      expect(init.previous?.value).toBe(1.0);
      expect(init.current?.name).toBe('sad');
      expect(init.current?.value).toBe(0);

      em.update(0.25); // 過渡中段
      const mid = em.resolve();
      expect(mid.previous?.name).toBe('happy');
      expect(mid.previous?.value).toBeLessThan(0.6);
      expect(mid.current?.name).toBe('sad');
      expect(mid.current?.value).toBeGreaterThan(0.4);

      em.update(TRANSITION_COMPLETE); // 過渡完成
      const done = em.resolve();
      expect(done.previous).toBeNull(); // happy 已 fade out 完
      expect(done.current?.name).toBe('sad');
      expect(done.current?.value).toBe(1.0);
    });

    it('returns null state when no manual and auto disabled', () => {
      const state = em.resolve();
      expect(state.current).toBeNull();
      expect(state.previous).toBeNull();
    });

    it('setManualExpression(name) on same name should be no-op (no transition)', () => {
      em.setManualExpression('happy');
      em.update(TRANSITION_COMPLETE); // happy at 1.0
      em.setManualExpression('happy'); // 同名再 set
      const state = em.resolve();
      expect(state.current?.name).toBe('happy');
      expect(state.current?.value).toBe(1.0); // 不會重置為 0
      expect(state.previous).toBeNull();
    });
  });

  describe('auto expression', () => {
    it('should pick auto expression after interval', () => {
      em.setAutoEnabled(true);
      // Simulate enough time passing (max interval is 45s) + 過渡時間
      em.update(50);
      const state = em.resolve();
      expect(state.current).not.toBeNull();
      expect(em.getAvailableExpressions()).toContain(state.current?.name);
    });

    it('should not pick when auto is disabled', () => {
      em.setAutoEnabled(false);
      em.update(50);
      const state = em.resolve();
      expect(state.current).toBeNull();
    });

    it('should respect allowed auto expressions', () => {
      em.setAutoEnabled(true);
      em.setAllowedAutoExpressions(['happy', 'sad']);
      em.update(50);
      const state = em.resolve();
      expect(state.current).not.toBeNull();
      expect(['happy', 'sad']).toContain(state.current?.name);
    });

    it('should filter out expressions not in available list', () => {
      em.setAutoEnabled(true);
      em.setAllowedAutoExpressions(['happy', 'nonexistent']);
      em.update(50);
      const state = em.resolve();
      expect(state.current).not.toBeNull();
      expect(state.current?.name).toBe('happy');
    });
  });

  describe('priority', () => {
    it('manual should override auto', () => {
      em.setAutoEnabled(true);
      em.update(50); // trigger auto pick
      em.setManualExpression('angry');
      em.update(TRANSITION_COMPLETE);
      const state = em.resolve();
      expect(state.current?.name).toBe('angry');
    });
  });

  describe('getters', () => {
    it('should report auto enabled state', () => {
      expect(em.isAutoEnabled()).toBe(false); // 已在 beforeEach 設為 false
      em.setAutoEnabled(true);
      expect(em.isAutoEnabled()).toBe(true);
    });

    it('should report manual expression name', () => {
      expect(em.getManualExpression()).toBeNull();
      em.setManualExpression('sad');
      expect(em.getManualExpression()).toBe('sad');
    });

    it('should return available expressions', () => {
      expect(em.getAvailableExpressions()).toEqual(['happy', 'sad', 'angry', 'surprised', 'neutral']);
    });
  });

  describe('edge cases', () => {
    it('should handle empty available expressions', () => {
      em.setAvailableExpressions([]);
      em.setAutoEnabled(true);
      em.update(50);
      const state = em.resolve();
      expect(state.current).toBeNull();
    });

    it('should handle single expression', () => {
      em.setAvailableExpressions(['happy']);
      em.setAutoEnabled(true);
      em.update(50);
      em.update(TRANSITION_COMPLETE);
      const state = em.resolve();
      expect(state.current?.name).toBe('happy');
    });

    it('value should not exceed 1.0 even with very large deltaTime', () => {
      em.setManualExpression('happy');
      em.update(100);
      expect(em.resolve().current?.value).toBe(1.0);
    });

    it('fade out should not produce negative value', () => {
      em.setManualExpression('happy');
      em.update(TRANSITION_COMPLETE);
      em.setManualExpression(null);
      em.update(100);
      const state = em.resolve();
      expect(state.previous).toBeNull(); // fully faded out
    });
  });
});
