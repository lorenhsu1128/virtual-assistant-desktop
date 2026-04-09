/**
 * 影片動捕工作站 — 時間軸純邏輯
 *
 * 不依賴 DOM、Three.js 或任何 I/O。可用 Vitest 單元測試。
 * 被 Timeline.ts（DOM 元件）使用。
 */

/** 拖曳 in/out 把手時兩者之間必須保持的最小間隔（秒） */
export const MIN_IN_OUT_GAP_SEC = 0.1;

/**
 * 將時間（秒）換算為時間軸 track 上的像素位置
 *
 * @param timeSec     時間（秒）
 * @param durationSec 影片總長度（秒）
 * @param trackWidth  時間軸 track 寬度（px）
 * @returns 對應的像素位置（px）；若 durationSec <= 0 則回傳 0
 */
export function timeToPixel(
  timeSec: number,
  durationSec: number,
  trackWidth: number,
): number {
  if (durationSec <= 0) return 0;
  return (timeSec / durationSec) * trackWidth;
}

/**
 * 將像素位置換算為時間（秒），自動 clamp 到 [0, durationSec]
 *
 * @param px          像素位置（相對於 track 左緣）
 * @param durationSec 影片總長度（秒）
 * @param trackWidth  時間軸 track 寬度（px）
 * @returns 對應的時間（秒）；若 trackWidth <= 0 則回傳 0
 */
export function pixelToTime(
  px: number,
  durationSec: number,
  trackWidth: number,
): number {
  if (trackWidth <= 0) return 0;
  return clamp((px / trackWidth) * durationSec, 0, durationSec);
}

/**
 * 對「拖曳 in 把手」的原始時間做 clamp：
 *   - 不可小於 0
 *   - 不可大於 (outSec - minGap)
 *
 * @param newInSec  使用者拖曳計算出的原始 in 時間
 * @param outSec    當前 out 把手位置
 * @param minGap    in/out 最小間隔，預設 MIN_IN_OUT_GAP_SEC
 */
export function clampInTime(
  newInSec: number,
  outSec: number,
  minGap: number = MIN_IN_OUT_GAP_SEC,
): number {
  return clamp(newInSec, 0, Math.max(0, outSec - minGap));
}

/**
 * 對「拖曳 out 把手」的原始時間做 clamp：
 *   - 不可大於 durationSec
 *   - 不可小於 (inSec + minGap)
 *
 * @param newOutSec   使用者拖曳計算出的原始 out 時間
 * @param inSec       當前 in 把手位置
 * @param durationSec 影片總長度
 * @param minGap      in/out 最小間隔，預設 MIN_IN_OUT_GAP_SEC
 */
export function clampOutTime(
  newOutSec: number,
  inSec: number,
  durationSec: number,
  minGap: number = MIN_IN_OUT_GAP_SEC,
): number {
  return clamp(newOutSec, Math.min(durationSec, inSec + minGap), durationSec);
}

/**
 * 將秒數格式化為 `mm:ss.fff`
 *
 * 負數或 NaN 會被視為 0。
 * 超過 60 分鐘會繼續往上（例如 `62:05.001`）。
 */
export function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) seconds = 0;
  const totalMs = Math.floor(seconds * 1000);
  const ms = totalMs % 1000;
  const totalSec = Math.floor(totalMs / 1000);
  const s = totalSec % 60;
  const m = Math.floor(totalSec / 60);
  return `${pad2(m)}:${pad2(s)}.${pad3(ms)}`;
}

function clamp(v: number, lo: number, hi: number): number {
  if (v < lo) return lo;
  if (v > hi) return hi;
  return v;
}

function pad2(n: number): string {
  return n.toString().padStart(2, '0');
}

function pad3(n: number): string {
  return n.toString().padStart(3, '0');
}
