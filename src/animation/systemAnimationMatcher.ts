import {
  SYSTEM_ANIMATION_STATES,
  SYSTEM_STATE_FILE_PREFIX,
  type SystemAnimationState,
} from '../types/animation';

/**
 * 系統動畫檔名辨識純函式
 *
 * 檔名規範：`SYS_{PREFIX}_NN.vrma`
 *   - PREFIX 來自 SYSTEM_STATE_FILE_PREFIX（如 IDLE / SIT / WALK / DRAGGING / PEEK / FALL / HIDE）
 *   - NN 為一個以上的阿拉伯數字（如 01, 02, ..., 20）
 *   - 大小寫不敏感
 *   - 支援任意路徑分隔符（backslash / forward slash）
 *
 * 純邏輯模組，無外部依賴，便於單元測試。
 */

/** 取出路徑最後一段（檔名），支援 / 與 \ 兩種分隔符 */
export function extractBasename(filePath: string): string {
  const normalized = filePath.replace(/\\/g, '/');
  const lastSlash = normalized.lastIndexOf('/');
  return lastSlash >= 0 ? normalized.substring(lastSlash + 1) : normalized;
}

/**
 * 產生指定狀態的檔名比對 regex
 *
 * 比對整個檔名，必須符合 `^SYS_{PREFIX}_\d+\.vrma$`（大小寫不敏感）。
 *
 * 重要：使用 word boundary 避免 `HIDE` 誤配到 `HIDE_SHOW`。
 *   `SYS_HIDE_01.vrma`  → matchStateFromFilename = 'hide' ✓
 *   `SYS_HIDE_SHOW_01.vrma` → matchStateFromFilename = null（不是合法狀態）
 */
export function createStateMatcher(state: SystemAnimationState): RegExp {
  const prefix = SYSTEM_STATE_FILE_PREFIX[state];
  // 使用 escape 避免 prefix 內含 regex 特殊字元（目前的 prefix 不含，但防禦性）
  const escaped = prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^SYS_${escaped}_\\d+\\.vrma$`, 'i');
}

/**
 * 從檔名反查所屬的系統動畫狀態
 *
 * @param filePath 完整路徑或純檔名皆可
 * @returns 對應的狀態；若檔名不符合任何系統動畫規範則回傳 null
 *
 * 注意：`SYS_HIDE_01.vrma` → 'hide'；`SYS_HIDE_SHOW_01.vrma` → null（非合法狀態）
 */
export function matchStateFromFilename(filePath: string): SystemAnimationState | null {
  const basename = extractBasename(filePath);
  for (const state of SYSTEM_ANIMATION_STATES) {
    if (createStateMatcher(state).test(basename)) {
      return state;
    }
  }
  return null;
}

/**
 * 從檔案清單中過濾出屬於指定狀態的檔案
 *
 * @param filePaths 完整路徑清單（ipc.scanVrmaFiles 的輸出）
 * @param state 要過濾的狀態
 * @returns 符合該狀態的完整路徑清單，維持原順序
 */
export function filterFilesByState(
  filePaths: string[],
  state: SystemAnimationState,
): string[] {
  const matcher = createStateMatcher(state);
  return filePaths.filter((fp) => matcher.test(extractBasename(fp)));
}
