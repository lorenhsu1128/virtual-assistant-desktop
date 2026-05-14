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
  /**
   * 工作列移動模式：角色固定縮成 0.5×、Y 鎖定在工作列上緣、
   * 自主移動限制在 workArea X 範圍。離開模式後恢復原 scale。
   */
  taskbarMode: boolean;
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
  /** 滑鼠頭部追蹤設定 */
  headTracking: HeadTrackingConfig;
}

/** 滑鼠頭部追蹤設定（眼睛 + 頭 + 上身連動） */
export interface HeadTrackingConfig {
  /** 主開關 */
  enabled: boolean;
  /** 與動畫頭部 quaternion 的混合權重（0..1，預設 0.7） */
  weight: number;
  /** 目標座標平滑速率 per second（預設 12） */
  smoothingRate: number;
}

/**
 * my-agent 整合設定（與 electron/fileManager.ts AgentConfig 同步）。
 *
 * v0.4 起（M-MASCOT-EMBED）：in-process via AgentRuntime + vendor/my-agent/dist-embedded。
 * 舊欄位（daemonMode / bunBinaryPath / myAgentCliPath）保留作平滑遷移用，
 * AgentRuntime 不讀。
 */
export interface AgentConfig {
  /** Master toggle — 啟用 my-agent 功能（會 preload LLM 進入 standby） */
  enabled: boolean;
  /** Agent workspace cwd（null = 用預設隔離目錄 ~/.virtual-assistant-desktop/agent-workspace） */
  workspaceCwd: string | null;
  /** 本地 LLM 設定 */
  llm: {
    /** GGUF 模型絕對路徑；null 時 toggle ON 會 error */
    modelPath: string | null;
    /** Context window size；預設 4096 */
    contextSize: number;
    /** GPU layers；'auto' 由 node-llama-tcq 決定 */
    gpuLayers: number | 'auto';
    /** 替代方案：外部 llama.cpp HTTP endpoint */
    externalUrl: string | null;
  };
  /** Opt-in daemon WS server（讓外部 my-agent CLI / 第二個 Electron window 連） */
  daemon: {
    enabled: boolean;
    port: number;
  };
  /** Opt-in web UI HTTP server */
  webUi: {
    enabled: boolean;
    port: number;
  };
  /** Legacy 欄位（v0.3.x agent，subprocess mode）— AgentRuntime 不讀 */
  daemonMode?: 'auto' | 'external';
  bunBinaryPath?: string | null;
  myAgentCliPath?: string | null;
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
  taskbarMode: false,
  animationLoopEnabled: true,
  autoExpressionEnabled: true,
  allowedAutoExpressions: [],
  animationSpeed: 1.0,
  moveSpeedMultiplier: 1.0,
  systemAssetsDir: 'assets/system',
  mtoonOutlineEnabled: false,
  agent: {
    enabled: false,
    workspaceCwd: null,
    llm: {
      modelPath: null,
      contextSize: 4096,
      gpuLayers: 'auto',
      externalUrl: null,
    },
    daemon: {
      enabled: false,
      port: 0,
    },
    webUi: {
      enabled: false,
      port: 0,
    },
    // legacy 欄位（v0.3.x agent，subprocess mode）— AgentRuntime 不讀
    daemonMode: 'auto',
    bunBinaryPath: null,
    myAgentCliPath: null,
  },
  headTracking: {
    enabled: true,
    weight: 0.7,
    smoothingRate: 2.5,
  },
};
