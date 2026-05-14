import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';

/** Application configuration */
export interface AppConfig {
  vrmModelPath: string | null;
  animationFolderPath: string | null;
  windowPosition: { x: number; y: number };
  windowSize: { width: number; height: number };
  scale: number;
  micEnabled: boolean;
  cameraEnabled: boolean;
  targetFps: number;
  powerSaveMode: boolean;
  autonomousMovementPaused: boolean;
  animationLoopEnabled: boolean;
  autoExpressionEnabled: boolean;
  allowedAutoExpressions: string[];
  animationSpeed: number;
  moveSpeedMultiplier: number;
  systemAssetsDir: string;
  /** VRM 模型瀏覽對話框上次使用的資料夾（為空時從 vrmModelPath 推導） */
  vrmPickerFolder?: string;
  mtoonOutlineEnabled?: boolean;
  agent?: AgentConfig;
  headTracking?: HeadTrackingConfig;
}

/** 滑鼠頭部追蹤設定（與 src/types/config.ts HeadTrackingConfig 同步） */
export interface HeadTrackingConfig {
  enabled: boolean;
  weight: number;
  smoothingRate: number;
}

/**
 * my-agent 整合設定（與 src/types/config.ts AgentConfig 同步）。
 *
 * v0.4 之前：subprocess + ws（spawn `cli daemon` + AgentDaemonManager / AgentSessionClient）
 * v0.4 起（M-MASCOT-EMBED Phase 5）：in-process via AgentRuntime + vendor/my-agent/dist-embedded
 *
 * 舊欄位（daemonMode / bunBinaryPath / myAgentCliPath）保留以利平滑遷移；
 * AgentRuntime 不讀，預期 v0.5 完成後可刪除。
 */
export interface AgentConfig {
  /** Master toggle — 啟用 my-agent 功能（會 preload LLM 進入 standby） */
  enabled: boolean;
  /** Workspace 目錄；預設 ~/.virtual-assistant-desktop/agent-workspace */
  workspaceCwd: string | null;
  /** 本地 LLM 設定 */
  llm: {
    /** GGUF 模型絕對路徑；null 時 toggle ON 會 error */
    modelPath: string | null;
    /** Context window size；預設 4096 */
    contextSize: number;
    /** GPU layers；'auto' 由 node-llama-tcq 決定 */
    gpuLayers: number | 'auto';
    /** 替代方案：外部 llama.cpp HTTP endpoint（embedded 模式以外）*/
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
  /** Legacy 欄位（v0.3.x agent，subprocess mode）— AgentRuntime 不讀，預期 v0.5 移除 */
  daemonMode?: 'auto' | 'external';
  bunBinaryPath?: string | null;
  myAgentCliPath?: string | null;
}

/** Animation entry metadata */
export interface AnimationEntry {
  fileName: string;
  displayName: string;
  category: string;
  loop: boolean;
  weight: number;
}

/** Animation metadata collection */
export interface AnimationMeta {
  folderPath: string;
  entries: AnimationEntry[];
}

const DEFAULT_CONFIG: AppConfig = {
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
    // legacy 欄位保留（舊 config 反向相容；新版 AgentRuntime 不讀）
    daemonMode: 'auto',
    bunBinaryPath: null,
    myAgentCliPath: null,
  },
  headTracking: {
    enabled: true,
    weight: 0.7,
    smoothingRate: 4,
  },
};

/** Get config directory path (~/.virtual-assistant-desktop/) */
export function getConfigDir(): string {
  return path.join(os.homedir(), '.virtual-assistant-desktop');
}

function getConfigPath(): string {
  return path.join(getConfigDir(), 'config.json');
}

function getAnimationMetaPath(): string {
  return path.join(getConfigDir(), 'animations.json');
}

/** Ensure config directory exists */
export async function ensureConfigDir(): Promise<void> {
  const dir = getConfigDir();
  await fsp.mkdir(dir, { recursive: true });
}

/** Check if config.json exists */
export function getConfigExists(): boolean {
  return fs.existsSync(getConfigPath());
}

