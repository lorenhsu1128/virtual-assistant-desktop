/**
 * 影片動作轉換器 — One Euro Filter（即時去抖動）
 *
 * Casiez et al. 2012, "1€ Filter: A Simple Speed-based Low-pass Filter for
 * Noisy Input in Interactive Systems"。
 * 自適應截止頻率的低通濾波：信號變化慢時截止頻率低（強平滑），
 * 變化快時截止頻率高（保留動態）。
 *
 * 對應計畫：video-converter-plan.md 第 2.6 / 8 節 Stage 1 即時 pipeline。
 *
 * Stage 2 不使用 OneEuroFilter（plan 第 12 節：避免 Stage 1 filter state
 * 污染），改用 GaussianQuatSmoother。
 */

import type { Quat } from '../math/Quat';
import {
  quatNormalize,
  quatEnsureShortestPath,
  quatIdentity,
} from '../math/Quat';

export interface OneEuroOptions {
  /** 最小截止頻率（Hz）— 變化慢時的平滑強度，越小越平滑 */
  minCutoff: number;
  /** 速度敏感度 — 越大越保留快速變化 */
  beta: number;
  /** 微分通道的截止頻率（Hz） */
  dCutoff: number;
}

export const DEFAULT_ONE_EURO_OPTIONS: OneEuroOptions = {
  minCutoff: 1.0,
  beta: 0.007,
  dCutoff: 1.0,
};

/** 純函式：給定時間間隔 te（秒）與截止頻率 cutoff（Hz），算 EMA 係數 α */
function smoothingFactor(te: number, cutoff: number): number {
  const r = 2 * Math.PI * cutoff * te;
  return r / (r + 1);
}

function expSmooth(alpha: number, x: number, prev: number): number {
  return alpha * x + (1 - alpha) * prev;
}

/** 純量 OneEuroFilter */
export class OneEuroFilterScalar {
  private opts: OneEuroOptions;
  private xPrev: number | null = null;
  private dxPrev = 0;
  private tPrev = 0;

  constructor(opts: Partial<OneEuroOptions> = {}) {
    this.opts = { ...DEFAULT_ONE_EURO_OPTIONS, ...opts };
  }

  reset(): void {
    this.xPrev = null;
    this.dxPrev = 0;
    this.tPrev = 0;
  }

  setOptions(opts: Partial<OneEuroOptions>): void {
    this.opts = { ...this.opts, ...opts };
  }

  /**
   * @param x 原始輸入值
   * @param timestampMs 當前時間戳（毫秒）
   * @returns 平滑後的值
   */
  filter(x: number, timestampMs: number): number {
    if (this.xPrev === null) {
      this.xPrev = x;
      this.tPrev = timestampMs;
      return x;
    }
    const te = Math.max(1e-6, (timestampMs - this.tPrev) / 1000);

    // 微分通道
    const dx = (x - this.xPrev) / te;
    const aD = smoothingFactor(te, this.opts.dCutoff);
    const dxFiltered = expSmooth(aD, dx, this.dxPrev);

    // 自適應截止頻率
    const cutoff = this.opts.minCutoff + this.opts.beta * Math.abs(dxFiltered);
    const a = smoothingFactor(te, cutoff);
    const xFiltered = expSmooth(a, x, this.xPrev);

    this.xPrev = xFiltered;
    this.dxPrev = dxFiltered;
    this.tPrev = timestampMs;
    return xFiltered;
  }
}

/**
 * Quaternion OneEuroFilter
 *
 * 對 4 個分量分別作純量 OneEuro 濾波，每幀正規化。輸入前會用
 * quatEnsureShortestPath 對齊半球，避免 q 與 -q 跨幀震盪。
 */
export class OneEuroFilterQuat {
  private fx: OneEuroFilterScalar;
  private fy: OneEuroFilterScalar;
  private fz: OneEuroFilterScalar;
  private fw: OneEuroFilterScalar;
  private prev: Quat | null = null;

  constructor(opts: Partial<OneEuroOptions> = {}) {
    this.fx = new OneEuroFilterScalar(opts);
    this.fy = new OneEuroFilterScalar(opts);
    this.fz = new OneEuroFilterScalar(opts);
    this.fw = new OneEuroFilterScalar(opts);
  }

  reset(): void {
    this.fx.reset();
    this.fy.reset();
    this.fz.reset();
    this.fw.reset();
    this.prev = null;
  }

  setOptions(opts: Partial<OneEuroOptions>): void {
    this.fx.setOptions(opts);
    this.fy.setOptions(opts);
    this.fz.setOptions(opts);
    this.fw.setOptions(opts);
  }

  filter(q: Quat, timestampMs: number): Quat {
    const aligned = this.prev ? quatEnsureShortestPath(this.prev, q) : q;
    const filtered: Quat = {
      x: this.fx.filter(aligned.x, timestampMs),
      y: this.fy.filter(aligned.y, timestampMs),
      z: this.fz.filter(aligned.z, timestampMs),
      w: this.fw.filter(aligned.w, timestampMs),
    };
    const normalized = quatNormalize(filtered);
    this.prev = normalized;
    return normalized;
  }
}

/** Helper：建立帶有預設參數的 quat filter */
export function createIdentityQuatFilter(): OneEuroFilterQuat {
  const f = new OneEuroFilterQuat();
  // 初始化為 identity 不是必要的，但呼叫端有需要時可用
  void quatIdentity();
  return f;
}
