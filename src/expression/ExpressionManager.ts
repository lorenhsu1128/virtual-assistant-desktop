/** 表情狀態（含過渡） */
export interface ExpressionState {
  /** 當前 fading-in 表情（value 從 0 → 1） */
  current: { name: string; value: number } | null;
  /** 上一個 fading-out 表情（value 從 X → 0），用於兩個表情交叉淡化 */
  previous: { name: string; value: number } | null;
}

/** 自動表情隨機間隔範圍（秒） */
const AUTO_MIN_INTERVAL = 15;
const AUTO_MAX_INTERVAL = 45;

/**
 * 表情管理器
 *
 * 管理 BlendShape 表情的自動輪播與手動切換，支援平滑過渡（0.5 秒線性 fade）。
 * 純邏輯模組，不依賴 Three.js 或 Tauri。
 *
 * 優先級（由高到低）：
 * 1. 手動指定的表情
 * 2. 自動隨機表情
 *
 * 過渡機制：
 * - 切換到新表情時，舊表情進入 previous slot 開始 fade out（從當前 value → 0）
 * - 新表情進入 current slot 開始 fade in（從 0 → 1）
 * - 兩者每幀以 deltaTime / TRANSITION_DURATION 線性推進
 * - previousValue 降到 0 後 previous slot 釋放
 *
 * 注意：.vrma 動畫內的表情軌道優先級最高，
 * 由 SceneManager 在動畫播放中跳過 resolve() 來實現。
 *
 * 未來擴充（階段 B）：若加入「每表情對應的 .vrma 動畫檔」由獨立的
 * ExpressionAnimationManager 經 mixer 播放，SceneManager 會在那種情況下
 * 跳過本模組（與目前 actionPlaying 跳過機制一致）。
 */
export class ExpressionManager {
  /** 過渡持續時間（秒） */
  private static readonly TRANSITION_DURATION = 0.5;

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

  /** 當前 fading-in 表情名稱 */
  private currentName: string | null = null;
  /** 當前 fading-in 表情權重（0..1） */
  private currentValue = 0;
  /** 上一個 fading-out 表情名稱 */
  private previousName: string | null = null;
  /** 上一個 fading-out 表情權重（X..0） */
  private previousValue = 0;

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
      // 關閉自動模式 → 若當前為自動表情則清除（觸發 fade out）
      if (this.currentAutoExpression !== null) {
        this.currentAutoExpression = null;
        if (!this.manualExpression) {
          this.setActiveExpression(null);
        }
      }
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
   * 切換時會觸發過渡（舊表情 fade out + 新表情 fade in）。
   */
  setManualExpression(name: string | null): void {
    this.manualExpression = name;
    // 立即套用新的目標表情
    this.setActiveExpression(name ?? this.currentAutoExpression);
  }

  /** 取得當前手動表情 */
  getManualExpression(): string | null {
    return this.manualExpression;
  }

  /**
   * 更新自動計時器與過渡推進
   *
   * 由 SceneManager render loop 呼叫。
   */
  update(deltaTime: number): void {
    // 自動表情選取
    if (this.autoEnabled) {
      this.autoTimer += deltaTime;
      if (this.autoTimer >= this.autoInterval) {
        this.pickNextAutoExpression();
        this.resetAutoTimer();
      }
    }

    // 過渡推進
    this.updateTransition(deltaTime);
  }

  /**
   * 表情狀態查詢
   *
   * 回傳當前 fading-in 與 fading-out 兩個表情。
   * 兩者皆 null = 無表情。
   *
   * 注意：呼叫端須同時套用 current 與 previous 才能正確顯示交叉淡化。
   */
  resolve(): ExpressionState {
    return {
      current: this.currentName
        ? { name: this.currentName, value: this.currentValue }
        : null,
      previous: this.previousName
        ? { name: this.previousName, value: this.previousValue }
        : null,
    };
  }

  /** 取得可用表情清單 */
  getAvailableExpressions(): string[] {
    return this.availableExpressions;
  }

  /**
   * 切換目標表情（內部統一入口）
   *
   * 把當前表情移到 previous 開始 fade out，新表情進 current 從 0 開始 fade in。
   * 若 name 與目前相同則不動作。
   */
  private setActiveExpression(name: string | null): void {
    if (name === this.currentName) return;

    // 先處理 previous slot：若已有 previous 還在 fade out 就直接覆蓋
    // （沒有處理多層交叉淡化的需求，最多兩個 slot）
    if (this.currentName !== null) {
      this.previousName = this.currentName;
      this.previousValue = this.currentValue;
    }
    // 設定新的 current
    this.currentName = name;
    this.currentValue = 0;
  }

  /** 線性推進過渡（每幀呼叫一次） */
  private updateTransition(deltaTime: number): void {
    const step = deltaTime / ExpressionManager.TRANSITION_DURATION;

    if (this.currentName !== null && this.currentValue < 1) {
      this.currentValue = Math.min(1, this.currentValue + step);
    }

    if (this.previousName !== null) {
      this.previousValue = Math.max(0, this.previousValue - step);
      if (this.previousValue <= 0) {
        this.previousName = null;
        this.previousValue = 0;
      }
    }
  }

  /** 隨機選取下一個自動表情 */
  private pickNextAutoExpression(): void {
    const pool = this.getAutoPool();
    if (pool.length === 0) {
      this.currentAutoExpression = null;
      // 若沒有手動表情，觸發 fade out
      if (!this.manualExpression) {
        this.setActiveExpression(null);
      }
      return;
    }

    // 避免連續選到同一個
    let next: string;
    if (pool.length > 1) {
      do {
        next = pool[Math.floor(Math.random() * pool.length)];
      } while (next === this.currentAutoExpression);
    } else {
      next = pool[0];
    }
    this.currentAutoExpression = next;

    // 若沒有手動表情覆蓋，立即套用新自動表情（觸發 fade）
    if (!this.manualExpression) {
      this.setActiveExpression(next);
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
