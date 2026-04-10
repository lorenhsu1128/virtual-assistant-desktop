/**
 * 影片動捕工作站 — 進度條元件（Phase 6 polish）
 *
 * 輕量 DOM 包裝。提供：
 *   - show() / hide()：淡入淡出
 *   - setRatio(r)：0..1 → 寬度百分比
 *   - complete()：短暫顯示 100% 後自動淡出
 *
 * 模組邊界：純 DOM 包裝，無 Three.js / VRM / MediaPipe 依賴。
 * 放在 mocap-studio/（UI 元件），不放 mocap/（純邏輯）。
 */

/** 進度條的 DOM 元素 */
export interface ProgressBarElements {
  container: HTMLElement;
  inner: HTMLElement;
}

/** complete() 後延遲多久淡出（毫秒） */
const COMPLETE_HOLD_MS = 600;

export class ProgressBar {
  private readonly el: ProgressBarElements;
  private completeTimeoutId: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;

  constructor(elements: ProgressBarElements) {
    this.el = elements;
    this.hide();
  }

  /** 顯示進度條（取消任何 pending complete 淡出） */
  show(): void {
    if (this.disposed) return;
    if (this.completeTimeoutId !== null) {
      clearTimeout(this.completeTimeoutId);
      this.completeTimeoutId = null;
    }
    this.el.container.classList.remove('hidden');
    this.setRatio(0);
  }

  /** 隱藏進度條並重置寬度 */
  hide(): void {
    if (this.disposed) return;
    if (this.completeTimeoutId !== null) {
      clearTimeout(this.completeTimeoutId);
      this.completeTimeoutId = null;
    }
    this.el.container.classList.add('hidden');
    // 等淡出動畫結束再重置寬度，避免下次 show 時看到殘餘進度
    this.el.inner.style.width = '0%';
  }

  /**
   * 設定進度比例
   *
   * @param ratio 0..1；< 0 視為 0，> 1 視為 1，NaN / Infinity 視為 0
   */
  setRatio(ratio: number): void {
    if (this.disposed) return;
    const clamped = this.clampRatio(ratio);
    this.el.inner.style.width = `${(clamped * 100).toFixed(1)}%`;
  }

  /**
   * 完成：顯示 100% 後自動淡出
   *
   * 先跳到 100%，保留 COMPLETE_HOLD_MS 讓使用者看見完整條，再呼叫 hide()
   * 觸發 CSS 淡出 transition。
   */
  complete(): void {
    if (this.disposed) return;
    this.setRatio(1);
    if (this.completeTimeoutId !== null) {
      clearTimeout(this.completeTimeoutId);
    }
    this.completeTimeoutId = setTimeout(() => {
      this.completeTimeoutId = null;
      this.hide();
    }, COMPLETE_HOLD_MS);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.completeTimeoutId !== null) {
      clearTimeout(this.completeTimeoutId);
      this.completeTimeoutId = null;
    }
  }

  private clampRatio(r: number): number {
    if (!Number.isFinite(r)) return 0;
    if (r < 0) return 0;
    if (r > 1) return 1;
    return r;
  }
}
