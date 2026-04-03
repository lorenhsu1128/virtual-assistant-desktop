import * as fs from 'node:fs';
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
export function ensureConfigDir(): void {
  const dir = getConfigDir();
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

/** Check if config.json exists */
export function getConfigExists(): boolean {
  return fs.existsSync(getConfigPath());
}

/** Read config.json, auto-backup and recreate if corrupted */
export function readConfig(): AppConfig {
  const configPath = getConfigPath();

  if (!fs.existsSync(configPath)) {
    return { ...DEFAULT_CONFIG };
  }

  try {
    const content = fs.readFileSync(configPath, 'utf-8');
    const parsed = JSON.parse(content) as Partial<AppConfig>;
    // Merge with defaults to fill missing fields
    return { ...DEFAULT_CONFIG, ...parsed };
  } catch (e) {
    console.warn(`[FileManager] config.json corrupted: ${e}. Backing up and recreating.`);
    const backupPath = path.join(getConfigDir(), 'config.json.bak');
    try {
      fs.copyFileSync(configPath, backupPath);
    } catch {
      // Backup might fail if original is unreadable
    }
    const defaultConfig = { ...DEFAULT_CONFIG };
    writeConfig(defaultConfig);
    return defaultConfig;
  }
}

/** Write config.json */
export function writeConfig(config: AppConfig): void {
  ensureConfigDir();
  const content = JSON.stringify(config, null, 2);
  fs.writeFileSync(getConfigPath(), content, 'utf-8');
}

/** Read animations.json */
export function readAnimationMeta(): AnimationMeta {
  const metaPath = getAnimationMetaPath();

  if (!fs.existsSync(metaPath)) {
    return { folderPath: '', entries: [] };
  }

  try {
    const content = fs.readFileSync(metaPath, 'utf-8');
    return JSON.parse(content) as AnimationMeta;
  } catch (e) {
    console.warn(`[FileManager] animations.json parse error: ${e}`);
    return { folderPath: '', entries: [] };
  }
}

/** Write animations.json */
export function writeAnimationMeta(meta: AnimationMeta): void {
  ensureConfigDir();
  const content = JSON.stringify(meta, null, 2);
  fs.writeFileSync(getAnimationMetaPath(), content, 'utf-8');
}

/** Scan .vrma files in specified folder */
export function scanVrmaFiles(folderPath: string): string[] {
  if (!fs.existsSync(folderPath) || !fs.statSync(folderPath).isDirectory()) {
    throw new Error(`Animation folder does not exist: ${folderPath}`);
  }

  const entries = fs.readdirSync(folderPath);
  const files = entries
    .filter((f) => f.toLowerCase().endsWith('.vrma'))
    .sort();

  return files;
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
export function scanAnimations(folderPath: string): AnimationMeta {
  const scannedFiles = scanVrmaFiles(folderPath);
  const existing = readAnimationMeta();
  const synced = syncAnimationMeta(folderPath, existing, scannedFiles);
  writeAnimationMeta(synced);
  return synced;
}
