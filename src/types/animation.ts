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

// ═══════════════════════════════════════════════════════════════
// 系統動畫（assets/system/vrma/）— 狀態→池 統一規範
// ═══════════════════════════════════════════════════════════════

/**
 * 系統動畫對應的行為狀態
 *
 * 每個狀態對應一個檔案前綴，檔名規範為 `SYS_{PREFIX}_NN.vrma`。
 * 詳見 `/animation-guide.md`。
 */
export type SystemAnimationState =
  | 'idle'
  | 'sit'
  | 'walk'
  | 'drag'
  | 'peek'
  | 'fall'
  | 'hide'
  | 'typing';

/**
 * 狀態 → 檔案前綴對照表
 *
 * 檔名規範：`SYS_{PREFIX}_NN.vrma`
 * 例如 `idle` → `SYS_IDLE_01.vrma`、`drag` → `SYS_DRAGGING_01.vrma`。
 */
export const SYSTEM_STATE_FILE_PREFIX: Record<SystemAnimationState, string> = {
  idle: 'IDLE',
  sit: 'SIT',
  walk: 'WALK',
  drag: 'DRAGGING',
  peek: 'PEEK',
  fall: 'FALL',
  hide: 'HIDE',
  typing: 'TYPING',
};

/** 所有系統動畫狀態列表（供迴圈遍歷） */
export const SYSTEM_ANIMATION_STATES: readonly SystemAnimationState[] = [
  'idle',
  'sit',
  'walk',
  'drag',
  'peek',
  'fall',
  'hide',
  'typing',
] as const;

/** 單一系統動畫池的每支 clip */
export interface SystemStatePoolEntry {
  /** 檔案名稱（不含路徑） */
  fileName: string;
  /** 解析後的 Three.js AnimationClip（型別放在實作端避免前端型別依賴） */
  clip: unknown;
}

/**
 * 每個狀態的播放策略
 *
 * 進入該狀態時，`playStateRandom` 會依此設定套用 loop / clamp / fade。
 */
export interface SystemStatePlayConfig {
  /** 是否循環播放（true = LoopRepeat, false = LoopOnce） */
  loop: boolean;
  /** crossfade 過渡時長（秒） */
  fadeDuration: number;
  /** `loop=false` 時是否 clamp 在結尾姿勢（避免 T-pose） */
  clampWhenFinished: boolean;
}

/**
 * 各狀態的預設播放策略
 *
 * - idle：LoopOnce + clamp，由 AnimationManager 監聽 `finished` 事件接力下一支
 * - walk / drag / sit / hide：LoopRepeat，退出狀態時由 Bridge 切換
 * - peek / fall：LoopOnce + clamp，由狀態機 timeout 切換
 */
export const SYSTEM_STATE_PLAY_CONFIG: Record<SystemAnimationState, SystemStatePlayConfig> = {
  idle: { loop: false, fadeDuration: 0.7, clampWhenFinished: true },
  sit: { loop: true, fadeDuration: 1.5, clampWhenFinished: false },
  walk: { loop: true, fadeDuration: 0.3, clampWhenFinished: false },
  drag: { loop: true, fadeDuration: 0.3, clampWhenFinished: false },
  peek: { loop: false, fadeDuration: 0.5, clampWhenFinished: true },
  fall: { loop: false, fadeDuration: 0.3, clampWhenFinished: true },
  hide: { loop: true, fadeDuration: 0.3, clampWhenFinished: false },
  typing: { loop: true, fadeDuration: 0.5, clampWhenFinished: false },
};
