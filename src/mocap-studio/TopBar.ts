/**
 * 影片動捕工作站 — 上方工具列
 *
 * Phase 1：「載入影片」按鈕
 * Phase 2c：「[dev] 載入測試 fixture」按鈕（開發期驗證下游 pipeline）
 * Phase 5a：「[dev] 偵測姿態」按鈕（手動單張 MediaPipe 偵測）
 * Phase 5d：引擎下拉 + 「轉換」按鈕（HybrIK-TS 批次解算區間）
 */

export type TopBarCallback = () => void;
export type EngineChangeCallback = (engineId: string) => void;

/** 引擎下拉選項 */
export interface EngineOption {
  id: string;
  name: string;
}

export interface TopBarElements {
  loadVideoBtn: HTMLButtonElement;
  loadFixtureBtn: HTMLButtonElement;
  detectPoseBtn: HTMLButtonElement;
  engineSelect: HTMLSelectElement;
  convertBtn: HTMLButtonElement;
}

export class TopBar {
  private readonly el: TopBarElements;

  /** 使用者點擊「載入影片」 */
  onLoadVideo: TopBarCallback | null = null;
  /** 使用者點擊「[dev] 載入測試 fixture」 */
  onLoadFixture: TopBarCallback | null = null;
  /** 使用者點擊「[dev] 偵測姿態」 */
  onDetectPose: TopBarCallback | null = null;
  /** 使用者點擊「轉換」 */
  onConvert: TopBarCallback | null = null;
  /** 使用者切換引擎下拉 */
  onEngineChange: EngineChangeCallback | null = null;

  constructor(el: TopBarElements) {
    this.el = el;
    this.el.loadVideoBtn.disabled = false;
    this.el.loadVideoBtn.addEventListener('click', this.onVideoClick);
    this.el.loadFixtureBtn.disabled = false;
    this.el.loadFixtureBtn.addEventListener('click', this.onFixtureClick);
    // detect pose / convert 按鈕預設 disabled，載入影片後由 MocapStudioApp 啟用
    this.el.detectPoseBtn.addEventListener('click', this.onDetectClick);
    this.el.convertBtn.addEventListener('click', this.onConvertClick);
    this.el.engineSelect.addEventListener('change', this.onEngineSelectChange);
  }

  /** 啟用 / 停用「偵測姿態」按鈕 */
  setDetectPoseEnabled(enabled: boolean): void {
    this.el.detectPoseBtn.disabled = !enabled;
  }

  /** 啟用 / 停用「轉換」按鈕 */
  setConvertEnabled(enabled: boolean): void {
    this.el.convertBtn.disabled = !enabled;
  }

  /** 設定「轉換」按鈕顯示文字（供「取消中...」等狀態使用） */
  setConvertLabel(label: string): void {
    this.el.convertBtn.textContent = label;
  }

  /** 填入引擎下拉選項 */
  populateEngines(engines: readonly EngineOption[], selectedId?: string): void {
    const sel = this.el.engineSelect;
    sel.innerHTML = '';
    for (const e of engines) {
      const opt = document.createElement('option');
      opt.value = e.id;
      opt.textContent = e.name;
      sel.appendChild(opt);
    }
    if (selectedId) sel.value = selectedId;
    sel.disabled = engines.length === 0;
  }

  getSelectedEngineId(): string {
    return this.el.engineSelect.value;
  }

  private readonly onVideoClick = (): void => {
    this.onLoadVideo?.();
  };

  private readonly onFixtureClick = (): void => {
    this.onLoadFixture?.();
  };

  private readonly onDetectClick = (): void => {
    this.onDetectPose?.();
  };

  private readonly onConvertClick = (): void => {
    this.onConvert?.();
  };

  private readonly onEngineSelectChange = (): void => {
    this.onEngineChange?.(this.el.engineSelect.value);
  };

  dispose(): void {
    this.el.loadVideoBtn.removeEventListener('click', this.onVideoClick);
    this.el.loadFixtureBtn.removeEventListener('click', this.onFixtureClick);
    this.el.detectPoseBtn.removeEventListener('click', this.onDetectClick);
    this.el.convertBtn.removeEventListener('click', this.onConvertClick);
    this.el.engineSelect.removeEventListener('change', this.onEngineSelectChange);
  }
}
