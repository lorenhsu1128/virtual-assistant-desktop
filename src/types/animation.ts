/** 動畫分類 */
export type AnimationCategory = 'idle' | 'action' | 'sit' | 'fall' | 'collide' | 'peek';

/** 動畫條目（對應 animations.json 中的每筆記錄） */
export interface AnimationEntry {
  /** 檔案名稱 */
  fileName: string;
  /** 使用者自訂顯示名稱（預設使用檔名） */
  displayName: string;
  /** 動畫分類 */
  category: AnimationCategory;
  /** 是否循環播放 */
  loop: boolean;
  /** 權重（用於待機隨機播放的機率） */
  weight: number;
}

/** 動畫 metadata 集合（animations.json 結構） */
export interface AnimationMeta {
  /** 動畫資料夾路徑 */
  folderPath: string;
  /** 動畫條目清單 */
  entries: AnimationEntry[];
}

/** 所有動畫分類列表 */
export const ANIMATION_CATEGORIES: readonly AnimationCategory[] = [
  'idle',
  'action',
  'sit',
  'fall',
  'collide',
  'peek',
] as const;
