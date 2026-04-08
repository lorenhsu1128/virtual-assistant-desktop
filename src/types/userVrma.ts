/**
 * 使用者動畫（影片動作轉換器輸出）共用型別
 *
 * 對應 electron/fileManager.ts 的 UserVrmaEntry（需保持結構一致，
 * 否則 IPC 傳輸會型別錯位）。
 *
 * 對應計畫：video-converter-plan.md 第 8.2 / 第 7 節 Phase 12
 */

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
