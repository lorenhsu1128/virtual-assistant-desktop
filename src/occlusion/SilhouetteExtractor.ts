import type * as THREE from 'three';
import type { Point } from '../types/occlusion';

/**
 * Marching Squares 輪廓追蹤
 *
 * 從二值化 alpha mask 中追蹤邊界輪廓。
 * 回傳以像素座標表示的封閉多邊形頂點陣列。
 *
 * @param mask - 二值化 alpha mask（1 = 不透明，0 = 透明）
 * @param width - mask 寬度
 * @param height - mask 高度
 * @returns 輪廓頂點陣列，或 null（無輪廓）
 */
export function marchingSquares(mask: Uint8Array, width: number, height: number): Point[] | null {
  // 找起點：第一個從 0→1 的邊界 cell
  let startX = -1;
  let startY = -1;

  outer:
  for (let y = 0; y < height - 1; y++) {
    for (let x = 0; x < width - 1; x++) {
      const idx = y * width + x;
      // cell 的四個角：TL, TR, BL, BR
      const tl = mask[idx];
      const tr = mask[idx + 1];
      const bl = mask[idx + width];
      const br = mask[idx + width + 1];
      const cellType = (tl << 3) | (tr << 2) | (br << 1) | bl;
      // 有邊界的 cell（不是全 0 也不是全 1）
      if (cellType > 0 && cellType < 15) {
        startX = x;
        startY = y;
        break outer;
      }
    }
  }

  if (startX === -1) return null;

  const points: Point[] = [];
  let cx = startX;
  let cy = startY;
  // 方向：0=右, 1=下, 2=左, 3=上
  let prevDir = -1;
  const maxSteps = width * height; // 防止無限迴圈
  let steps = 0;

  do {
    if (steps++ > maxSteps) break;

    const idx = cy * width + cx;
    const tl = cx >= 0 && cy >= 0 && cx < width && cy < height ? mask[idx] : 0;
    const tr = cx + 1 < width && cy >= 0 && cy < height ? mask[idx + 1] : 0;
    const bl = cx >= 0 && cy + 1 < height ? mask[idx + width] : 0;
    const br = cx + 1 < width && cy + 1 < height ? mask[idx + width + 1] : 0;

    const cellType = (tl << 3) | (tr << 2) | (br << 1) | bl;

    // 邊界中點座標
    const px = cx + 0.5;
    const py = cy + 0.5;

    // 決定方向（Marching Squares lookup table）
    let dir: number;
    switch (cellType) {
      case 1:  dir = 2; break; // ╗
      case 2:  dir = 1; break; // ╔
      case 3:  dir = 2; break; // ═╗
      case 4:  dir = 0; break; // ╝
      case 5:  dir = 3; break; // ║ saddle: use prev direction
      case 6:  dir = 1; break; // ╚═
      case 7:  dir = 2; break; // ══╗
      case 8:  dir = 3; break; // ╚
      case 9:  dir = 3; break; // ║
      case 10: dir = 0; break; // saddle: use prev direction
      case 11: dir = 3; break; // ══╝ → up
      case 12: dir = 0; break; // ╚═
      case 13: dir = 0; break; // ═══
      case 14: dir = 1; break; // ╔══
      default: dir = 0; break;
    }

    // 鞍點消歧（saddle cells: 5 and 10）
    if (cellType === 5) {
      dir = prevDir === 0 ? 3 : (prevDir === 2 ? 1 : 3);
    } else if (cellType === 10) {
      dir = prevDir === 1 ? 0 : (prevDir === 3 ? 2 : 0);
    }

    points.push({ x: px, y: py });
    prevDir = dir;

    // 依方向移動
    switch (dir) {
      case 0: cx++; break; // 右
      case 1: cy++; break; // 下
      case 2: cx--; break; // 左
      case 3: cy--; break; // 上
    }
  } while (cx !== startX || cy !== startY);

  // 閉合多邊形
  if (points.length > 0) {
    points.push({ ...points[0] });
  }

  return points.length >= 3 ? points : null;
}

/**
 * Douglas-Peucker 多邊形簡化
 *
 * 減少多邊形頂點數量，保留輪廓形狀特徵。
 *
 * @param points - 輸入多邊形頂點
 * @param tolerance - 簡化容差（像素），越大頂點越少
 * @returns 簡化後的頂點陣列
 */
export function douglasPeucker(points: Point[], tolerance: number): Point[] {
  if (points.length <= 2) return points;

  // 找到離起點-終點連線最遠的點
  let maxDist = 0;
  let maxIdx = 0;
  const start = points[0];
  const end = points[points.length - 1];

  for (let i = 1; i < points.length - 1; i++) {
    const d = perpendicularDistance(points[i], start, end);
    if (d > maxDist) {
      maxDist = d;
      maxIdx = i;
    }
  }

  if (maxDist > tolerance) {
    const left = douglasPeucker(points.slice(0, maxIdx + 1), tolerance);
    const right = douglasPeucker(points.slice(maxIdx), tolerance);
    return left.slice(0, -1).concat(right);
  }

  return [start, end];
}

