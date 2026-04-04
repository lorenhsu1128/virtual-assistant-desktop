import type { Rect, WindowRect } from '../types/window';
import type { CollisionResult, CollisionSides } from '../types/collision';
import { NO_COLLISION } from '../types/collision';

/** 吸附判定閾值（px） */
const SNAP_THRESHOLD = 20;

/** 螢幕邊緣保留比例（至少保留 20% 身體在螢幕內） */
const EDGE_KEEP_RATIO = 0.2;

/**
 * 碰撞判定系統
 *
 * 純資料模組：輸入角色 bounding box + 視窗矩形清單 + 螢幕邊界，
 * 輸出碰撞結果。不依賴 Three.js、Tauri 或任何外部模組。
 */
export class CollisionSystem {
  private windowRects: WindowRect[] = [];
  private screenBounds: Rect = { x: 0, y: 0, width: 1920, height: 1080 };

  /** 更新視窗矩形清單 */
  updateWindowRects(rects: WindowRect[]): void {
    this.windowRects = rects;
  }

  /** 更新螢幕邊界 */
  updateScreenBounds(bounds: Rect): void {
    this.screenBounds = bounds;
  }

  /** 取得當前螢幕邊界 */
  getScreenBounds(): Rect {
    return this.screenBounds;
  }

  /** 取得當前視窗列表 */
  getWindowRects(): WindowRect[] {
    return this.windowRects;
  }

  /**
   * 碰撞檢測
   *
   * 檢查角色與所有視窗及螢幕邊緣的碰撞狀態。
   */
  check(characterBounds: Rect): CollisionResult {
    const result: CollisionResult = {
      ...NO_COLLISION,
      snappableWindows: [],
      occlusionRects: [],
    };

    // 螢幕邊緣檢測
    const edgeSides = this.checkScreenEdge(characterBounds);
    if (edgeSides.left || edgeSides.right || edgeSides.top || edgeSides.bottom) {
      result.atScreenEdge = true;
      result.screenEdgeSides = edgeSides;
    }

    // 視窗碰撞檢測
    for (const windowRect of this.windowRects) {
      const wr: Rect = {
        x: windowRect.x,
        y: windowRect.y,
        width: windowRect.width,
        height: windowRect.height,
      };

      if (this.rectsOverlap(characterBounds, wr)) {
        result.collidingWithWindow = true;
        result.collidedWindowHwnd = windowRect.hwnd;
        result.collidedWindowRect = wr;
        result.collidingSides = this.getCollisionSides(characterBounds, wr);
        break; // 只回報第一個碰撞的視窗
      }
    }

    // 吸附候選檢測
    result.snappableWindows = this.getSnappableWindows(characterBounds, SNAP_THRESHOLD);

    // 遮擋矩形計算
    result.occlusionRects = this.getOcclusionRects(characterBounds);

    // 修正位置計算
    result.correctedPosition = this.getCorrectedPosition(characterBounds);

    return result;
  }

  /**
   * 取得可吸附的視窗
   *
   * 條件：角色底部邊緣與視窗頂部邊緣的距離 ≤ threshold，
   * 且水平方向有重疊。
   */
  getSnappableWindows(characterBounds: Rect, threshold: number): WindowRect[] {
    const charBottom = characterBounds.y + characterBounds.height;

    return this.windowRects.filter((windowRect) => {
      const windowTop = windowRect.y;
      const verticalDistance = Math.abs(charBottom - windowTop);

      if (verticalDistance > threshold) return false;

      // 水平重疊檢查
      const charLeft = characterBounds.x;
      const charRight = characterBounds.x + characterBounds.width;
      const winLeft = windowRect.x;
      const winRight = windowRect.x + windowRect.width;

      return charRight > winLeft && charLeft < winRight;
    });
  }

  /**
   * 計算遮擋矩形
   *
   * 回傳角色被其他視窗遮擋的矩形列表（角色視窗本地座標）。
   */
  getOcclusionRects(characterBounds: Rect): Rect[] {
    const result: Rect[] = [];

    for (const windowRect of this.windowRects) {
      const wr: Rect = {
        x: windowRect.x,
        y: windowRect.y,
        width: windowRect.width,
        height: windowRect.height,
      };

      const intersection = this.getIntersection(characterBounds, wr);
      if (intersection) {
        // 轉換為角色視窗本地座標
        result.push({
          x: intersection.x - characterBounds.x,
          y: intersection.y - characterBounds.y,
          width: intersection.width,
          height: intersection.height,
        });
      }
    }

    return result;
  }

