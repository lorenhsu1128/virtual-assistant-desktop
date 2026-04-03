/** 視窗矩形（從 Rust 側取得） */
export interface WindowRect {
  /** 視窗 handle */
  hwnd: number;
  /** 視窗標題 */
  title: string;
  /** 左上角 X 座標 */
  x: number;
  /** 左上角 Y 座標 */
  y: number;
  /** 寬度 */
  width: number;
  /** 高度 */
  height: number;
  /** Z-order（數值越小越上層） */
  zOrder: number;
}

/** 螢幕資訊 */
export interface DisplayInfo {
  /** 螢幕 ID */
  id: number;
  /** 螢幕矩形 */
  x: number;
  y: number;
  width: number;
  height: number;
  /** DPI 縮放比例 */
  scaleFactor: number;
}

/** 矩形（通用） */
export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}
