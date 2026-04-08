/**
 * 影片動作轉換器 — Settings Panel
 *
 * 右側 slide-out 面板，調整 PoseSolver / GaussianQuatSmoother /
 * Stage 2 fps 等執行時參數。透過 callbacks 與外部 state 同步。
 *
 * 對應計畫：video-converter-plan.md 第 2.10 / 第 7 節 Phase 14
 *
 * 設計：
 *   - 由「⚙ 設定」按鈕 toggle 可見性
 *   - 變更時即時呼叫 onChange callback（不需要 apply 按鈕）
 *   - 不直接持有 PoseSolver / Smoother 實例，由呼叫端注入 callbacks
 */

export interface SettingsState {
  enableHands: boolean;
  enableEyes: boolean;
  gaussianSigma: number;
  gaussianHalfWindow: number;
  stage2Fps: number;
}

export const DEFAULT_SETTINGS: SettingsState = {
  enableHands: false,
  enableEyes: true,
  gaussianSigma: 1.5,
  gaussianHalfWindow: 3,
  stage2Fps: 30,
};

export type SettingsChangeCallback = (settings: SettingsState) => void;

export class SettingsPanel {
  private container: HTMLElement;
  private state: SettingsState;
  private onChangeCb: SettingsChangeCallback | null = null;
  private visible = false;

  constructor(container: HTMLElement, initial: SettingsState = DEFAULT_SETTINGS) {
    this.container = container;
    this.state = { ...initial };

    container.classList.add('vc-settings-panel');
    container.style.display = 'none';
    container.innerHTML = `
      <div class="vc-settings-header">
        <h2>設定</h2>
        <button type="button" class="vc-settings-close" aria-label="關閉">×</button>
      </div>
      <div class="vc-settings-section">
        <div class="vc-settings-section-title">PoseSolver</div>
        <label class="vc-settings-row">
          <input type="checkbox" data-key="enableHands" />
          <span>啟用手指追蹤</span>
        </label>
        <label class="vc-settings-row">
          <input type="checkbox" data-key="enableEyes" />
          <span>啟用眼睛追蹤</span>
        </label>
      </div>
      <div class="vc-settings-section">
        <div class="vc-settings-section-title">Stage 2 — Gaussian 平滑</div>
        <label class="vc-settings-row vc-settings-slider-row">
          <span>Sigma</span>
          <input type="range" data-key="gaussianSigma" min="0.5" max="5" step="0.1" />
          <span class="vc-settings-value" data-display="gaussianSigma"></span>
        </label>
        <label class="vc-settings-row vc-settings-slider-row">
          <span>視窗半寬</span>
          <input type="range" data-key="gaussianHalfWindow" min="1" max="8" step="1" />
          <span class="vc-settings-value" data-display="gaussianHalfWindow"></span>
        </label>
      </div>
      <div class="vc-settings-section">
        <div class="vc-settings-section-title">Stage 2 — 重抽率</div>
        <label class="vc-settings-row vc-settings-slider-row">
          <span>FPS</span>
          <input type="range" data-key="stage2Fps" min="15" max="60" step="5" />
          <span class="vc-settings-value" data-display="stage2Fps"></span>
        </label>
      </div>
      <div class="vc-settings-footer">
        <small>變更即時生效，下次擷取/Stage 2 套用</small>
      </div>
    `;

    // Wire close button
    container.querySelector<HTMLButtonElement>('.vc-settings-close')?.addEventListener(
      'click',
      () => this.hide()
    );

    // Wire all inputs
    container.querySelectorAll<HTMLInputElement>('input[data-key]').forEach((input) => {
      const key = input.dataset.key as keyof SettingsState;
      // 初始化 input value
      this.syncInput(input, key);
      input.addEventListener('input', () => {
        this.handleInputChange(input, key);
      });
    });

    this.refreshDisplays();
  }

  /** 設定變更 callback */
  onChange(cb: SettingsChangeCallback): void {
    this.onChangeCb = cb;
  }

  show(): void {
    this.visible = true;
    this.container.style.display = 'flex';
  }

  hide(): void {
    this.visible = false;
    this.container.style.display = 'none';
  }

  toggle(): void {
    if (this.visible) this.hide();
    else this.show();
  }

  getState(): SettingsState {
    return { ...this.state };
  }

  /** 從外部設定一組新狀態（會更新 UI 但不觸發 onChange） */
  setState(next: Partial<SettingsState>): void {
    this.state = { ...this.state, ...next };
    this.container.querySelectorAll<HTMLInputElement>('input[data-key]').forEach((input) => {
      const key = input.dataset.key as keyof SettingsState;
      this.syncInput(input, key);
    });
    this.refreshDisplays();
  }

  private syncInput(input: HTMLInputElement, key: keyof SettingsState): void {
    const value = this.state[key];
    if (input.type === 'checkbox') {
      input.checked = Boolean(value);
    } else {
      input.value = String(value);
    }
  }

  private handleInputChange(input: HTMLInputElement, key: keyof SettingsState): void {
    if (input.type === 'checkbox') {
      // 兩個 boolean 欄位
      if (key === 'enableHands' || key === 'enableEyes') {
        this.state[key] = input.checked;
      }
    } else {
      const num = parseFloat(input.value);
      if (key === 'gaussianSigma' || key === 'gaussianHalfWindow' || key === 'stage2Fps') {
        this.state[key] = num;
      }
    }
    this.refreshDisplays();
    this.onChangeCb?.(this.getState());
  }

  private refreshDisplays(): void {
    this.container
      .querySelectorAll<HTMLSpanElement>('.vc-settings-value[data-display]')
      .forEach((span) => {
        const key = span.dataset.display as keyof SettingsState;
        const value = this.state[key];
        span.textContent =
          typeof value === 'number'
            ? value % 1 === 0
              ? String(value)
              : value.toFixed(1)
            : String(value);
      });
  }
}
