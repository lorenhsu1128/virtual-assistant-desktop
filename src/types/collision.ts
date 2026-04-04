import type { Rect, WindowRect } from './window';

/**
 * CollisionSystem.check() 的輸出
 *
 * 純資料物件，描述角色與視窗/螢幕邊緣的碰撞狀態。
 */
export interface CollisionResult {
  /** 是否碰撞到任何視窗 */
  collidingWithWindow: boolean;
  /** 碰撞的視窗 handle（null = 無碰撞） */
  collidedWindowHwnd: number | null;
  /** 碰撞的視窗完整矩形資訊（用於穿越計算） */
  collidedWindowRect: { x: number; y: number; width: number; height: number } | null;
  /** 碰撞面 */
  collidingSides: CollisionSides;
  /** 是否到達螢幕邊緣 */
  atScreenEdge: boolean;
  /** 螢幕邊緣面 */
  screenEdgeSides: CollisionSides;
  /** 頂部邊緣在吸附範圍內的視窗清單 */
  snappableWindows: WindowRect[];
  /** 被其他視窗遮擋的矩形列表（視窗本地座標） */
  occlusionRects: Rect[];
  /** 修正後的位置（解決碰撞穿透），null = 無需修正 */
  correctedPosition: { x: number; y: number } | null;
}

/** 碰撞面旗標 */
export interface CollisionSides {
  left: boolean;
  right: boolean;
  top: boolean;
  bottom: boolean;
}

/** 無碰撞的預設結果 */
export const NO_COLLISION: CollisionResult = {
  collidingWithWindow: false,
  collidedWindowHwnd: null,
  collidedWindowRect: null,
  collidingSides: { left: false, right: false, top: false, bottom: false },
  atScreenEdge: false,
  screenEdgeSides: { left: false, right: false, top: false, bottom: false },
  snappableWindows: [],
  occlusionRects: [],
  correctedPosition: null,
};
