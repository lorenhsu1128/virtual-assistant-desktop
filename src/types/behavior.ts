import type { Rect, WindowRect } from './window';

/** 行為狀態 */
export type BehaviorState = 'idle' | 'walk' | 'sit' | 'peek' | 'fall' | 'drag';

/**
 * StateMachine.tick() 的輸出
 *
 * 純資料物件，不含任何 Three.js 或 Tauri 依賴。
 * 由 SceneManager 消費：套用位置、由 BehaviorAnimationBridge 觸發動畫。
 */
export interface BehaviorOutput {
  /** 當前狀態 */
  currentState: BehaviorState;
  /** 上一個狀態 */
  previousState: BehaviorState;
  /** 狀態是否在這一幀發生變化 */
  stateChanged: boolean;
  /** 目標螢幕位置（px），null 表示不移動 */
  targetPosition: { x: number; y: number } | null;
  /** 面朝方向：-1 = 左，1 = 右 */
  facingDirection: number;
  /** 吸附的視窗 handle（sit 狀態時） */
  attachedWindowHwnd: number | null;
  /** 正在穿越的視窗 handle（walk traverse 時） */
  traversingWindowHwnd: number | null;
  /** peek 狀態時躲在哪個視窗後面（hwnd），螢幕邊緣 peek 時為 null */
  peekTargetHwnd: number | null;
  /** peek 時角色身體在邊緣的哪一側（'left'=身體在左, 'right'=身體在右） */
  peekSide: 'left' | 'right' | null;
}

/**
 * 3D 環境中的可站立平面
 *
 * 角色可以走到平面位置並坐下。純資料，不依賴 Three.js。
 */
export interface Platform {
  /** 平面 ID */
  id: string;
  /** 平面的螢幕 Y 座標（觸發判定位置，角色腳底碰到此 Y 即觸發 sit） */
  screenY: number;
  /** 平面的螢幕 X 範圍（左） */
  screenXMin: number;
  /** 平面的螢幕 X 範圍（右） */
  screenXMax: number;
  /** 坐下目標 Y 座標（角色腳底應對齊的位置）。未設定時使用 screenY */
  sitTargetY?: number;
}

/**
 * StateMachine.tick() 的輸入
 *
 * 由 SceneManager 在每幀組裝並注入。
 */
export interface BehaviorInput {
  /** 當前角色位置（px，螢幕座標） */
  currentPosition: { x: number; y: number };
  /** 角色的 bounding box */
  characterBounds: Rect;
  /** 螢幕邊界 */
  screenBounds: Rect;
  /** 當前可見的視窗清單 */
  windowRects: WindowRect[];
  /** 可站立的平面清單 */
  platforms: Platform[];
  /** 角色縮放比例 */
  scale: number;
  /** 幀間隔時間（秒） */
  deltaTime: number;
  /** 臀部螢幕 Y 座標（hips 骨骼），用於平面接觸判定 */
  hipScreenY?: number;
}

/**
 * StateMachine 的行為參數
 *
 * v0.2 使用預設值，未來可開放使用者調整。
 */
export interface BehaviorConfig {
  /** 移動速度（px/s，以 scale=1 為基準） */
  moveSpeed: number;
  /** idle 停留時間範圍（秒） */
  idleDurationMin: number;
  idleDurationMax: number;
  /** sit 停留時間範圍（秒） */
  sitDurationMin: number;
  sitDurationMax: number;
  /** peek 停留時間範圍（秒） */
  peekDurationMin: number;
  peekDurationMax: number;
  /** 狀態轉移機率 */
  transitionProbabilities: {
    toWalk: number;
    toSit: number;
    toPeek: number;
    toIdle: number;
  };
}

/** 預設行為參數 */
export const DEFAULT_BEHAVIOR_CONFIG: BehaviorConfig = {
  moveSpeed: 60,
  idleDurationMin: 5,
  idleDurationMax: 20,
  sitDurationMin: 10,
  sitDurationMax: 30,
  peekDurationMin: 3,
  peekDurationMax: 8,
  transitionProbabilities: {
    toWalk: 0.6,
    toSit: 0.2,
    toPeek: 0.1,
    toIdle: 0.1,
  },
};
