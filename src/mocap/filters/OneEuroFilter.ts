/**
 * One Euro Filter — 四元數版
 *
 * 參考論文：Casiez, Roussel, Vogel. "1€ Filter: A Simple Speed-based Low-pass
 * Filter for Noisy Input in Interactive Systems." (2012)
 *
 * 核心概念：自適應低通濾波器
 *   - 慢速輸入（使用者靜止）→ 強平滑，消除雜訊
 *   - 快速輸入（使用者快速動作）→ 弱平滑，降低延遲
 *
 * 本專案用於平滑 VRM 骨骼旋轉軌道（MediaPipe / MoCap 輸出的雜訊特別明顯）。
 *
 * 為何用 slerp 實作而不對分量直接低通：
 *   四元數的 x/y/z/w 分量**不是獨立的** — 對它們各自做低通會產生
 *   非單位 quat（需要 renormalize），且無法處理 sign-flip（q 與 -q 等價）。
 *   slerp 天然處理 shortest-arc，保持單位性，是處理旋轉序列最穩的選擇。
 */

import * as THREE from 'three';

/**
 * One Euro 低通濾波器的 alpha 係數計算
 *
 * 對應論文中的 `α = 1 / (1 + τ/Δt)`，其中 `τ = 1/(2π·fc)`。
 *
 * @param cutoff 截止頻率（Hz）；越低越平滑
 * @param dtSec  取樣間隔（秒）
 * @returns alpha ∈ [0, 1]；0 完全保留舊值，1 完全採用新值
 */
export function computeAlpha(cutoff: number, dtSec: number): number {
  if (cutoff <= 0 || dtSec <= 0) return 1;
  const tau = 1 / (2 * Math.PI * cutoff);
  return 1 / (1 + tau / dtSec);
}

/**
 * 1D 低通濾波器（One Euro 內部使用，用來平滑「速度」訊號本身）
 */
export class OneEuroScalarFilter {
  private prev: number | null = null;
  private cutoff: number;

  constructor(cutoff: number) {
    this.cutoff = cutoff;
  }

  filter(value: number, dtSec: number): number {
    if (this.prev === null) {
      this.prev = value;
      return value;
    }
    const alpha = computeAlpha(this.cutoff, dtSec);
    this.prev = alpha * value + (1 - alpha) * this.prev;
    return this.prev;
  }

  setCutoff(cutoff: number): void {
    this.cutoff = cutoff;
  }

  reset(): void {
    this.prev = null;
  }
}

export interface OneEuroOptions {
  /** 最小截止頻率（Hz）；越低越平滑。預設 1.0 */
  minCutoff?: number;
  /** 速度響應係數；越大對快速變化越靈敏。預設 0.0（純低通） */
  beta?: number;
  /** 速度訊號自身的低通截止頻率。預設 1.0 */
  dCutoff?: number;
}

/**
 * 四元數 One Euro 濾波器（slerp 實作）
 *
 * 流程：
 *   1. 角速度 = shortest-arc angle 差 / dt
 *   2. 對角速度用 1D 低通濾波（去除雜訊尖峰）
 *   3. 自適應截止頻率 = minCutoff + beta × smoothedSpeed
 *   4. 由自適應 cutoff 計算 alpha，slerp 從 prev 往 input 前進
 *
 * 使用範例：
 * ```ts
 * const filter = new OneEuroQuaternionFilter({ minCutoff: 1.0, beta: 0.5 });
 * for (const frame of mocapFrames) {
 *   for (const [boneName, q] of Object.entries(frame.boneRotations)) {
 *     frame.boneRotations[boneName] = filter.filter(q, 1 / track.fps);
 *   }
 * }
 * ```
 *
 * 注意：每個 bone 應使用獨立的 filter instance（內部維護上一幀狀態）。
 */
export class OneEuroQuaternionFilter {
  private prev: THREE.Quaternion | null = null;
  private readonly speedFilter: OneEuroScalarFilter;
  private readonly minCutoff: number;
  private readonly beta: number;

  constructor(options: OneEuroOptions = {}) {
    this.minCutoff = options.minCutoff ?? 1.0;
    this.beta = options.beta ?? 0.0;
    this.speedFilter = new OneEuroScalarFilter(options.dCutoff ?? 1.0);
  }

  /**
   * 對輸入 quaternion 做平滑
   *
   * @param input  輸入四元數（不會被修改）
   * @param dtSec  與上一幀的時間差（秒）；首次呼叫的 dtSec 會被忽略
   * @returns      平滑後的四元數（新物件，可自由修改）
   */
  filter(input: THREE.Quaternion, dtSec: number): THREE.Quaternion {
    if (this.prev === null || dtSec <= 0) {
      this.prev = input.clone();
      return this.prev.clone();
    }

    // 1. 計算 shortest-arc 角差
    let dot =
      this.prev.x * input.x +
      this.prev.y * input.y +
      this.prev.z * input.z +
      this.prev.w * input.w;
    if (dot < 0) dot = -dot;
    if (dot > 1) dot = 1;
    const angleRad = 2 * Math.acos(dot);
    const rawSpeed = angleRad / dtSec;

    // 2. 低通濾波速度本身
    const smoothedSpeed = this.speedFilter.filter(rawSpeed, dtSec);

    // 3. 自適應截止頻率
    const cutoff = this.minCutoff + this.beta * smoothedSpeed;
    const alpha = computeAlpha(cutoff, dtSec);

    // 4. slerp 從 prev 往 input 前進 alpha
    this.prev.slerp(input, alpha);
    return this.prev.clone();
  }

  /** 重置為初始狀態（下次 filter 會將輸入當作起點） */
  reset(): void {
    this.prev = null;
    this.speedFilter.reset();
  }
}
