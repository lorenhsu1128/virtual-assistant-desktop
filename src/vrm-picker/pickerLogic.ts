/**
 * VRM 模型瀏覽對話框 — 純邏輯函式
 *
 * 抽出可單元測試的純函式，與 DOM/Three.js 解耦。
 */

import type { AppConfig } from '../types/config';
import type { VrmFileEntry } from '../types/vrmPicker';

/**
 * 推導對話框預設資料夾
 *
 * 優先順序：
 *   1. config.vrmPickerFolder（上次手動選的資料夾）
 *   2. dirname(config.vrmModelPath)（從當前模型路徑推導）
 *   3. null（讓使用者手動選擇）
 */
export function deriveDefaultPickerFolder(config: AppConfig | null): string | null {
  if (!config) return null;
  if (config.vrmPickerFolder && config.vrmPickerFolder.length > 0) {
    return config.vrmPickerFolder;
  }
  if (config.vrmModelPath && config.vrmModelPath.length > 0) {
    return getParentDirectory(config.vrmModelPath);
  }
  return null;
}

/**
 * 取得檔案路徑的父目錄（跨平台，支援 / 與 \）
 */
export function getParentDirectory(filePath: string): string | null {
  const normalized = filePath.replace(/\\/g, '/');
  const lastSlash = normalized.lastIndexOf('/');
  if (lastSlash <= 0) return null;
  return normalized.substring(0, lastSlash);
}

/**
 * 將完整路徑陣列轉為 VrmFileEntry 陣列
 *
 * @param paths 由 ipc.scanVrmFiles 取得的完整路徑陣列
 */
export function buildVrmFileEntries(paths: string[]): VrmFileEntry[] {
  return paths.map((fullPath) => {
    const normalized = fullPath.replace(/\\/g, '/');
    const lastSlash = normalized.lastIndexOf('/');
    const fileName = lastSlash >= 0 ? normalized.substring(lastSlash + 1) : normalized;
    const displayName = stripVrmExtension(fileName);
    return { fullPath, fileName, displayName };
  });
}

/** 去除 .vrm 副檔名 */
export function stripVrmExtension(fileName: string): string {
  return fileName.replace(/\.vrm$/i, '');
}

/**
 * 將數值夾在 [min, max] 範圍內
 */
export function clamp(value: number, min: number, max: number): number {
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

/**
 * 判斷檔案路徑是否為系統內建 idle 動畫（SYS_IDLE_*.vrma）
 *
 * 接受任何作業系統的路徑分隔符與大小寫副檔名。
 */
export function isSysIdleFile(filePath: string): boolean {
  // 取出檔名（最後一段）
  const normalized = filePath.replace(/\\/g, '/');
  const lastSlash = normalized.lastIndexOf('/');
  const fileName = lastSlash >= 0 ? normalized.substring(lastSlash + 1) : normalized;
  return /^SYS_IDLE_.*\.vrma$/i.test(fileName);
}
