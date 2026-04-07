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

/**
 * 計算預覽攝影機 pan 的最大允許範圍（世界座標，公尺）
 *
 * 動態依攝影機距離與 FOV 計算視野邊界，確保 pan 到極限時角色仍有
 * `characterMargin` 公尺寬的部分留在畫面內。
 *
 * 公式：
 *   viewHalfHeight = cameraDistance × tan(fov / 2)
 *   viewHalfWidth  = viewHalfHeight × aspectRatio
 *   maxPanX = max(0.1, viewHalfWidth  - characterMargin)
 *   maxPanY = max(0.2, viewHalfHeight - characterMargin)
 *
 * @param cameraDistance 攝影機到 lookAt target 的距離（m）
 * @param fovRad 垂直 FOV（弧度）
 * @param aspectRatio 視窗寬/高比
 * @param characterMargin 角色保留邊界（m），確保 pan 極限時角色仍有此寬度留在畫面
 * @returns 水平與垂直方向的最大 pan 偏移量（m），均為正值
 */
export function computePanLimits(
  cameraDistance: number,
  fovRad: number,
  aspectRatio: number,
  characterMargin: number,
): { x: number; y: number } {
  const safeDist = Math.max(0, cameraDistance);
  const halfHeight = safeDist * Math.tan(fovRad / 2);
  const halfWidth = halfHeight * Math.max(0, aspectRatio);
  return {
    x: Math.max(0.1, halfWidth - characterMargin),
    y: Math.max(0.2, halfHeight - characterMargin),
  };
}
