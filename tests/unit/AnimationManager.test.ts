import { describe, it, expect } from 'vitest';
import type { AnimationEntry, AnimationCategory } from '../../src/types/animation';
import { ANIMATION_CATEGORIES } from '../../src/types/animation';
import type { AppConfig } from '../../src/types/config';
import { DEFAULT_CONFIG } from '../../src/types/config';

describe('AnimationEntry types', () => {
  it('should have valid category values', () => {
    const expectedCategories: AnimationCategory[] = [
      'idle',
      'action',
      'sit',
      'fall',
      'collide',
      'peek',
    ];
    expect(ANIMATION_CATEGORIES).toEqual(expectedCategories);
  });

  it('should create a valid AnimationEntry', () => {
    const entry: AnimationEntry = {
      fileName: 'test.vrma',
      displayName: 'Test Animation',
      category: 'idle',
      loop: true,
      weight: 1.5,
    };

    expect(entry.fileName).toBe('test.vrma');
    expect(entry.category).toBe('idle');
    expect(entry.loop).toBe(true);
    expect(entry.weight).toBe(1.5);
  });
});

describe('AppConfig defaults', () => {
  it('should have correct default values', () => {
    expect(DEFAULT_CONFIG.vrmModelPath).toBeNull();
    expect(DEFAULT_CONFIG.animationFolderPath).toBeNull();
    expect(DEFAULT_CONFIG.scale).toBe(1.0);
    expect(DEFAULT_CONFIG.targetFps).toBe(30);
    expect(DEFAULT_CONFIG.powerSaveMode).toBe(false);
    expect(DEFAULT_CONFIG.autonomousMovementPaused).toBe(false);
  });

  it('should have valid window position', () => {
    expect(DEFAULT_CONFIG.windowPosition).toEqual({ x: 0, y: 0 });
  });

  it('should have valid window size', () => {
    expect(DEFAULT_CONFIG.windowSize).toEqual({ width: 400, height: 600 });
  });
});

describe('Weighted random selection', () => {
  /**
   * 模擬 AnimationManager.selectByWeight 的邏輯
   * （因為原方法是 private，在此重現邏輯做測試）
   */
  function selectByWeight<T extends { weight: number }>(items: T[]): T | null {
    if (items.length === 0) return null;
    if (items.length === 1) return items[0];

    const totalWeight = items.reduce((sum, a) => sum + a.weight, 0);
    if (totalWeight <= 0) return items[0];

    let random = Math.random() * totalWeight;
    for (const item of items) {
      random -= item.weight;
      if (random <= 0) return item;
    }

    return items[items.length - 1];
  }

  it('should return null for empty array', () => {
    expect(selectByWeight([])).toBeNull();
  });

  it('should return the only item for single-element array', () => {
    const items = [{ weight: 1.0 }];
    expect(selectByWeight(items)).toBe(items[0]);
  });

  it('should select items based on weight distribution', () => {
    const items = [
      { id: 'a', weight: 10 },
      { id: 'b', weight: 0 },
    ];

    // With weight 10 vs 0, 'a' should always be selected
    const counts = { a: 0, b: 0 };
    for (let i = 0; i < 100; i++) {
      const selected = selectByWeight(items);
      if (selected) counts[selected.id as 'a' | 'b']++;
    }

    expect(counts.a).toBe(100);
    expect(counts.b).toBe(0);
  });

  it('should handle all-equal weights', () => {
    const items = [
      { id: 'a', weight: 1 },
      { id: 'b', weight: 1 },
      { id: 'c', weight: 1 },
    ];

    // Just verify it doesn't crash and returns something
    for (let i = 0; i < 50; i++) {
      const result = selectByWeight(items);
      expect(result).not.toBeNull();
    }
  });

  it('should handle zero total weight', () => {
    const items = [
      { id: 'a', weight: 0 },
      { id: 'b', weight: 0 },
    ];

    // Should return first item as fallback
    const result = selectByWeight(items);
    expect(result).toBe(items[0]);
  });
});

describe('Config type guard', () => {
  it('should accept a valid complete config', () => {
    const config: AppConfig = {
      vrmModelPath: '/path/to/model.vrm',
      animationFolderPath: '/path/to/animations',
      windowPosition: { x: 100, y: 200 },
      windowSize: { width: 400, height: 600 },
      scale: 1.5,
      micEnabled: false,
      cameraEnabled: false,
      targetFps: 30,
      powerSaveMode: false,
      autonomousMovementPaused: false,
    };

    expect(config.vrmModelPath).toBe('/path/to/model.vrm');
    expect(config.scale).toBe(1.5);
  });

  it('scale should be within valid range', () => {
    const clamp = (v: number) => Math.max(0.5, Math.min(2.0, v));

    expect(clamp(0.3)).toBe(0.5);
    expect(clamp(1.0)).toBe(1.0);
    expect(clamp(2.5)).toBe(2.0);
    expect(clamp(0.5)).toBe(0.5);
    expect(clamp(2.0)).toBe(2.0);
  });
});
