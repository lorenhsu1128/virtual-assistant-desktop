/**
 * 影片動捕工作站 — 時間軸元件
 *
 * DOM 元件，管理時間軸的視覺與互動：
 *   - 雙拖曳把手（in / out）定義動捕區間
 *   - 播放位置指示（playhead）
 *   - 點擊 track 空白處 seek（會 clamp 在 [in, out] 範圍內）
 *
 * 純邏輯計算委派給 timelineLogic.ts（可單元測試）。
 * 對外以 callback 通知上層（MocapStudioApp），不直接操作 VideoPanel。
 */

import {
  timeToPixel,
  pixelToTime,
  clampInTime,
  clampOutTime,
  formatTime,
} from './timelineLogic';

export type TimelineSeekCallback = (timeSec: number) => void;

/** Timeline 建構時需注入的 DOM 元素 */
export interface TimelineElements {
  /** 外層容器（會被加上 `timeline-disabled` class） */
  root: HTMLElement;
  /** 時間軸本體（可點擊 seek） */
  track: HTMLElement;
  /** in/out 之間的高亮條 */
  range: HTMLElement;
  /** 播放位置指示器 */
  playhead: HTMLElement;
  /** in 拖曳把手 */
  inHandle: HTMLElement;
  /** out 拖曳把手 */
  outHandle: HTMLElement;
  /** in 把手下方的時間 label */
  inLabel: HTMLElement;
  /** out 把手下方的時間 label */
  outLabel: HTMLElement;
}

export class Timeline {
  private readonly el: TimelineElements;

  private durationSec = 0;
  private inSec = 0;
  private outSec = 0;
  private playheadSec = 0;
  private enabled = false;
  private dragMode: 'none' | 'in' | 'out' | 'scrub' = 'none';

  /** 使用者拖曳 in 把手時觸發 */
  onInChange: TimelineSeekCallback | null = null;
  /** 使用者拖曳 out 把手時觸發 */
  onOutChange: TimelineSeekCallback | null = null;
  /** 使用者點擊 track 空白處時觸發（已 clamp 在 [in, out] 範圍） */
  onSeek: TimelineSeekCallback | null = null;

  constructor(el: TimelineElements) {
    this.el = el;
    this.el.inHandle.addEventListener('pointerdown', this.onInPointerDown);
    this.el.outHandle.addEventListener('pointerdown', this.onOutPointerDown);
    // 監聽 root 而非 track，讓可點擊區域涵蓋整個時間軸高度（~52px 而非 8px）
    this.el.root.addEventListener('pointerdown', this.onRootPointerDown);
    this.render();
  }

  /** 設定新的影片總長度，in/out/playhead 重置為 0/duration/0 */
  setDuration(durationSec: number): void {
    this.durationSec = durationSec;
    this.inSec = 0;
    this.outSec = durationSec;
    this.playheadSec = 0;
    this.render();
  }