/** Read config.json, auto-backup and recreate if corrupted */
export async function readConfig(): Promise<AppConfig> {
  const configPath = getConfigPath();

  try {
    await fsp.access(configPath);
  } catch {
    return { ...DEFAULT_CONFIG };
  }

  try {
    const content = await fsp.readFile(configPath, 'utf-8');
    const parsed = JSON.parse(content) as Partial<AppConfig>;
    // 深合併 agent 內巢狀欄位（llm / daemon / webUi），舊 schema 的 config 自動補齊缺欄位
    const defaultAgent = DEFAULT_CONFIG.agent!;
    const parsedAgent: Partial<AgentConfig> = parsed.agent ?? {};
    const mergedAgent: AgentConfig = {
      ...defaultAgent,
      ...parsedAgent,
      llm: { ...defaultAgent.llm, ...(parsedAgent.llm ?? {}) },
      daemon: { ...defaultAgent.daemon, ...(parsedAgent.daemon ?? {}) },
      webUi: { ...defaultAgent.webUi, ...(parsedAgent.webUi ?? {}) },
    };
    return {
      ...DEFAULT_CONFIG,
      ...parsed,
      agent: mergedAgent,
      headTracking: { ...DEFAULT_CONFIG.headTracking!, ...(parsed.headTracking ?? {}) },
    };
  } catch (e) {
    console.warn(`[FileManager] config.json corrupted: ${e}. Backing up and recreating.`);
    const backupPath = path.join(getConfigDir(), 'config.json.bak');
    try {
      await fsp.copyFile(configPath, backupPath);
    } catch {
      // Backup might fail if original is unreadable
    }
    const defaultConfig = { ...DEFAULT_CONFIG };
    await writeConfig(defaultConfig);
    return defaultConfig;
  }
}

/** Write config.json */
export async function writeConfig(config: AppConfig): Promise<void> {
  await ensureConfigDir();
  const content = JSON.stringify(config, null, 2);
  await fsp.writeFile(getConfigPath(), content, 'utf-8');
}

/** Read animations.json */
export async function readAnimationMeta(): Promise<AnimationMeta> {
  const metaPath = getAnimationMetaPath();

  try {
    await fsp.access(metaPath);
  } catch {
    return { folderPath: '', entries: [] };
  }

  try {
    const content = await fsp.readFile(metaPath, 'utf-8');
    return JSON.parse(content) as AnimationMeta;
  } catch (e) {
    console.warn(`[FileManager] animations.json parse error: ${e}`);
    return { folderPath: '', entries: [] };
  }
}

/** Write animations.json */
export async function writeAnimationMeta(meta: AnimationMeta): Promise<void> {
  await ensureConfigDir();
  const content = JSON.stringify(meta, null, 2);
  await fsp.writeFile(getAnimationMetaPath(), content, 'utf-8');
}

/** Scan .vrm files in specified folder, returns full paths */
export async function scanVrmFiles(folderPath: string): Promise<string[]> {
  try {
    const stat = await fsp.stat(folderPath);
    if (!stat.isDirectory()) return [];
  } catch {
    return [];
  }

  const entries = await fsp.readdir(folderPath);
  return entries
    .filter((f) => f.toLowerCase().endsWith('.vrm'))
    .sort()
    .map((f) => path.join(folderPath, f));
}

/** Scan .vrma files in specified folder */
export async function scanVrmaFiles(folderPath: string): Promise<string[]> {
  try {
    const stat = await fsp.stat(folderPath);
    if (!stat.isDirectory()) {
      throw new Error(`Animation folder does not exist: ${folderPath}`);
    }
  } catch (e) {
    throw new Error(`Animation folder does not exist: ${folderPath} (${e})`);
  }

  const entries = await fsp.readdir(folderPath);
  return entries
    .filter((f) => f.toLowerCase().endsWith('.vrma'))
    .sort();
}

/** Sync scanned results with existing metadata */
export function syncAnimationMeta(
  folderPath: string,
  existing: AnimationMeta,
  scannedFiles: string[],
): AnimationMeta {
  const entries: AnimationEntry[] = [];

  for (const fileName of scannedFiles) {
    const existingEntry = existing.entries.find((e) => e.fileName === fileName);
    if (existingEntry) {
      entries.push(existingEntry);
    } else {
      const displayName = fileName.replace(/\.vrma$/i, '');
      entries.push({
        fileName,
        displayName,
        category: 'action',
        loop: false,
        weight: 1.0,
      });
    }
  }

  return { folderPath, entries };
}

/** Scan animations folder and sync with metadata */
export async function scanAnimations(folderPath: string): Promise<AnimationMeta> {
  const scannedFiles = await scanVrmaFiles(folderPath);
  const existing = await readAnimationMeta();
  const synced = syncAnimationMeta(folderPath, existing, scannedFiles);
  await writeAnimationMeta(synced);
  return synced;
}
