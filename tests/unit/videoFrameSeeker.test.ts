/**
 * Phase 5d videoFrameSeeker 單元測試
 *
 * 用 fake video 物件驗證 seek + 'seeked' 等待 + timeout 行為。
 * 不依賴真正的瀏覽器 video 元素或解碼器。
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  seekVideoTo,
  type SeekableVideo,
  DEFAULT_SEEK_TIMEOUT_MS,
} from '../../src/mocap/engines/videoFrameSeeker';

/**
 * 可控制的 fake video element
 *
 * 提供：
 *   - currentTime setter（觸發 onCurrentTimeSet 回呼）
 *   - addEventListener / removeEventListener
 *   - fireSeeked() 手動觸發 seeked 事件
 *   - 自動 fire 模式：set currentTime 後立即 fire（用於 happy path）
 */
class FakeVideo implements SeekableVideo {
  currentTime = 0;
  readyState = 4;
  private listeners = new Set<() => void>();
  autoFire = false;

  addEventListener(_type: 'seeked', listener: () => void): void {
    this.listeners.add(listener);
  }

  removeEventListener(_type: 'seeked', listener: () => void): void {
    this.listeners.delete(listener);
  }

  setCurrentTime(t: number): void {
    this.currentTime = t;
    if (this.autoFire) {
      // 模擬瀏覽器在 microtask 階段觸發
      queueMicrotask(() => this.fireSeeked());
    }
  }

  fireSeeked(): void {
    for (const fn of [...this.listeners]) fn();
  }

  hasListeners(): boolean {
    return this.listeners.size > 0;
  }
}

// 攔截 seeker 內部對 currentTime setter 的賦值
// （JS 沒辦法在 plain object 上 hook setter；改為包一層 Proxy）
function makeAutoFireVideo(initialTime = 0): FakeVideo {
  const v = new FakeVideo();
  v.currentTime = initialTime;
  v.autoFire = true;
  return new Proxy(v, {
    set(target, prop, value): boolean {
      if (prop === 'currentTime') {
        target.setCurrentTime(value as number);
        return true;
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (target as any)[prop] = value;
      return true;
    },
  }) as FakeVideo;
}

describe('seekVideoTo', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('resolves immediately when already at target time (within epsilon)', async () => {
    const v = new FakeVideo();
    v.currentTime = 1.5;
    const promise = seekVideoTo(v, 1.5, 100);
    await expect(promise).resolves.toBeUndefined();
    // 不該註冊 listener（fast path）
    expect(v.hasListeners()).toBe(false);
  });

  it('resolves after seeked event fires', async () => {
    const v = makeAutoFireVideo(0);
    const promise = seekVideoTo(v, 2.0, 1000);
    // 推進 microtask（autoFire 用 queueMicrotask）
    await vi.advanceTimersByTimeAsync(0);
    await expect(promise).resolves.toBeUndefined();
    expect(v.currentTime).toBe(2.0);
  });

  it('rejects when seeked event never fires (timeout)', async () => {
    const v = new FakeVideo();
    v.currentTime = 0;
    v.autoFire = false;
    const promise = seekVideoTo(v, 5, 200);
    const assertion = expect(promise).rejects.toThrow(/timeout/);
    await vi.advanceTimersByTimeAsync(250);
    await assertion;
    // listener 應已被清掉
    expect(v.hasListeners()).toBe(false);
  });

  it('clamps negative target to 0', async () => {
    const v = new FakeVideo();
    v.currentTime = 5;
    v.autoFire = false;
    const p = seekVideoTo(v, -3, 100);
    // 立即 fire
    queueMicrotask(() => v.fireSeeked());
    await vi.advanceTimersByTimeAsync(0);
    await expect(p).resolves.toBeUndefined();
    expect(v.currentTime).toBe(0);
  });

  it('removes listener after success', async () => {
    const v = makeAutoFireVideo(0);
    const p = seekVideoTo(v, 1, 1000);
    await vi.advanceTimersByTimeAsync(0);
    await p;
    expect(v.hasListeners()).toBe(false);
  });

  it('uses default timeout when not specified', async () => {
    const v = new FakeVideo();
    v.autoFire = false;
    const p = seekVideoTo(v, 1);
    const assertion = expect(p).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(DEFAULT_SEEK_TIMEOUT_MS + 10);
    await assertion;
  });
});
