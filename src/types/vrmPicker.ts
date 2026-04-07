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

/** 換裝 / 脫衣等啟發式判定的三態結果 */
export type FeatureSupport = 'yes' | 'no' | 'maybe';

/** VRM 規格版本 */
export type VrmSpecVersion = '0.x' | '1.0' | 'unknown';

/**
 * VRM 模型資訊（picker 預覽 overlay 顯示用）
 *
 * 由 analyzeVrmModel() 從 vrm.meta + mesh 名稱清單 + expression 清單組裝。
 * 換裝 / 脫衣判定為啟發式，僅供參考；no 代表「授權禁止」或「結構上不可能」。
 */
export interface ModelInfo {
  /** 模型名稱（VRM1: meta.name / VRM0: meta.title），可能為空字串 */
  name: string;
  /** VRM 規格版本 */
  vrmVersion: VrmSpecVersion;
  /** 是否可換裝（依 mesh 命名啟發式判斷 + 授權旗標） */
  canChangeClothes: FeatureSupport;
  /** 是否可脫衣（換裝判定 + 授權更嚴格的檢查） */
  canUndress: FeatureSupport;
  /** 模型支援的所有 BlendShape / Expression 名稱 */
  expressions: string[];
}
