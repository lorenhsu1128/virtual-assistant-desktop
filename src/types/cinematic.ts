/**
 * 演出系統型別定義
 *
 * CinematicRunner 的輸入配置與每幀輸出資料結構。
 */

/** 演出階段 */
export type CinematicPhase = 'run-in' | 'hold' | 'run-out' | 'done';

/** CinematicRunner 每幀輸出 */
export interface CinematicFrame {
  /** 模型 scale 倍率（相對於使用者設定的 scale） */
  scale: number;
  /** 螢幕 X 座標（像素） */
  positionX: number;
  /** 螢幕 Y 座標（像素） */
  positionY: number;
  /** 是否轉身（run-out 階段背對鏡頭） */
  facingReversed: boolean;
  /** walk 動畫速率倍率（1.0 = 正常） */
  walkSpeed: number;
  /** 當前階段 */
  phase: CinematicPhase;
  /** 要套用的表情名稱（null = 清除表情） */
  expression: string | null;
}

/** CinematicRunner 建構配置 */
export interface CinematicConfig {
  /** 螢幕寬度（像素） */
  screenWidth: number;
  /** 螢幕高度（像素） */
  screenHeight: number;
  /** 角色 bounding box 寬度（像素） */
  characterWidth: number;
  /** 角色 bounding box 高度（像素） */
  characterHeight: number;
  /** 演出前角色位置 */
  originalPosition: { x: number; y: number };
  /** 演出前使用者 scale 值 */
  originalScale: number;
  /** 可用表情名稱清單（hold 階段隨機選取） */
  availableExpressions: string[];
}