/** 點到線段的垂直距離 */
function perpendicularDistance(point: Point, lineStart: Point, lineEnd: Point): number {
  const dx = lineEnd.x - lineStart.x;
  const dy = lineEnd.y - lineStart.y;
  const lenSq = dx * dx + dy * dy;

  if (lenSq === 0) {
    const ex = point.x - lineStart.x;
    const ey = point.y - lineStart.y;
    return Math.sqrt(ex * ex + ey * ey);
  }

  return Math.abs(dy * point.x - dx * point.y + lineEnd.x * lineStart.y - lineEnd.y * lineStart.x) / Math.sqrt(lenSq);
}

/**
 * 角色 2D 輪廓提取器
 *
 * 從 WebGL renderer 讀取 alpha channel，用 Marching Squares 追蹤輪廓，
 * 用 Douglas-Peucker 簡化頂點。輸出 canvas CSS 像素座標。
 *
 * 設計原則：
 * - 預分配 buffer 避免 GC
 * - 失敗時回傳 null（由呼叫端 fallback 到矩形遮擋）
 */
export class SilhouetteExtractor {
  private gl: WebGLRenderingContext | null = null;
  private pixelBuffer: Uint8Array | null = null;
  private maskBuffer: Uint8Array | null = null;
  private lastPixelW = 0;
  private lastPixelH = 0;
  private lastMaskW = 0;
  private lastMaskH = 0;

  constructor(renderer: THREE.WebGLRenderer) {
    try {
      this.gl = renderer.getContext() as WebGLRenderingContext;
    } catch (e) {
      console.warn('[SilhouetteExtractor] Failed to get WebGL context:', e);
    }
  }

  /**
   * 提取角色輪廓
   *
   * 必須在 renderer.render() 之後呼叫。
   *
   * @param alphaThreshold - alpha 二值化閾值（0-255），預設 128
   * @param simplifyTolerance - Douglas-Peucker 容差（像素），預設 2.0
   * @param maxPoints - 最大頂點數，預設 200
   * @param sampleStride - 降採樣間隔（像素），預設 4。mask 尺寸縮為 1/stride²
   * @returns 輪廓頂點陣列（canvas CSS 像素座標），或 null
   */
  extract(alphaThreshold = 128, simplifyTolerance = 2.0, maxPoints = 200, sampleStride = 4): Point[] | null {
    if (!this.gl) return null;

    const gl = this.gl;
    const width = gl.drawingBufferWidth;
    const height = gl.drawingBufferHeight;

    if (width <= 0 || height <= 0) return null;

    const stride = Math.max(1, Math.round(sampleStride));
    const maskW = Math.ceil(width / stride);
    const maskH = Math.ceil(height / stride);

    // 重新分配 pixel buffer（全解析度，尺寸變化時）
    if (width !== this.lastPixelW || height !== this.lastPixelH) {
      this.pixelBuffer = new Uint8Array(width * height * 4);
      this.lastPixelW = width;
      this.lastPixelH = height;
    }

    // 重新分配 mask buffer（降採樣尺寸，變化時）
    if (maskW !== this.lastMaskW || maskH !== this.lastMaskH) {
      this.maskBuffer = new Uint8Array(maskW * maskH);
      this.lastMaskW = maskW;
      this.lastMaskH = maskH;
    }

    try {
      gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, this.pixelBuffer!);
    } catch (e) {
      console.warn('[SilhouetteExtractor] readPixels failed:', e);
      return null;
    }

    // 降採樣二值化（WebGL Y 軸翻轉 + stride 取樣）
    const pixels = this.pixelBuffer!;
    const mask = this.maskBuffer!;

    for (let my = 0; my < maskH; my++) {
      // mask row my → 原始 canvas row (srcY)，WebGL Y 翻轉
      const canvasY = my * stride;
      const srcY = height - 1 - canvasY;
      if (srcY < 0) continue;
      const srcRowStart = srcY * width * 4;
      const dstRowStart = my * maskW;

      for (let mx = 0; mx < maskW; mx++) {
        const srcX = mx * stride;
        if (srcX >= width) continue;
        const alpha = pixels[srcRowStart + srcX * 4 + 3];
        mask[dstRowStart + mx] = alpha >= alphaThreshold ? 1 : 0;
      }
    }

    // Marching Squares 在降採樣 mask 上執行
    let contour = marchingSquares(mask, maskW, maskH);
    if (!contour || contour.length < 3) return null;

    // 座標還原到物理像素
    for (const p of contour) {
      p.x *= stride;
      p.y *= stride;
    }

    // Douglas-Peucker 簡化
    let tolerance = simplifyTolerance * stride;
    contour = douglasPeucker(contour, tolerance);

    while (contour.length > maxPoints && tolerance < 20 * stride) {
      tolerance *= 1.5;
      contour = douglasPeucker(contour, tolerance);
    }

    if (contour.length < 3) return null;

    // 物理像素 → CSS 像素
    const dpr = typeof window !== 'undefined' ? (window.devicePixelRatio || 1) : 1;
    return contour.map(p => ({
      x: p.x / dpr,
      y: p.y / dpr,
    }));
  }

  /** 銷毀 */
  dispose(): void {
    this.gl = null;
    this.pixelBuffer = null;
    this.maskBuffer = null;
  }
}
