/**
 * 影片動作轉換器 — 離線 Gaussian Quaternion Smoother
 *
 * Stage 2 批次後處理用，對每幀以 ±halfWindow 為範圍計算
 * quaternion-safe 高斯加權平均（透過累積 slerp）。
 *
 * **重點**：禁止對 xyzw 分量直接加權平均（會破壞單位長度且無視最短
 * 路徑）。改用「累積平均往新樣本拉」的等效 slerp 實作（plan 第 5.5 節）。
 *
 * 對應計畫：video-converter-plan.md 第 2.6 / 5.5 節
 */

import type { Quat } from '../math/Quat';
import {
  quatNormalize,
  quatSlerp,
  quatEnsureShortestPath,
} from '../math/Quat';
import { gaussianWeight } from '../math/helpers';

export interface GaussianQuatOptions {
  /** 視窗半寬（樣本數），完整視窗大小 = 2*halfWindow + 1 */
  halfWindow: number;
  /** 高斯標準差（樣本數）*/
  sigma: number;
}

export const DEFAULT_GAUSSIAN_QUAT_OPTIONS: GaussianQuatOptions = {
  halfWindow: 3,
  sigma: 1.5,
};

export class GaussianQuatSmoother {
  private opts: GaussianQuatOptions;
  /** 預先計算的權重表 [0, halfWindow]（中心點 + 兩側） */
  private weights: number[] = [];

  constructor(opts: Partial<GaussianQuatOptions> = {}) {
    this.opts = { ...DEFAULT_GAUSSIAN_QUAT_OPTIONS, ...opts };
    this.recomputeWeights();
  }

  setOptions(opts: Partial<GaussianQuatOptions>): void {
    this.opts = { ...this.opts, ...opts };
    this.recomputeWeights();
  }

  getOptions(): GaussianQuatOptions {
    return { ...this.opts };
  }

  private recomputeWeights(): void {
    const { halfWindow, sigma } = this.opts;
    this.weights = [];
    for (let k = 0; k <= halfWindow; k++) {
      this.weights.push(gaussianWeight(k, sigma));
    }
  }

  /**
   * 對整條 quaternion track 做高斯平滑。
   *
   * 演算法（plan 第 5.5 節）：
   *   FOR i in [0..N):
   *     center = track[i]
   *     acc    = center
   *     accW   = weights[0]
   *     FOR k in [1..H]:
   *       leftQ  = ensureShortestPath(center, track[max(0, i-k)])
   *       rightQ = ensureShortestPath(center, track[min(N-1, i+k)])
   *       w = weights[k]
   *       accW += w; acc = slerp(acc, leftQ,  w / accW)
   *       accW += w; acc = slerp(acc, rightQ, w / accW)
   *     smoothed[i] = normalize(acc)
   */
  smoothTrack(track: readonly Quat[]): Quat[] {
    const n = track.length;
    if (n === 0) return [];
    const { halfWindow } = this.opts;
    const out: Quat[] = new Array(n);

    for (let i = 0; i < n; i++) {
      const center = track[i];
      let acc = center;
      let accW = this.weights[0];

      for (let k = 1; k <= halfWindow; k++) {
        const leftIdx = Math.max(0, i - k);
        const rightIdx = Math.min(n - 1, i + k);
        const w = this.weights[k];

        const leftQ = quatEnsureShortestPath(center, track[leftIdx]);
        accW += w;
        acc = quatSlerp(acc, leftQ, w / accW);

        const rightQ = quatEnsureShortestPath(center, track[rightIdx]);
        accW += w;
        acc = quatSlerp(acc, rightQ, w / accW);
      }

      out[i] = quatNormalize(acc);
    }

    return out;
  }
}
