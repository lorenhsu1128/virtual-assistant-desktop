/**
 * 影片動作轉換器 — 通用數學 helper（純函式，零依賴）
 *
 * 對應計畫：video-converter-plan.md 第 2.4 節 / 第 7 節 Phase 2
 */

/** 把 v 限制在 [lo, hi] 之間 */
export function clamp(v: number, lo: number, hi: number): number {
  if (v < lo) return lo;
  if (v > hi) return hi;
  return v;
}

/** 線性內插 a → b，t 在 [0,1] 之外不會自動 clamp */
export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** 將 v 從 [fromLo, fromHi] 線性映射到 [toLo, toHi] */
export function remap(
  v: number,
  fromLo: number,
  fromHi: number,
  toLo: number,
  toHi: number
): number {
  if (fromHi === fromLo) return toLo;
  const t = (v - fromLo) / (fromHi - fromLo);
  return toLo + (toHi - toLo) * t;
}

export const DEG2RAD = Math.PI / 180;
export const RAD2DEG = 180 / Math.PI;

export function degToRad(deg: number): number {
  return deg * DEG2RAD;
}

export function radToDeg(rad: number): number {
  return rad * RAD2DEG;
}

/**
 * 標準（未正規化）高斯權重：exp(-d² / (2σ²))
 *
 * 用於 GaussianQuatSmoother 的離線平滑（Phase 5）。
 * 需要正規化的場合請呼叫端自己除以總和。
 */
export function gaussianWeight(distance: number, sigma: number): number {
  if (sigma <= 0) return distance === 0 ? 1 : 0;
  const s2 = sigma * sigma;
  return Math.exp(-(distance * distance) / (2 * s2));
}
