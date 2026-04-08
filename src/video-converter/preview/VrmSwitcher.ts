/**
 * 影片動作轉換器 — VrmSwitcher
 *
 * 簡單的 VRM 切換器：透過既有 IPC pickVrmFile 開原生對話框，由
 * 呼叫端 callback 拿到使用者選擇的路徑後自行 loadVrm。
 *
 * **設計取捨**：vrm-picker 已有完整的 VRM 瀏覽 + 預覽 UI。本檔不重複
 * 實作，只負責「給一個 path」這件最小職責。Phase 9 用途是讓使用者在
 * 影片動作轉換器內快速換 VRM 看效果，不需要完整的瀏覽流程。
 *
 * 對應計畫：video-converter-plan.md 第 2.9 節 / Phase 9
 */

import { ipc } from '../../bridge/ElectronIPC';

export type VrmSelectCallback = (vrmPath: string) => void | Promise<void>;

export class VrmSwitcher {
  private busy = false;

  /**
   * 開啟原生 VRM 檔案選擇對話框。
   *
   * 重複呼叫期間（busy）會被忽略，避免多個對話框疊加。
   *
   * @returns 使用者選擇的 path（cancel 為 null）
   */
  async pick(): Promise<string | null> {
    if (this.busy) return null;
    this.busy = true;
    try {
      return await ipc.pickVrmFile();
    } finally {
      this.busy = false;
    }
  }

  /**
   * 開啟對話框並在使用者選擇後呼叫 callback。封裝 try/catch，cancel
   * 不會 throw。
   */
  async pickAndApply(onSelect: VrmSelectCallback): Promise<void> {
    const path = await this.pick();
    if (!path) return;
    try {
      await onSelect(path);
    } catch (err) {
      console.error('[VrmSwitcher] onSelect 失敗:', err);
      throw err;
    }
  }
}
