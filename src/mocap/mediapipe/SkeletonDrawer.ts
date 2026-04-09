/**
 * 2D 骨架 overlay 繪製器
 *
 * 在 `CanvasRenderingContext2D` 上繪製 MediaPipe 33 點人體關鍵點與骨架連線。
 * 純函式，不持有狀態。呼叫端負責：
 *   - 提供 canvas 2D context
 *   - 提供 PoseLandmarks（至少 image 必須）
 *   - 提供 canvas 尺寸（因為 landmark 是正規化 0-1 座標）
 *
 * 模組邊界：
 *   - 僅依賴 types.ts（POSE_CONNECTIONS）
 *   - 不依賴 DOM 以外的東西
 */

import type { PoseLandmark, PoseLandmarks } from './types';
import { POSE_CONNECTIONS } from './types';

export interface SkeletonDrawOptions {
  /** 最低可見度閾值，< 此值的點 / 連線會被跳過（預設 0.5） */
  visibilityThreshold?: number;
  /** 骨架連線顏色（預設 #00ff88 螢光綠） */
  lineColor?: string;
  /** 骨架連線寬度（預設 3） */
  lineWidth?: number;
  /** 關鍵點顏色（預設 #ff4444 紅） */
  pointColor?: string;
  /** 關鍵點半徑（預設 4） */
  pointRadius?: number;
}

const DEFAULT_OPTIONS: Required<SkeletonDrawOptions> = {
  visibilityThreshold: 0.5,
  lineColor: '#00ff88',
  lineWidth: 3,
  pointColor: '#ff4444',
  pointRadius: 4,
};

/**
 * 繪製 2D 骨架（連線 + 關鍵點）到 canvas context
 *
 * 呼叫前應先清空 canvas（`ctx.clearRect(...)`）。
 * 函式本身只繪製，不清除、不保存 state。
 *
 * @param ctx          Canvas 2D context
 * @param landmarks    PoseLandmarks（只使用 image 欄位）
 * @param canvasWidth  canvas 寬（像素），用於正規化座標換算
 * @param canvasHeight canvas 高（像素）
 * @param options      可選的樣式覆寫
 */
export function drawSkeleton(
  ctx: CanvasRenderingContext2D,
  landmarks: PoseLandmarks,
  canvasWidth: number,
  canvasHeight: number,
  options?: SkeletonDrawOptions,
): void {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const image = landmarks.image;
  if (!image || image.length === 0) return;

  // 1. 繪製連線
  ctx.strokeStyle = opts.lineColor;
  ctx.lineWidth = opts.lineWidth;
  ctx.lineCap = 'round';
  for (const [aIdx, bIdx] of POSE_CONNECTIONS) {
    const a = image[aIdx];
    const b = image[bIdx];
    if (!a || !b) continue;
    if (a.visibility < opts.visibilityThreshold) continue;
    if (b.visibility < opts.visibilityThreshold) continue;
    ctx.beginPath();
    ctx.moveTo(a.x * canvasWidth, a.y * canvasHeight);
    ctx.lineTo(b.x * canvasWidth, b.y * canvasHeight);
    ctx.stroke();
  }

  // 2. 繪製關鍵點
  ctx.fillStyle = opts.pointColor;
  for (const lm of image) {
    if (!lm) continue;
    if (lm.visibility < opts.visibilityThreshold) continue;
    ctx.beginPath();
    ctx.arc(lm.x * canvasWidth, lm.y * canvasHeight, opts.pointRadius, 0, Math.PI * 2);
    ctx.fill();
  }
}

/** 過濾 landmarks 中可見度不足的點（純函式，測試友善） */
export function filterVisibleLandmarks(
  image: readonly PoseLandmark[],
  threshold = 0.5,
): PoseLandmark[] {
  return image.filter((lm) => lm.visibility >= threshold);
}
