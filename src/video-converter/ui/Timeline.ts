/**
 * 影片動作轉換器 — Timeline scrub UI
 *
 * 簡易時間軸：HTML5 range input + 時間 / 總長度文字。提供 scrub callback
 * 讓呼叫端在使用者拖曳時做 sampleAt + applyPose。
 *
 * 對應計畫：video-converter-plan.md 第 2.10 / 第 7 節 Phase 11
 *
 * 職責：
 *   - 顯示當前時間 / 總長度
 *   - 接收使用者拖曳事件，轉為時間秒數後回呼
 *   - setCurrentTime() 允許外部同步 indicator 位置（例如 Stage 2
 *     進行中顯示處理進度）
 *   - setEnabled() 在 Stage 1 進行中禁用避免衝突
 */

export type TimelineScrubCallback = (timeSeconds: number) => void;

const SLIDER_RESOLUTION = 1000;

export class Timeline {
  private container: HTMLElement;
  private input: HTMLInputElement;
  private timeLabel: HTMLSpanElement;
  private durationLabel: HTMLSpanElement;
  private duration = 0;
  private onScrubCb: TimelineScrubCallback | null = null;

  constructor(container: HTMLElement) {
    this.container = container;
    container.innerHTML = `
      <div class="vc-timeline-row">
        <input type="range" class="vc-timeline-range" min="0" max="${SLIDER_RESOLUTION}" value="0" step="1" disabled />
        <div class="vc-timeline-labels">
          <span class="vc-timeline-time">0.00</span>
          <span class="vc-timeline-sep">/</span>
          <span class="vc-timeline-duration">0.00</span>
          <span class="vc-timeline-unit">s</span>
        </div>
      </div>
    `;

    this.input = container.querySelector<HTMLInputElement>('.vc-timeline-range')!;
    this.timeLabel = container.querySelector<HTMLSpanElement>('.vc-timeline-time')!;
    this.durationLabel = container.querySelector<HTMLSpanElement>('.vc-timeline-duration')!;

    this.input.addEventListener('input', () => {
      if (this.duration <= 0) return;
      const ratio = parseInt(this.input.value, 10) / SLIDER_RESOLUTION;
      const t = ratio * this.duration;
      this.timeLabel.textContent = t.toFixed(2);
      this.onScrubCb?.(t);
    });
  }

  /** 設定總長度；duration <= 0 表示沒有資料可供 scrub，disable */
  setDuration(seconds: number): void {
    this.duration = seconds;
    this.durationLabel.textContent = seconds.toFixed(2);
    this.input.value = '0';
    this.timeLabel.textContent = '0.00';
    this.input.disabled = seconds <= 0;
  }

  /** 同步 slider indicator 到指定時間（不觸發 scrub callback） */
  setCurrentTime(seconds: number): void {
    if (this.duration <= 0) return;
    const ratio = Math.max(0, Math.min(1, seconds / this.duration));
    this.input.value = String(Math.round(ratio * SLIDER_RESOLUTION));
    this.timeLabel.textContent = seconds.toFixed(2);
  }

  /** 強制啟用 / 停用（覆蓋 setDuration 的 enabled 狀態） */
  setEnabled(enabled: boolean): void {
    this.input.disabled = !enabled || this.duration <= 0;
  }

  onScrub(cb: TimelineScrubCallback): void {
    this.onScrubCb = cb;
  }

  get element(): HTMLElement {
    return this.container;
  }
}