  /**
   * 計算特定視窗的遮擋矩形
   *
   * 只回傳指定 hwnd 視窗與角色重疊的部分（角色視窗本地座標）。
   */
  getOcclusionRectsForWindow(characterBounds: Rect, hwnd: number): Rect[] {
    const result: Rect[] = [];
    for (const windowRect of this.windowRects) {
      if (windowRect.hwnd !== hwnd) continue;
      const wr: Rect = { x: windowRect.x, y: windowRect.y, width: windowRect.width, height: windowRect.height };
      const intersection = this.getIntersection(characterBounds, wr);
      if (intersection) {
        result.push({
          x: intersection.x - characterBounds.x,
          y: intersection.y - characterBounds.y,
          width: intersection.width,
          height: intersection.height,
        });
      }
    }
    return result;
  }

  /**
   * 將位置夾限在螢幕邊界內
   *
   * 保證至少 20% 的角色身體在螢幕內可見。
   */
  clampToScreen(position: { x: number; y: number }, charWidth: number, charHeight: number): { x: number; y: number } {
    const minKeepW = charWidth * EDGE_KEEP_RATIO;
    const minKeepH = charHeight * EDGE_KEEP_RATIO;

    const minX = this.screenBounds.x - charWidth + minKeepW;
    const maxX = this.screenBounds.x + this.screenBounds.width - minKeepW;
    const minY = this.screenBounds.y - charHeight + minKeepH;
    const maxY = this.screenBounds.y + this.screenBounds.height - minKeepH;

    return {
      x: Math.max(minX, Math.min(maxX, position.x)),
      y: Math.max(minY, Math.min(maxY, position.y)),
    };
  }

  /** 螢幕邊緣檢測 */
  private checkScreenEdge(bounds: Rect): CollisionSides {
    const keepW = bounds.width * EDGE_KEEP_RATIO;
    const keepH = bounds.height * EDGE_KEEP_RATIO;

    return {
      left: bounds.x <= this.screenBounds.x - bounds.width + keepW,
      right: bounds.x + bounds.width >= this.screenBounds.x + this.screenBounds.width + bounds.width - keepW,
      top: bounds.y <= this.screenBounds.y - bounds.height + keepH,
      bottom: bounds.y + bounds.height >= this.screenBounds.y + this.screenBounds.height + bounds.height - keepH,
    };
  }

  /** AABB 重疊判定 */
  private rectsOverlap(a: Rect, b: Rect): boolean {
    return (
      a.x < b.x + b.width &&
      a.x + a.width > b.x &&
      a.y < b.y + b.height &&
      a.y + a.height > b.y
    );
  }

  /** 計算碰撞面 */
  private getCollisionSides(character: Rect, window: Rect): CollisionSides {
    const charCenterX = character.x + character.width / 2;
    const charCenterY = character.y + character.height / 2;
    const winCenterX = window.x + window.width / 2;
    const winCenterY = window.y + window.height / 2;

    const dx = charCenterX - winCenterX;
    const dy = charCenterY - winCenterY;

    // 依角色相對於視窗的方向判定碰撞面
    const overlapX = (character.width + window.width) / 2 - Math.abs(dx);
    const overlapY = (character.height + window.height) / 2 - Math.abs(dy);

    if (overlapX < overlapY) {
      return {
        left: dx < 0,
        right: dx > 0,
        top: false,
        bottom: false,
      };
    } else {
      return {
        left: false,
        right: false,
        top: dy < 0,
        bottom: dy > 0,
      };
    }
  }

  /** 計算兩個矩形的交集 */
  private getIntersection(a: Rect, b: Rect): Rect | null {
    const x = Math.max(a.x, b.x);
    const y = Math.max(a.y, b.y);
    const right = Math.min(a.x + a.width, b.x + b.width);
    const bottom = Math.min(a.y + a.height, b.y + b.height);

    if (right > x && bottom > y) {
      return { x, y, width: right - x, height: bottom - y };
    }
    return null;
  }

  /** 計算修正位置（推出碰撞區域） */
  private getCorrectedPosition(characterBounds: Rect): { x: number; y: number } | null {
    // 螢幕邊緣修正
    const clamped = this.clampToScreen(
      { x: characterBounds.x, y: characterBounds.y },
      characterBounds.width,
      characterBounds.height,
    );

    if (clamped.x !== characterBounds.x || clamped.y !== characterBounds.y) {
      return clamped;
    }

    return null;
  }
}