  /** 啟用 / 停用時間軸（未載入影片時停用） */
  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    this.el.root.classList.toggle('timeline-disabled', !enabled);
  }

  /** 更新播放位置指示器 */
  setPlayhead(sec: number): void {
    this.playheadSec = sec;
    this.renderPlayhead();
  }

  getIn(): number {
    return this.inSec;
  }

  getOut(): number {
    return this.outSec;
  }

  /** 視窗 resize 後呼叫，重新計算所有元素位置 */
  handleResize(): void {
    this.render();
  }

  // ── 拖曳：in 把手 ──

  private readonly onInPointerDown = (e: PointerEvent): void => {
    if (!this.enabled) return;
    e.stopPropagation();
    e.preventDefault();
    this.dragMode = 'in';
    this.el.inHandle.setPointerCapture(e.pointerId);
    this.el.inHandle.addEventListener('pointermove', this.onInPointerMove);
    this.el.inHandle.addEventListener('pointerup', this.onInPointerUp);
    this.el.inHandle.addEventListener('pointercancel', this.onInPointerUp);
  };

  private readonly onInPointerMove = (e: PointerEvent): void => {
    if (this.dragMode !== 'in') return;
    const rect = this.el.track.getBoundingClientRect();
    const rawTime = pixelToTime(e.clientX - rect.left, this.durationSec, rect.width);
    this.inSec = clampInTime(rawTime, this.outSec);
    this.renderHandles();
    this.renderRange();
    this.onInChange?.(this.inSec);
  };

  private readonly onInPointerUp = (e: PointerEvent): void => {
    if (this.dragMode !== 'in') return;
    this.dragMode = 'none';
    this.el.inHandle.releasePointerCapture(e.pointerId);
    this.el.inHandle.removeEventListener('pointermove', this.onInPointerMove);
    this.el.inHandle.removeEventListener('pointerup', this.onInPointerUp);
    this.el.inHandle.removeEventListener('pointercancel', this.onInPointerUp);
  };

  // ── 拖曳：out 把手 ──

  private readonly onOutPointerDown = (e: PointerEvent): void => {
    if (!this.enabled) return;
    e.stopPropagation();
    e.preventDefault();
    this.dragMode = 'out';
    this.el.outHandle.setPointerCapture(e.pointerId);
    this.el.outHandle.addEventListener('pointermove', this.onOutPointerMove);
    this.el.outHandle.addEventListener('pointerup', this.onOutPointerUp);
    this.el.outHandle.addEventListener('pointercancel', this.onOutPointerUp);
  };

  private readonly onOutPointerMove = (e: PointerEvent): void => {
    if (this.dragMode !== 'out') return;
    const rect = this.el.track.getBoundingClientRect();
    const rawTime = pixelToTime(e.clientX - rect.left, this.durationSec, rect.width);
    this.outSec = clampOutTime(rawTime, this.inSec, this.durationSec);
    this.renderHandles();
    this.renderRange();
    this.onOutChange?.(this.outSec);
  };

  private readonly onOutPointerUp = (e: PointerEvent): void => {
    if (this.dragMode !== 'out') return;
    this.dragMode = 'none';
    this.el.outHandle.releasePointerCapture(e.pointerId);
    this.el.outHandle.removeEventListener('pointermove', this.onOutPointerMove);
    this.el.outHandle.removeEventListener('pointerup', this.onOutPointerUp);
    this.el.outHandle.removeEventListener('pointercancel', this.onOutPointerUp);
  };

  // ── Track scrub（root 元件級別，支援 click-to-seek 與 drag-to-scrub） ──

  private readonly onRootPointerDown = (e: PointerEvent): void => {
    if (!this.enabled) return;
    if (this.dragMode !== 'none') return;
    // 若點擊在把手上，handle 的 pointerdown 已 stopPropagation，不會到這裡
    // 但為保險起見也檢查 target 是否為 handle 子元素
    const target = e.target as HTMLElement;
    if (target.closest('.tl-handle')) return;

    this.dragMode = 'scrub';
    this.el.root.setPointerCapture(e.pointerId);
    this.el.root.addEventListener('pointermove', this.onRootPointerMove);
    this.el.root.addEventListener('pointerup', this.onRootPointerUp);
    this.el.root.addEventListener('pointercancel', this.onRootPointerUp);
    e.preventDefault();
    this.scrubToPointer(e);
  };

  private readonly onRootPointerMove = (e: PointerEvent): void => {
    if (this.dragMode !== 'scrub') return;
    this.scrubToPointer(e);
  };

  private readonly onRootPointerUp = (e: PointerEvent): void => {
    if (this.dragMode !== 'scrub') return;
    this.dragMode = 'none';
    this.el.root.releasePointerCapture(e.pointerId);
    this.el.root.removeEventListener('pointermove', this.onRootPointerMove);
    this.el.root.removeEventListener('pointerup', this.onRootPointerUp);
    this.el.root.removeEventListener('pointercancel', this.onRootPointerUp);
  };

  /** 依 pointer 位置計算對應時間，更新 playhead 視覺並觸發 onSeek */
  private scrubToPointer(e: PointerEvent): void {
    const rect = this.el.track.getBoundingClientRect();
    const rawTime = pixelToTime(e.clientX - rect.left, this.durationSec, rect.width);
    const clamped = Math.max(this.inSec, Math.min(this.outSec, rawTime));
    this.playheadSec = clamped;
    this.renderPlayhead();
    this.onSeek?.(clamped);
  }

  // ── 視覺更新 ──

  private getTrackWidth(): number {
    return this.el.track.clientWidth;
  }

  private render(): void {
    this.renderHandles();
    this.renderRange();
    this.renderPlayhead();
  }

  private renderHandles(): void {
    const width = this.getTrackWidth();
    const inPx = timeToPixel(this.inSec, this.durationSec, width);
    const outPx = timeToPixel(this.outSec, this.durationSec, width);
    this.el.inHandle.style.left = `${inPx}px`;
    this.el.outHandle.style.left = `${outPx}px`;
    this.el.inLabel.textContent = formatTime(this.inSec);
    this.el.outLabel.textContent = formatTime(this.outSec);
  }

  private renderRange(): void {
    const width = this.getTrackWidth();
    const inPx = timeToPixel(this.inSec, this.durationSec, width);
    const outPx = timeToPixel(this.outSec, this.durationSec, width);
    this.el.range.style.left = `${inPx}px`;
    this.el.range.style.width = `${Math.max(0, outPx - inPx)}px`;
  }

  private renderPlayhead(): void {
    const width = this.getTrackWidth();
    const px = timeToPixel(this.playheadSec, this.durationSec, width);
    this.el.playhead.style.left = `${px}px`;
  }

  dispose(): void {
    this.el.inHandle.removeEventListener('pointerdown', this.onInPointerDown);
    this.el.outHandle.removeEventListener('pointerdown', this.onOutPointerDown);
    this.el.root.removeEventListener('pointerdown', this.onRootPointerDown);
    this.el.inHandle.removeEventListener('pointermove', this.onInPointerMove);
    this.el.inHandle.removeEventListener('pointerup', this.onInPointerUp);
    this.el.inHandle.removeEventListener('pointercancel', this.onInPointerUp);
    this.el.outHandle.removeEventListener('pointermove', this.onOutPointerMove);
    this.el.outHandle.removeEventListener('pointerup', this.onOutPointerUp);
    this.el.outHandle.removeEventListener('pointercancel', this.onOutPointerUp);
    this.el.root.removeEventListener('pointermove', this.onRootPointerMove);
    this.el.root.removeEventListener('pointerup', this.onRootPointerUp);
    this.el.root.removeEventListener('pointercancel', this.onRootPointerUp);
  }
}
