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
    return { ...DEFAULT_CONFIG, ...parsed };
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

// ─────────────────────────────────────────────────────────
// 使用者動畫管理（影片動作轉換器 Phase 12）
// ~/.virtual-assistant-desktop/user-vrma/
//   ├── <name>.vad.json  — 中繼動畫資料（必存）
//   └── <name>.vrma      — VRM Animation binary（選填，Phase 13）
// ─────────────────────────────────────────────────────────

/** 使用者動畫項目（list_user_vrmas 的回傳元素） */
export interface UserVrmaEntry {
  /** 不含副檔名的名稱，供顯示與 tray action id */
  name: string;
  /** .vad.json 檔案完整路徑 */
  vadPath: string;
  /** .vrma 檔案完整路徑（若存在；Phase 13 之前可能為 null） */
  vrmaPath: string | null;
  /** .vad.json 建立時間（ms since epoch） */
  createdAtMs: number;
}

/** 取得使用者動畫目錄路徑 ~/.virtual-assistant-desktop/user-vrma/ */
export function getUserVrmaDir(): string {
  return path.join(getConfigDir(), 'user-vrma');
}

/** 確保使用者動畫目錄存在 */
export async function ensureUserVrmaDir(): Promise<void> {
  await fsp.mkdir(getUserVrmaDir(), { recursive: true });
}

/**
 * 清理名稱避免路徑注入與檔案系統非法字元。
 *
 * 保留：英數、底線、連字號、點、中文與全形字元。其他一律換為底線。
 */
export function sanitizeVrmaName(name: string): string {
  // 禁用 Windows 路徑分隔符、控制字元與 URL 保留字
  const trimmed = name.trim().replace(/[/\\:*?"<>|\x00-\x1f]/g, '_');
  // 避免空字串、"." "..""
  if (!trimmed || trimmed === '.' || trimmed === '..') return 'untitled';
  // 限制長度
  return trimmed.slice(0, 120);
}

/** 列出 user-vrma/ 所有使用者動畫（按 createdAtMs 降序） */
export async function listUserVrmas(): Promise<UserVrmaEntry[]> {
  await ensureUserVrmaDir();
  const dir = getUserVrmaDir();
  const files = await fsp.readdir(dir);
  const vadFiles = files.filter((f) => f.toLowerCase().endsWith('.vad.json'));

  const entries: UserVrmaEntry[] = [];
  for (const vad of vadFiles) {
    const name = vad.replace(/\.vad\.json$/i, '');
    const vadPath = path.join(dir, vad);
    const vrmaPath = path.join(dir, `${name}.vrma`);
    const vrmaExists = fs.existsSync(vrmaPath);
    let createdAtMs = 0;
    try {
      const stat = await fsp.stat(vadPath);
      createdAtMs = stat.mtimeMs;
    } catch {
      /* ignore */
    }
    entries.push({
      name,
      vadPath,
      vrmaPath: vrmaExists ? vrmaPath : null,
      createdAtMs,
    });
  }
  entries.sort((a, b) => b.createdAtMs - a.createdAtMs);
  return entries;
}

/**
 * 寫入一組使用者動畫（.vad.json 必存，.vrma 選填）。
 *
 * @param name 名稱（會經 sanitizeVrmaName 清理）
 * @param vadJson .vad.json 檔案內容字串
 * @param vrmaBuffer .vrma 檔案二進位（Phase 13 會用到；Phase 12 傳 null）
 */
export async function writeUserVrma(
  name: string,
  vadJson: string,
  vrmaBuffer: ArrayBuffer | null
): Promise<{ name: string; vadPath: string; vrmaPath: string | null }> {
  await ensureUserVrmaDir();
  const safeName = sanitizeVrmaName(name);
  const dir = getUserVrmaDir();
  const vadPath = path.join(dir, `${safeName}.vad.json`);
  await fsp.writeFile(vadPath, vadJson, 'utf8');

  let vrmaPath: string | null = null;
  if (vrmaBuffer) {
    vrmaPath = path.join(dir, `${safeName}.vrma`);
    await fsp.writeFile(vrmaPath, Buffer.from(vrmaBuffer));
  }
  return { name: safeName, vadPath, vrmaPath };
}

/** 讀取 .vad.json 檔案內容 */
export async function readUserVad(vadPath: string): Promise<string> {
  return fsp.readFile(vadPath, 'utf8');
}

/** 刪除一組使用者動畫（.vad.json + 同名 .vrma 若存在） */
export async function deleteUserVrma(vadPath: string): Promise<boolean> {
  try {
    await fsp.unlink(vadPath);
    const vrmaPath = vadPath.replace(/\.vad\.json$/i, '.vrma');
    if (fs.existsSync(vrmaPath)) {
      await fsp.unlink(vrmaPath);
    }
    return true;
  } catch (e) {
    console.warn('[fileManager] deleteUserVrma failed:', e);
    return false;
  }
}
