import type { Point } from '../types/occlusion';
import type { Rect } from '../types/window';

/**
 * Sutherland-Hodgman 多邊形裁切
 *
 * 計算多邊形與矩形的交集。純數學運算，無外部依賴。
 * 用於將角色輪廓裁切到穿越視窗的重疊區域。
 *
 * @param polygon - 輸入多邊形頂點
 * @param clipRect - 裁切矩形（canvas CSS 像素座標）
 * @returns 裁切後的多邊形頂點，或空陣列（無交集）
 */
export function clipPolygonToRect(polygon: Point[], clipRect: Rect): Point[] {
  if (polygon.length < 3) return [];

  let output = polygon.slice();

  // 依序對矩形的四條邊裁切
  const edges: Array<(p: Point) => { inside: boolean; intersect: (a: Point, b: Point) => Point }> = [
    // 左邊：x >= clipRect.x
    (p) => ({
      inside: p.x >= clipRect.x,
      intersect: (a, b) => {
        const t = (clipRect.x - a.x) / (b.x - a.x);
        return { x: clipRect.x, y: a.y + t * (b.y - a.y) };
      },
    }),
    // 右邊：x <= clipRect.x + clipRect.width
    (p) => ({
      inside: p.x <= clipRect.x + clipRect.width,
      intersect: (a, b) => {
        const t = (clipRect.x + clipRect.width - a.x) / (b.x - a.x);
        return { x: clipRect.x + clipRect.width, y: a.y + t * (b.y - a.y) };
      },
    }),
    // 上邊：y >= clipRect.y
    (p) => ({
      inside: p.y >= clipRect.y,
      intersect: (a, b) => {
        const t = (clipRect.y - a.y) / (b.y - a.y);
        return { x: a.x + t * (b.x - a.x), y: clipRect.y };
      },
    }),
    // 下邊：y <= clipRect.y + clipRect.height
    (p) => ({
      inside: p.y <= clipRect.y + clipRect.height,
      intersect: (a, b) => {
        const t = (clipRect.y + clipRect.height - a.y) / (b.y - a.y);
        return { x: a.x + t * (b.x - a.x), y: clipRect.y + clipRect.height };
      },
    }),
  ];

  for (const edgeFn of edges) {
    if (output.length === 0) break;

    const input = output;
    output = [];

    for (let i = 0; i < input.length; i++) {
      const current = input[i];
      const next = input[(i + 1) % input.length];

      const currentEdge = edgeFn(current);
      const nextEdge = edgeFn(next);

      if (currentEdge.inside) {
        output.push(current);
        if (!nextEdge.inside) {
          output.push(currentEdge.intersect(current, next));
        }
      } else if (nextEdge.inside) {
        output.push(currentEdge.intersect(current, next));
      }
    }
  }

  return output;
}
