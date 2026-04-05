import { describe, it, expect } from 'vitest';
import { clipPolygonToRect } from '../../src/occlusion/PolygonClip';
import type { Point } from '../../src/types/occlusion';
import type { Rect } from '../../src/types/window';

describe('clipPolygonToRect', () => {
  const clipRect: Rect = { x: 10, y: 10, width: 80, height: 80 };

  it('多邊形完全在矩形內 → 回傳原多邊形', () => {
    const polygon: Point[] = [
      { x: 20, y: 20 },
      { x: 60, y: 20 },
      { x: 60, y: 60 },
      { x: 20, y: 60 },
    ];
    const result = clipPolygonToRect(polygon, clipRect);
    expect(result).toHaveLength(4);
    expect(result).toEqual(polygon);
  });

  it('多邊形完全在矩形外 → 回傳空陣列', () => {
    const polygon: Point[] = [
      { x: 100, y: 100 },
      { x: 200, y: 100 },
      { x: 200, y: 200 },
      { x: 100, y: 200 },
    ];
    const result = clipPolygonToRect(polygon, clipRect);
    expect(result).toHaveLength(0);
  });

  it('部分交叉 → 回傳正確裁切結果', () => {
    // 多邊形的左半部在矩形外
    const polygon: Point[] = [
      { x: 0, y: 30 },
      { x: 50, y: 30 },
      { x: 50, y: 70 },
      { x: 0, y: 70 },
    ];
    const result = clipPolygonToRect(polygon, clipRect);
    expect(result.length).toBeGreaterThanOrEqual(3);

    // 所有頂點應在矩形內
    for (const p of result) {
      expect(p.x).toBeGreaterThanOrEqual(clipRect.x - 0.001);
      expect(p.x).toBeLessThanOrEqual(clipRect.x + clipRect.width + 0.001);
      expect(p.y).toBeGreaterThanOrEqual(clipRect.y - 0.001);
      expect(p.y).toBeLessThanOrEqual(clipRect.y + clipRect.height + 0.001);
    }
  });

  it('三角形裁切', () => {
    const polygon: Point[] = [
      { x: 50, y: 0 },   // 上方超出
      { x: 100, y: 95 },  // 右側超出
      { x: 0, y: 95 },    // 左側超出
    ];
    const result = clipPolygonToRect(polygon, clipRect);
    expect(result.length).toBeGreaterThanOrEqual(3);

    // 所有頂點應在矩形內
    for (const p of result) {
      expect(p.x).toBeGreaterThanOrEqual(clipRect.x - 0.001);
      expect(p.x).toBeLessThanOrEqual(clipRect.x + clipRect.width + 0.001);
      expect(p.y).toBeGreaterThanOrEqual(clipRect.y - 0.001);
      expect(p.y).toBeLessThanOrEqual(clipRect.y + clipRect.height + 0.001);
    }
  });

  it('少於 3 個頂點 → 回傳空陣列', () => {
    const polygon: Point[] = [{ x: 20, y: 20 }, { x: 60, y: 60 }];
    const result = clipPolygonToRect(polygon, clipRect);
    expect(result).toHaveLength(0);
  });

  it('空多邊形 → 回傳空陣列', () => {
    const result = clipPolygonToRect([], clipRect);
    expect(result).toHaveLength(0);
  });
});
