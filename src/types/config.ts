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
  /** 移動速率倍率（0.5–1.5，預設 1.0） */
  moveSpeedMultiplier: number;
  /** 系統預設資產根目錄（相對於 app 根目錄，子目錄約定 vrm/ + vrma/） */
  systemAssetsDir: string;
  /** 當前所在的 display index（啟動時恢復） */
  currentDisplayIndex?: number;
  /** VRM 模型瀏覽對話框上次使用的資料夾（為空時從 vrmModelPath 推導） */
  vrmPickerFolder?: string;
  /**
   * 是否啟用 MToon 描邊（outline）
   *
   * 主視窗使用 OrthographicCamera，在正交投影下 MToon 的
   * `outlineWidthMode: screenCoordinates` shader 數學會失真，
   * 造成角色輪廓出現粗黑邊。預設關閉。
   */
  mtoonOutlineEnabled: boolean;
  /** my-agent 整合設定 */
  agent: AgentConfig;
}

/** my-agent daemon 整合設定 */
export interface AgentConfig {
  /** 是否啟用 agent 功能（預設 false，由首次啟動引導開啟） */
  enabled: boolean;
  /**
   * Daemon 生命週期模式：
   * - `auto`：桌寵自動 spawn / 監看 / 關閉 daemon
   * - `external`：使用者自己 `./cli daemon start`，桌寵僅連線
   */
  daemonMode: 'auto' | 'external';
  /** Bun runtime 執行檔路徑（null = 自動偵測） */
  bunBinaryPath: string | null;
  /** my-agent CLI 入口路徑（null = 自動偵測） */
  myAgentCliPath: string | null;
  /** Agent workspace cwd（null = 用預設隔離目錄） */
  workspaceCwd: string | null;
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
  moveSpeedMultiplier: 1.0,
  systemAssetsDir: 'assets/system',
  mtoonOutlineEnabled: false,
  agent: {
    enabled: false,
    daemonMode: 'auto',
    bunBinaryPath: null,
    myAgentCliPath: null,
    workspaceCwd: null,
  },
};
