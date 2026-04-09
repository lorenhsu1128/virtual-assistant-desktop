/**
 * 影片動捕工作站 — 上方工具列
 *
 * Phase 1：只負責「載入影片」按鈕。
 * 後續 phase 將擴充引擎下拉、轉換按鈕、匯出按鈕的事件綁定。
 */

export type TopBarCallback = () => void;

export interface TopBarElements {
  loadVideoBtn: HTMLButtonElement;
}

export class TopBar {
  private readonly el: TopBarElements;

  /** 使用者點擊「載入影片」時觸發 */
  onLoadVideo: TopBarCallback | null = null;

  constructor(el: TopBarElements) {
    this.el = el;
    this.el.loadVideoBtn.disabled = false;
    this.el.loadVideoBtn.addEventListener('click', this.onClick);
  }

  private readonly onClick = (): void => {
    this.onLoadVideo?.();
  };

  dispose(): void {
    this.el.loadVideoBtn.removeEventListener('click', this.onClick);
  }
}
