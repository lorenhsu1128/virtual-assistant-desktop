import { describe, it, expect } from 'vitest';
import { marchingSquares, douglasPeucker } from '../../src/occlusion/SilhouetteExtractor';
import type { Point } from '../../src/types/occlusion';

describe('marchingSquares', () => {
  it('回傳 null 當 mask 全為 0', () => {
    const mask = new Uint8Array(25); // 5x5 全 0
    expect(marchingSquares(mask, 5, 5)).toBeNull();
  });

  it('回傳 null 當 mask 全為 1', () => {
    const mask = new Uint8Array(25).fill(1);
    expect(marchingSquares(mask, 5, 5)).toBeNull();
  });

  it('追蹤矩形輪廓', () => {
    // 7x7 mask，中央 3x3 方塊
    const w = 7, h = 7;
    const mask = new Uint8Array(w * h);
    for (let y = 2; y <= 4; y++) {
      for (let x = 2; x <= 4; x++) {
        mask[y * w + x] = 1;
      }
    }

    const contour = marchingSquares(mask, w, h);
    expect(contour).not.toBeNull();
    expect(contour!.length).toBeGreaterThanOrEqual(4);

    // 輪廓應為封閉多邊形（首尾相同）
    const first = contour![0];
    const last = contour![contour!.length - 1];
    expect(first.x).toBeCloseTo(last.x, 1);
    expect(first.y).toBeCloseTo(last.y, 1);
  });

  it('追蹤單像素', () => {
    // 3x3 mask，中央 1 像素
    const w = 3, h = 3;
    const mask = new Uint8Array(w * h);
    mask[4] = 1; // (1,1)

    const contour = marchingSquares(mask, w, h);
    expect(contour).not.toBeNull();
    expect(contour!.length).toBeGreaterThanOrEqual(3);
  });

  it('追蹤 L 形', () => {
    // 6x6 mask，L 形
    const w = 6, h = 6;
    const mask = new Uint8Array(w * h);
    // 垂直部分 (1, 1-3)
    for (let y = 1; y <= 3; y++) mask[y * w + 1] = 1;
    // 水平部分 (1-3, 3)
    for (let x = 1; x <= 3; x++) mask[3 * w + x] = 1;

    const contour = marchingSquares(mask, w, h);
    expect(contour).not.toBeNull();
    expect(contour!.length).toBeGreaterThanOrEqual(4);
  });
});

describe('douglasPeucker', () => {
  it('保持 2 點不變', () => {
    const points: Point[] = [{ x: 0, y: 0 }, { x: 10, y: 10 }];
    const result = douglasPeucker(points, 1.0);
    expect(result).toHaveLength(2);
  });

  it('tolerance 0 保留所有點', () => {
    const points: Point[] = [
      { x: 0, y: 0 },
      { x: 5, y: 0.001 },
      { x: 10, y: 0 },
    ];
    const result = douglasPeucker(points, 0);
    expect(result).toHaveLength(3);
  });

  it('簡化直線上的中間點', () => {
    // 三個共線的點
    const points: Point[] = [
      { x: 0, y: 0 },
      { x: 5, y: 0 },
      { x: 10, y: 0 },
    ];
    const result = douglasPeucker(points, 1.0);
    expect(result).toHaveLength(2);
  });

  it('保留轉角點', () => {
    // L 形路徑，轉角點距離起終線段很遠
    const points: Point[] = [
      { x: 0, y: 0 },
      { x: 0, y: 10 },
      { x: 10, y: 10 },
    ];
    const result = douglasPeucker(points, 1.0);
    expect(result).toHaveLength(3);
  });

  it('大 tolerance 大幅簡化', () => {
    // 圓形近似（16 頂點）
    const points: Point[] = [];
    for (let i = 0; i < 16; i++) {
      const angle = (i / 16) * Math.PI * 2;
      points.push({ x: 50 + 50 * Math.cos(angle), y: 50 + 50 * Math.sin(angle) });
    }

    const result = douglasPeucker(points, 20);
    expect(result.length).toBeLessThan(points.length);
    expect(result.length).toBeGreaterThanOrEqual(2);
  });
});
