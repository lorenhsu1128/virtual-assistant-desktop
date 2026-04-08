import { describe, it, expect } from 'vitest';
import {
  clampMenuPosition,
  DEFAULT_FAKE_ITEMS,
} from '../../src/interaction/CharacterContextMenu';

/**
 * CharacterContextMenu 測試
 *
 * 由於 vitest environment = 'node'，不載入 jsdom/happy-dom，
 * 此處只測試純邏輯（clampMenuPosition 與 DEFAULT_FAKE_ITEMS 結構）。
 * DOM 行為依賴真實瀏覽器環境驗證（手動測試）。
 */
describe('clampMenuPosition', () => {
  const menu = { width: 180, height: 240 };
  const viewport = { width: 1920, height: 1080 };

  it('keeps menu at mouse position when there is enough space', () => {
    const pos = clampMenuPosition({ x: 500, y: 400 }, menu, viewport);
    expect(pos.x).toBe(500);
    expect(pos.y).toBe(400);
  });

  it('flips to left when mouse is near right edge', () => {
    const pos = clampMenuPosition({ x: 1900, y: 400 }, menu, viewport);
    // 1900 + 180 + 4 > 1920 → 翻到左邊 = 1900 - 180 = 1720
    expect(pos.x).toBe(1720);
    expect(pos.y).toBe(400);
  });

  it('flips to top when mouse is near bottom edge', () => {
    const pos = clampMenuPosition({ x: 500, y: 1070 }, menu, viewport);
    // 1070 + 240 + 4 > 1080 → 翻到上面 = 1070 - 240 = 830
    expect(pos.x).toBe(500);
    expect(pos.y).toBe(830);
  });

  it('flips both axes at the bottom-right corner', () => {
    const pos = clampMenuPosition({ x: 1900, y: 1070 }, menu, viewport);
    expect(pos.x).toBe(1720);
    expect(pos.y).toBe(830);
  });

  it('clamps to minimum margin when flipped value is negative', () => {
    // 小 viewport + mouse 在右下 → 翻到左上後可能為負
    const smallVp = { width: 200, height: 200 };
    const pos = clampMenuPosition({ x: 190, y: 190 }, menu, smallVp, 4);
    // 翻到左邊後 x = 190 - 180 = 10，仍在合法範圍
    // 翻到上面後 y = 190 - 240 = -50，會被 clamp 到 margin=4
    expect(pos.x).toBe(10);
    expect(pos.y).toBe(4);
  });

  it('respects custom margin', () => {
    const pos = clampMenuPosition({ x: 10, y: 10 }, menu, viewport, 20);
    expect(pos.x).toBe(20); // clamp 到 margin
    expect(pos.y).toBe(20);
  });

  it('handles mouse at (0, 0)', () => {
    const pos = clampMenuPosition({ x: 0, y: 0 }, menu, viewport);
    // x=0 < margin=4 → clamp 到 4
    expect(pos.x).toBe(4);
    expect(pos.y).toBe(4);
  });
});

describe('DEFAULT_FAKE_ITEMS', () => {
  it('contains at least 5 interactive items', () => {
    const interactive = DEFAULT_FAKE_ITEMS.filter((i) => !i.separator);
    expect(interactive.length).toBeGreaterThanOrEqual(5);
  });

  it('every interactive item has unique id and non-empty label', () => {
    const interactive = DEFAULT_FAKE_ITEMS.filter((i) => !i.separator);
    const ids = interactive.map((i) => i.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const item of interactive) {
      expect(item.label.length).toBeGreaterThan(0);
    }
  });

  it('contains at least one separator for visual grouping', () => {
    const separators = DEFAULT_FAKE_ITEMS.filter((i) => i.separator);
    expect(separators.length).toBeGreaterThanOrEqual(1);
  });
});
