/** 表情 resolve 結果 */
export interface ExpressionResult {
  /** 表情名稱 */
  name: string;
  /** 權重（0.0–1.0） */
  value: number;
}

/** 自動表情隨機間隔範圍（秒） */
const AUTO_MIN_INTERVAL = 15;
const AUTO_MAX_INTERVAL = 45;

/**
 * 表情管理器
 *
 * 管理 BlendShape 表情的自動輪播與手動切換。
 * 純邏輯模組，不依賴 Three.js 或 Tauri。
 *
 * 優先級（由高到低）：
 * 1. 手動指定的表情
 * 2. 自動隨機表情
 *
 * 注意：.vrma 動畫內的表情軌道優先級最高，
 * 由 SceneManager 在動畫播放中跳過 resolve() 來實現。
 */
export class ExpressionManager {
  /** 模型支援的所有表情名稱 */
  private availableExpressions: string[] = [];

  /** 允許自動播放的表情（空陣列 = 全部允許） */
  private allowedAutoExpressions: string[] = [];

  /** 自動模式開關 */
  private autoEnabled = true;

  /** 手動指定的表情（null = 無手動覆蓋） */
  private manualExpression: string | null = null;

  /** 當前自動選取的表情 */
  private currentAutoExpression: string | null = null;

  /** 自動計時器 */
  private autoTimer = 0;
  private autoInterval = 0;

  constructor() {
    this.resetAutoTimer();
  }

  /** 設定可用表情清單（從 VRM 模型讀取） */
  setAvailableExpressions(expressions: string[]): void {
    this.availableExpressions = expressions;
  }

  /** 設定允許自動播放的表情（空陣列 = 全部允許） */
  setAllowedAutoExpressions(names: string[]): void {
    this.allowedAutoExpressions = names;
  }

  /** 設定自動模式開關 */
  setAutoEnabled(enabled: boolean): void {
    this.autoEnabled = enabled;
    if (!enabled) {
      this.currentAutoExpression = null;
    }
  }

  /** 取得自動模式狀態 */
  isAutoEnabled(): boolean {
    return this.autoEnabled;
  }

  /**
   * 手動指定表情
   *
   * 設定後會覆蓋自動表情，直到傳入 null 清除。
   */
  setManualExpression(name: string | null): void {
    this.manualExpression = name;
  }

  /** 取得當前手動表情 */
  getManualExpression(): string | null {
    return this.manualExpression;
  }

  /**
   * 更新自動計時器
   *
   * 由 SceneManager render loop 呼叫。
   */
  update(deltaTime: number): void {
    if (!this.autoEnabled) return;

    this.autoTimer += deltaTime;
    if (this.autoTimer >= this.autoInterval) {
      this.pickNextAutoExpression();
      this.resetAutoTimer();
    }
  }

  /**
   * 表情優先級仲裁
   *
   * 回傳當前應套用的表情。
   * 優先級：手動 > 自動。
   * 回傳 null 代表無表情（清除所有表情）。
   */
  resolve(): ExpressionResult | null {
    // 手動優先
    if (this.manualExpression) {
      return { name: this.manualExpression, value: 1.0 };
    }

    // 自動
    if (this.autoEnabled && this.currentAutoExpression) {
      return { name: this.currentAutoExpression, value: 1.0 };
    }

    return null;
  }

  /** 取得可用表情清單 */
  getAvailableExpressions(): string[] {
    return this.availableExpressions;
  }

  /** 隨機選取下一個自動表情 */
  private pickNextAutoExpression(): void {
    const pool = this.getAutoPool();
    if (pool.length === 0) {
      this.currentAutoExpression = null;
      return;
    }

    // 避免連續選到同一個
    if (pool.length > 1) {
      let next: string;
      do {
        next = pool[Math.floor(Math.random() * pool.length)];
      } while (next === this.currentAutoExpression);
      this.currentAutoExpression = next;
    } else {
      this.currentAutoExpression = pool[0];
    }
  }

  /** 取得自動表情候選池 */
  private getAutoPool(): string[] {
    if (this.allowedAutoExpressions.length > 0) {
      // 過濾：只保留模型實際支援的表情
      return this.allowedAutoExpressions.filter(
        (name) => this.availableExpressions.includes(name),
      );
    }
    // 空白名單 = 全部允許
    return this.availableExpressions;
  }

  /** 重置自動計時器 */
  private resetAutoTimer(): void {
    this.autoTimer = 0;
    this.autoInterval = AUTO_MIN_INTERVAL + Math.random() * (AUTO_MAX_INTERVAL - AUTO_MIN_INTERVAL);
  }
}
