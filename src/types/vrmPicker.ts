/**
 * VRM 模型瀏覽對話框相關型別
 */

/** 對話框中的單一 VRM 檔案項目 */
export interface VrmFileEntry {
  /** 檔案絕對路徑 */
  fullPath: string;
  /** 檔名（含副檔名） */
  fileName: string;
  /** 顯示名稱（去掉副檔名） */
  displayName: string;
}
