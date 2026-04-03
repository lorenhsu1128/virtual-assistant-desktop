import { describe, it, expect, beforeEach } from 'vitest';
import { ExpressionManager } from '../../src/expression/ExpressionManager';

describe('ExpressionManager', () => {
  let em: ExpressionManager;

  beforeEach(() => {
    em = new ExpressionManager();
    em.setAvailableExpressions(['happy', 'sad', 'angry', 'surprised', 'neutral']);
  });

  describe('manual expression', () => {
    it('should return manual expression when set', () => {
      em.setManualExpression('happy');
      const result = em.resolve();
      expect(result).not.toBeNull();
      expect(result?.name).toBe('happy');
      expect(result?.value).toBe(1.0);
    });

    it('should return null when no manual and no auto', () => {
      em.setAutoEnabled(false);
      const result = em.resolve();
      expect(result).toBeNull();
    });

    it('should clear manual expression with null', () => {
      em.setManualExpression('happy');
      em.setManualExpression(null);
      // With auto disabled, should be null
      em.setAutoEnabled(false);
      expect(em.resolve()).toBeNull();
    });
  });

  describe('auto expression', () => {
    it('should pick auto expression after interval', () => {
      em.setAutoEnabled(true);
      // Simulate enough time passing (max interval is 45s)
      em.update(50);
      const result = em.resolve();
      expect(result).not.toBeNull();
      expect(em.getAvailableExpressions()).toContain(result?.name);
    });

    it('should not pick when auto is disabled', () => {
      em.setAutoEnabled(false);
      em.update(50);
      const result = em.resolve();
      expect(result).toBeNull();
    });

    it('should respect allowed auto expressions', () => {
      em.setAllowedAutoExpressions(['happy', 'sad']);
      em.update(50);
      const result = em.resolve();
      expect(result).not.toBeNull();
      expect(['happy', 'sad']).toContain(result?.name);
    });

    it('should filter out expressions not in available list', () => {
      em.setAllowedAutoExpressions(['happy', 'nonexistent']);
      em.update(50);
      const result = em.resolve();
      expect(result).not.toBeNull();
      expect(result?.name).toBe('happy');
    });
  });

  describe('priority', () => {
    it('manual should override auto', () => {
      em.setAutoEnabled(true);
      em.update(50); // trigger auto pick
      em.setManualExpression('angry');

      const result = em.resolve();
      expect(result?.name).toBe('angry');
    });
  });

  describe('getters', () => {
    it('should report auto enabled state', () => {
      expect(em.isAutoEnabled()).toBe(true);
      em.setAutoEnabled(false);
      expect(em.isAutoEnabled()).toBe(false);
    });

    it('should report manual expression', () => {
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
      em.update(50);
      const result = em.resolve();
      expect(result).toBeNull();
    });

    it('should handle single expression', () => {
      em.setAvailableExpressions(['happy']);
      em.update(50);
      const result = em.resolve();
      expect(result?.name).toBe('happy');
    });
  });
});
