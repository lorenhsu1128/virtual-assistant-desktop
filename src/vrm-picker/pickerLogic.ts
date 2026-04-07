/**
 * VRM 模型瀏覽對話框 — 純邏輯函式
 *
 * 抽出可單元測試的純函式，與 DOM/Three.js 解耦。
 */

import type { AppConfig } from '../types/config';
import type {
  VrmFileEntry,
  ModelInfo,
  FeatureSupport,
  VrmSpecVersion,
} from '../types/vrmPicker';

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
/**
 * 衣物 mesh 名稱啟發式關鍵字（不分大小寫）
 *
 * 命中其中之一即視為「該 mesh 是衣物」，整體視為「具備換裝結構」。
 */
const CLOTHING_KEYWORDS = [
  'cloth',
  'outfit',
  'dress',
  'shirt',
  'pants',
  'skirt',
  'jacket',
  'coat',
  'tops',
  'bottoms',
  'shoes',
  'sock',
  'glove',
  'hat',
  'cap',
  'uniform',
  'costume',
  'wear',
  'underwear',
  'bra',
  'panty',
  'panties',
];

/** 偵測單一 mesh 名稱是否符合衣物關鍵字 */
function isClothingMeshName(name: string): boolean {
  const lower = name.toLowerCase();
  return CLOTHING_KEYWORDS.some((kw) => lower.includes(kw));
}

/**
 * 從 VRM meta 解析規格版本
 *
 * @pixiv/three-vrm 在 meta 上提供 metaVersion 欄位（'0' 或 '1'）。
 * 容錯：若欄位缺失則回傳 'unknown'。
 */
export function parseVrmVersion(meta: unknown): VrmSpecVersion {
  if (!meta || typeof meta !== 'object') return 'unknown';
  const m = meta as { metaVersion?: string };
  if (m.metaVersion === '1') return '1.0';
  if (m.metaVersion === '0') return '0.x';
  return 'unknown';
}

/**
 * 從 VRM meta 解析模型名稱
 *
 * VRM 1.0: meta.name
 * VRM 0.x: meta.title
 */
export function parseVrmName(meta: unknown): string {
  if (!meta || typeof meta !== 'object') return '';
  const m = meta as { name?: string; title?: string };
  return (m.name ?? m.title ?? '').trim();
}

/**
 * 從 VRM meta 判斷授權是否「明確禁止脫衣」
 *
 * 規則：
 *   - VRM 1.0：modification === 'prohibited' 或 allowExcessivelySexualUsage === false
 *   - VRM 0.x：sexualUssageName === 'Disallow'（注意 spec 拼錯）
 *
 * 注意：VRM 1.0 的 allowExcessivelySexualUsage 預設可能為 false，
 *       這邊只在「明確 false 且 modification 也非 allowModification*」時才當禁止，
 *       避免太多模型被誤判為禁止。實際上 modification 是更可靠的硬性條件。
 */
export function isUndressForbiddenByLicense(meta: unknown): boolean {
  if (!meta || typeof meta !== 'object') return false;
  const m = meta as {
    metaVersion?: string;
    modification?: string;
    allowExcessivelySexualUsage?: boolean;
    sexualUssageName?: string;
  };
  if (m.metaVersion === '1') {
    if (m.modification === 'prohibited') return true;
    if (m.allowExcessivelySexualUsage === false) return true;
    return false;
  }
  if (m.metaVersion === '0') {
    if (m.sexualUssageName === 'Disallow') return true;
    return false;
  }
  return false;
}

/**
 * 從 VRM meta 判斷授權是否「明確禁止修改」
 *
 * VRM 1.0: modification === 'prohibited'
 * VRM 0.x: 無等價欄位，回傳 false（VRM 0.x 沒有 modification 概念）
 */
export function isModificationForbiddenByLicense(meta: unknown): boolean {
  if (!meta || typeof meta !== 'object') return false;
  const m = meta as { metaVersion?: string; modification?: string };
  if (m.metaVersion === '1' && m.modification === 'prohibited') return true;
  return false;
}

/**
 * 分析 VRM 模型，產生 picker overlay 用的 ModelInfo
 *
 * 換裝/脫衣判定為**啟發式**（非 VRM 規格欄位），規則如下：
 *
 * canChangeClothes:
 *   - 'no'    若授權禁止修改
 *   - 'yes'   若至少一個 mesh 命中衣物關鍵字
 *   - 'no'    若 mesh 全無衣物關鍵字（推測無可拆卸結構）
 *
 * canUndress:
 *   - 'no'    若授權禁止脫衣（modification prohibited / sexual disallow）
 *   - 'maybe' 若 canChangeClothes === 'yes'（技術上可隱藏 mesh，但無法保證底層 body 完整）
 *   - 'no'    若無衣物 mesh
 *
 * @param meta VRMController.getMeta() 回傳值
 * @param meshNames VRMController.getMeshNames() 回傳值
 * @param expressions VRMController.getBlendShapes() 回傳值
 */
export function analyzeVrmModel(
  meta: unknown,
  meshNames: string[],
  expressions: string[],
): ModelInfo {
  const vrmVersion = parseVrmVersion(meta);
  const name = parseVrmName(meta);

  const hasClothingMesh = meshNames.some(isClothingMeshName);
  const modificationForbidden = isModificationForbiddenByLicense(meta);
  const undressForbidden = isUndressForbiddenByLicense(meta);

  let canChangeClothes: FeatureSupport;
  if (modificationForbidden) {
    canChangeClothes = 'no';
  } else if (hasClothingMesh) {
    canChangeClothes = 'yes';
  } else {
    canChangeClothes = 'no';
  }

  let canUndress: FeatureSupport;
  if (undressForbidden) {
    canUndress = 'no';
  } else if (hasClothingMesh) {
    canUndress = 'maybe';
  } else {
    canUndress = 'no';
  }

  return {
    name,
    vrmVersion,
    canChangeClothes,
    canUndress,
    expressions: [...expressions],
  };
}

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
