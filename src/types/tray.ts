/**
 * 系統托盤選單資料
 *
 * 由 renderer process 收集後傳送至 main process，
 * 用於建構 native Menu。
 */
export interface TrayMenuData {
  /** action 分類的動畫清單 */
  animations: { fileName: string; displayName: string }[];
  /** 模型支援的表情清單 */
  expressions: string[];
  /** 當前縮放比例 */
  currentScale: number;
  /** 當前動畫速率 */
  currentSpeed: number;
  /** 自主移動是否暫停 */
  isPaused: boolean;
  /** 自動表情是否啟用 */
  isAutoExpressionEnabled: boolean;
  /** 動畫循環是否啟用 */
  isLoopEnabled: boolean;
  /** Debug 模式是否啟用 */
  isDebugEnabled: boolean;
  /** 當前移動速率倍率 */
  currentMoveSpeed: number;
  /** 當前手動設定的表情（null = 無） */
  currentExpression: string | null;
  /** 螢幕清單（用於「螢幕 → 切換到」子選單） */
  displays: { index: number; label: string }[];
  /** MToon 描邊是否啟用 */
  isMToonOutlineEnabled: boolean;
  /** 滑鼠頭部追蹤是否啟用 */
  isHeadTrackingEnabled: boolean;
  /** 工作列移動模式是否啟用 */
  isTaskbarModeEnabled: boolean;
}
