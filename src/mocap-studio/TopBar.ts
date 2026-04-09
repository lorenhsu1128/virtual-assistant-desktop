/**
 * 影片動捕工作站 — 上方工具列
 *
 * Phase 1：「載入影片」按鈕。
 * Phase 2c：「[dev] 載入測試 fixture」按鈕（開發期驗證下游 pipeline 用）。
 * 後續 phase 將擴充引擎下拉、轉換按鈕、匯出按鈕的事件綁定。
 */

export type TopBarCallback = () => void;

export interface TopBarElements {
  loadVideoBtn: HTMLButtonElement;
  loadFixtureBtn: HTMLButtonElement;
}

export class TopBar {
  private readonly el: TopBarElements;

  /** 使用者點擊「載入影片」時觸發 */
  onLoadVideo: TopBarCallback | null = null;

  /** 使用者點擊「[dev] 載入測試 fixture」時觸發（Phase 2c） */
  onLoadFixture: TopBarCallback | null = null;

  constructor(el: TopBarElements) {
    this.el = el;
    this.el.loadVideoBtn.disabled = false;
    this.el.loadVideoBtn.addEventListener('click', this.onVideoClick);
    this.el.loadFixtureBtn.disabled = false;
    this.el.loadFixtureBtn.addEventListener('click', this.onFixtureClick);
  }

  private readonly onVideoClick = (): void => {
    this.onLoadVideo?.();
  };

  private readonly onFixtureClick = (): void => {
    this.onLoadFixture?.();
  };

  dispose(): void {
    this.el.loadVideoBtn.removeEventListener('click', this.onVideoClick);
    this.el.loadFixtureBtn.removeEventListener('click', this.onFixtureClick);
  }
}
