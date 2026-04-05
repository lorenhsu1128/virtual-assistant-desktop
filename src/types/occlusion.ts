/** 2D 點座標 */
export interface Point {
  x: number;
  y: number;
}

/** 多邊形遮擋區域（IPC 傳輸用） */
export interface OcclusionPolygon {
  points: Point[];
}
