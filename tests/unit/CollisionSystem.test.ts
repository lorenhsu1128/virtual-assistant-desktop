import { describe, it, expect, beforeEach } from 'vitest';
import { CollisionSystem } from '../../src/behavior/CollisionSystem';
import type { Rect, WindowRect } from '../../src/types/window';

function makeWindowRect(overrides?: Partial<WindowRect>): WindowRect {
  return {
    hwnd: 1,
    title: 'Test Window',
    x: 200,
    y: 200,
    width: 800,
    height: 600,
    zOrder: 0,
    ...overrides,
  };
}

describe('CollisionSystem', () => {
  let cs: CollisionSystem;

  beforeEach(() => {
    cs = new CollisionSystem();
    cs.updateScreenBounds({ x: 0, y: 0, width: 1920, height: 1080 });
  });

  describe('AABB collision', () => {
    it('should detect no collision when rects are separate', () => {
      cs.updateWindowRects([makeWindowRect({ x: 500, y: 500, width: 200, height: 200 })]);

      const characterBounds: Rect = { x: 0, y: 0, width: 100, height: 100 };
      const result = cs.check(characterBounds);

      expect(result.collidingWithWindow).toBe(false);
      expect(result.collidedWindowHwnd).toBeNull();
    });

    it('should detect collision when rects overlap', () => {
      cs.updateWindowRects([makeWindowRect({ x: 50, y: 50, width: 200, height: 200 })]);

      const characterBounds: Rect = { x: 100, y: 100, width: 100, height: 100 };
      const result = cs.check(characterBounds);

      expect(result.collidingWithWindow).toBe(true);
      expect(result.collidedWindowHwnd).toBe(1);
    });

    it('should detect collision sides correctly (character to the left)', () => {
      cs.updateWindowRects([makeWindowRect({ x: 100, y: 0, width: 200, height: 400 })]);

      const characterBounds: Rect = { x: 90, y: 100, width: 50, height: 50 };
      const result = cs.check(characterBounds);

      if (result.collidingWithWindow) {
        expect(result.collidingSides.left).toBe(true);
        expect(result.collidingSides.right).toBe(false);
      }
    });

    it('should detect collision sides correctly (character to the right)', () => {
      cs.updateWindowRects([makeWindowRect({ x: 0, y: 0, width: 100, height: 400 })]);

      const characterBounds: Rect = { x: 80, y: 100, width: 50, height: 50 };
      const result = cs.check(characterBounds);

      if (result.collidingWithWindow) {
        expect(result.collidingSides.right).toBe(true);
        expect(result.collidingSides.left).toBe(false);
      }
    });
  });

  describe('screen edge detection', () => {
    it('should detect when character is within screen bounds', () => {
      cs.updateWindowRects([]);
      const characterBounds: Rect = { x: 500, y: 500, width: 100, height: 100 };
      const result = cs.check(characterBounds);

      expect(result.atScreenEdge).toBe(false);
    });
  });

  describe('snap detection', () => {
    it('should find snappable windows within threshold', () => {
      const window1 = makeWindowRect({ hwnd: 1, x: 100, y: 200, width: 400, height: 300 });
      cs.updateWindowRects([window1]);

      // Character bottom is at 200 (y=100 + height=100), window top is at 200
      const characterBounds: Rect = { x: 150, y: 100, width: 100, height: 100 };
      const snappable = cs.getSnappableWindows(characterBounds, 20);

      expect(snappable.length).toBe(1);
      expect(snappable[0].hwnd).toBe(1);
    });

    it('should not snap when distance exceeds threshold', () => {
      const window1 = makeWindowRect({ hwnd: 1, x: 100, y: 300, width: 400, height: 300 });
      cs.updateWindowRects([window1]);

      // Character bottom is at 200, window top is at 300 (distance = 100)
      const characterBounds: Rect = { x: 150, y: 100, width: 100, height: 100 };
      const snappable = cs.getSnappableWindows(characterBounds, 20);

      expect(snappable.length).toBe(0);
    });

    it('should not snap when no horizontal overlap', () => {
      const window1 = makeWindowRect({ hwnd: 1, x: 500, y: 200, width: 400, height: 300 });
      cs.updateWindowRects([window1]);

      // Character is at x=0, window starts at x=500
      const characterBounds: Rect = { x: 0, y: 100, width: 100, height: 100 };
      const snappable = cs.getSnappableWindows(characterBounds, 20);

      expect(snappable.length).toBe(0);
    });
  });

  describe('occlusion', () => {
    it('should calculate occlusion rects for overlapping windows', () => {
      cs.updateWindowRects([makeWindowRect({ x: 50, y: 50, width: 200, height: 200 })]);

      const characterBounds: Rect = { x: 100, y: 100, width: 200, height: 200 };
      const occlusion = cs.getOcclusionRects(characterBounds);

      expect(occlusion.length).toBe(1);
      // The intersection should be in character-local coordinates
      expect(occlusion[0].x).toBe(0); // max(100, 50) - 100 = 0
      expect(occlusion[0].y).toBe(0); // max(100, 50) - 100 = 0
    });

    it('should return empty array when no occlusion', () => {
      cs.updateWindowRects([makeWindowRect({ x: 500, y: 500, width: 100, height: 100 })]);

      const characterBounds: Rect = { x: 0, y: 0, width: 100, height: 100 };
      const occlusion = cs.getOcclusionRects(characterBounds);

      expect(occlusion.length).toBe(0);
    });
  });

  describe('clampToScreen', () => {
    it('should keep position within screen bounds', () => {
      const result = cs.clampToScreen({ x: -500, y: -500 }, 100, 100);
      // At least 20% (20px) should be visible
      expect(result.x).toBeGreaterThanOrEqual(-80); // -100 + 20
      expect(result.y).toBeGreaterThanOrEqual(-80);
    });

    it('should not modify position already within bounds', () => {
      const result = cs.clampToScreen({ x: 500, y: 500 }, 100, 100);
      expect(result.x).toBe(500);
      expect(result.y).toBe(500);
    });

    it('should clamp position at right/bottom edge', () => {
      const result = cs.clampToScreen({ x: 2000, y: 2000 }, 100, 100);
      // Should be clamped to keep 20% visible
      expect(result.x).toBeLessThanOrEqual(1920 - 20); // screen width - 20% of char
      expect(result.y).toBeLessThanOrEqual(1080 - 20);
    });
  });

  describe('empty window list', () => {
    it('should handle check with no windows', () => {
      cs.updateWindowRects([]);
      const characterBounds: Rect = { x: 500, y: 500, width: 100, height: 100 };
      const result = cs.check(characterBounds);

      expect(result.collidingWithWindow).toBe(false);
      expect(result.snappableWindows.length).toBe(0);
      expect(result.occlusionRects.length).toBe(0);
    });
  });
});
