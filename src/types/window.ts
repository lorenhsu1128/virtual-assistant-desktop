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
  /** 是否為前景視窗（滑鼠焦點） */
  isForeground?: boolean;
  /** 是否為最大化視窗 */
  isMaximized?: boolean;
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
  /** 工作區域（扣除工作列） */
  workArea?: { x: number; y: number; width: number; height: number };
}

/** 矩形（通用） */
export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** 視窗裁切區域（傳送至 Rust 端 SetWindowRgn） */
export interface OcclusionRegion {
  /** 要從桌寵視窗中排除的矩形（視窗本地座標） */
  excludeRects: Rect[];
}
