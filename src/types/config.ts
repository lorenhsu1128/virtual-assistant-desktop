/** 應用程式設定 */
export interface AppConfig {
  /** 當前選用的 VRM 模型路徑 */
  vrmModelPath: string | null;
  /** 動畫資料夾路徑 */
  animationFolderPath: string | null;
  /** 視窗位置 */
  windowPosition: Position;
  /** 視窗大小 */
  windowSize: Size;
  /** 角色縮放比例（0.5–2.0） */
  scale: number;
  /** 麥克風開關 */
  micEnabled: boolean;
  /** 攝影機開關 */
  cameraEnabled: boolean;
  /** 目標幀率 */
  targetFps: number;
  /** 省電模式 */
  powerSaveMode: boolean;
  /** 自主移動暫停 */
  autonomousMovementPaused: boolean;
  /** 動畫循環開關 */
  animationLoopEnabled: boolean;
  /** 自動表情開關 */
  autoExpressionEnabled: boolean;
  /** 允許自動播放的表情名稱（空陣列 = 全部允許） */
  allowedAutoExpressions: string[];
  /** 動畫播放速率倍率 */
  animationSpeed: number;
}

/** 2D 位置 */
export interface Position {
  x: number;
  y: number;
}

/** 2D 大小 */
export interface Size {
  width: number;
  height: number;
}

/** 預設設定值 */
export const DEFAULT_CONFIG: AppConfig = {
  vrmModelPath: null,
  animationFolderPath: null,
  windowPosition: { x: 0, y: 0 },
  windowSize: { width: 400, height: 600 },
  scale: 1.0,
  micEnabled: false,
  cameraEnabled: false,
  targetFps: 30,
  powerSaveMode: false,
  autonomousMovementPaused: false,
  animationLoopEnabled: true,
  autoExpressionEnabled: true,
  allowedAutoExpressions: [],
  animationSpeed: 1.0,
};
