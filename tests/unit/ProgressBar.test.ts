/**
 * Phase 6 polish ProgressBar 單元測試
 *
 * 驗證 setRatio 邊界、show/hide 狀態切換、complete 的延遲淡出。
 * 用 happy-dom 或手刻 fake DOM elements。
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ProgressBar } from '../../src/mocap-studio/ProgressBar';

/** 手刻最小 DOM element，避免 happy-dom / jsdom 依賴 */
interface FakeStyle {
  width: string;
}
interface FakeClassList {
  add(name: string): void;
  remove(name: string): void;
  contains(name: string): boolean;
}
class FakeElement {
  style: FakeStyle = { width: '' };
  private classes = new Set<string>();
  classList: FakeClassList = {
    add: (name) => void this.classes.add(name),
    remove: (name) => void this.classes.delete(name),
    contains: (name) => this.classes.has(name),
  };
}

function makeBar(): {
  bar: ProgressBar;
  container: FakeElement;
  inner: FakeElement;
} {
  const container = new FakeElement();
  const inner = new FakeElement();
  const bar = new ProgressBar({
    container: container as unknown as HTMLElement,
    inner: inner as unknown as HTMLElement,
  });
  return { bar, container, inner };
}

describe('ProgressBar.setRatio', () => {
  it('sets width to percentage', () => {
    const { bar, inner } = makeBar();
    bar.setRatio(0.5);
    expect(inner.style.width).toBe('50.0%');
  });

  it('clamps negative values to 0', () => {
    const { bar, inner } = makeBar();
    bar.setRatio(-0.5);
    expect(inner.style.width).toBe('0.0%');
  });

  it('clamps values above 1 to 100%', () => {
    const { bar, inner } = makeBar();
    bar.setRatio(1.5);
    expect(inner.style.width).toBe('100.0%');
  });

  it('treats NaN as 0', () => {
    const { bar, inner } = makeBar();
    bar.setRatio(NaN);
    expect(inner.style.width).toBe('0.0%');
  });

  it('treats Infinity as 0', () => {
    const { bar, inner } = makeBar();
    bar.setRatio(Infinity);
    expect(inner.style.width).toBe('0.0%');
  });
});

describe('ProgressBar show / hide', () => {
  it('constructor hides by default', () => {
    const { container } = makeBar();
    expect(container.classList.contains('hidden')).toBe(true);
  });

  it('show() removes hidden class and resets to 0', () => {
    const { bar, container, inner } = makeBar();
    bar.setRatio(0.8);
    bar.show();
    expect(container.classList.contains('hidden')).toBe(false);
    expect(inner.style.width).toBe('0.0%');
  });

  it('hide() adds hidden class', () => {
    const { bar, container } = makeBar();
    bar.show();
    bar.hide();
    expect(container.classList.contains('hidden')).toBe(true);
  });
});

describe('ProgressBar.complete', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('jumps to 100% then fades out after hold', () => {
    const { bar, container, inner } = makeBar();
    bar.show();
    bar.complete();
    // 立即設 100%
    expect(inner.style.width).toBe('100.0%');
    expect(container.classList.contains('hidden')).toBe(false);
    // 推進超過 hold 時間
    vi.advanceTimersByTime(1000);
    expect(container.classList.contains('hidden')).toBe(true);
  });

  it('show() cancels pending complete fade', () => {
    const { bar, container } = makeBar();
    bar.show();
    bar.complete();
    bar.show(); // 再次 show
    vi.advanceTimersByTime(1000);
    // 不應該因為上次 complete 的 timeout 而被 hide
    expect(container.classList.contains('hidden')).toBe(false);
  });
});

describe('ProgressBar.dispose', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('ignores further calls after dispose', () => {
    const { bar, inner } = makeBar();
    // constructor 呼叫 hide() 把 width 設成 '0%'
    expect(inner.style.width).toBe('0%');
    bar.dispose();
    bar.setRatio(0.5);
    // dispose 後 setRatio 應被忽略，width 不應被寫成 '50.0%'
    expect(inner.style.width).toBe('0%');
  });

  it('clears pending complete timeout', () => {
    const { bar, container } = makeBar();
    bar.show();
    bar.complete();
    bar.dispose();
    vi.advanceTimersByTime(1000);
    // complete timeout 應已被取消，container 不應被動到（仍保持 complete 時的狀態）
    // 具體：complete 時 setRatio(1) + 保留 visible；dispose 清 timeout
    // 這裡不應該 auto-hide
    expect(container.classList.contains('hidden')).toBe(false);
  });
});
