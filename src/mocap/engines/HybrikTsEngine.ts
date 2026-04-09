/**
 * HybrIK-TS 動捕引擎（Phase 5d）
 *
 * 把「載入 MediaPipe 模型 + 批次偵測影片區間 + IK 解算 + 組 SmplTrack」整合成
 * 單一可重用的引擎物件，供 MocapStudioApp 呼叫。
 *
 * 流程（solveFromVideo 內部）：
 *   1. 依 startMs / endMs / sampleFps 計算 frame 數與時間戳陣列
 *   2. 對每個時間戳：
 *      a. seekVideoTo → 等 'seeked'
 *      b. poseRunner.detect → PoseLandmarks | null
 *   3. 把 landmarks 陣列餵 buildSmplTrackFromLandmarks → SmplTrack
 *
 * 模組邊界：
 *   - DOM 依賴：HTMLVideoElement（透過 videoFrameSeeker）
 *   - 依賴 MediaPipe（透過 PoseRunner）
 *   - 不依賴 Three.js / VRM / Electron
 *   - 純 renderer-side 模組
 *
 * 未來 Phase 5e（或等 Phase 4 EasyMocap sidecar 到位後）會被包進統一的
 * `MocapEngine` interface，與 EasyMocap engine 並列供 UI 下拉切換。
 * 目前保持具體類別，避免過早抽象。
 *
 * 時間戳策略：
 *   MediaPipe VIDEO 模式要求時間戳嚴格單調遞增。
 *   批次處理時以 `frameIndex * (1000/sampleFps)` 產生，不使用 performance.now()
 *   以避免 scrub 回跳或系統時鐘漂移造成時間戳倒退。
 */

import { PoseRunner } from '../mediapipe/PoseRunner';
import type { PoseLandmarks } from '../mediapipe/types';
import type { SmplTrack } from '../types';
import { buildSmplTrackFromLandmarks, type LandmarksFrame } from '../hybrik/buildSmplTrackFromLandmarks';
import { seekVideoTo } from './videoFrameSeeker';

/** 解算過程中呼叫的進度回報，ratio ∈ [0, 1] */
export type ProgressCallback = (ratio: number) => void;

/** solveFromVideo 選項 */
export interface HybrikTsSolveOptions {
  /** 取樣起點（毫秒，相對於影片） */
  startMs: number;
  /** 取樣終點（毫秒，相對於影片） */
  endMs: number;
  /** 取樣頻率（幀/秒） */
  sampleFps: number;
  /** 進度回報（每幀最多呼叫一次） */
  onProgress?: ProgressCallback;
  /** 取消訊號 */
  signal?: AbortSignal;
}

/** 最短的批次長度保護（避免 sampleFps 為 0） */
const MIN_SAMPLE_FPS = 1;
/** 進度節流：每 N 幀才呼叫一次 onProgress */
const PROGRESS_EVERY_N_FRAMES = 3;

export class HybrikTsEngine {
  readonly id = 'hybrik-ts' as const;
  readonly name = 'HybrIK-TS (browser)';
  readonly requiresSidecar = false;

  private poseRunner: PoseRunner | null = null;
  private initialized = false;
  private disposed = false;

  /** 懶初始化 MediaPipe（首次呼叫可能很慢） */
  async init(): Promise<void> {
    if (this.disposed) throw new Error('[HybrikTsEngine] disposed');
    if (this.initialized) return;
    if (!this.poseRunner) {
      this.poseRunner = new PoseRunner();
    }
    await this.poseRunner.init();
    this.initialized = true;
  }

  /** 實際使用的 MediaPipe delegate（'GPU' | 'CPU' | null） */
  getUsedDelegate(): 'GPU' | 'CPU' | null {
    return this.poseRunner?.getUsedDelegate() ?? null;
  }

  /**
   * 對影片的 [startMs, endMs] 區間以 `sampleFps` 取樣 + 執行 HybrIK-TS 解算
   *
   * @returns 含 24 joint axis-angle 與 hips world trans 的 SmplTrack
   * @throws  AbortError 若 signal 被取消
   * @throws  Error 若未先呼叫 init()
   */
  async solveFromVideo(
    video: HTMLVideoElement,
    options: HybrikTsSolveOptions,
  ): Promise<SmplTrack> {
    if (this.disposed) throw new Error('[HybrikTsEngine] disposed');
    if (!this.initialized || !this.poseRunner) {
      throw new Error('[HybrikTsEngine] engine not initialized — call init() first');
    }
    if (video.readyState < 2) {
      throw new Error(`[HybrikTsEngine] video not ready (readyState=${video.readyState})`);
    }

    const sampleFps = Math.max(MIN_SAMPLE_FPS, Math.floor(options.sampleFps));
    const startSec = Math.max(0, options.startMs / 1000);
    const endSec = Math.max(startSec, options.endMs / 1000);
    const durationSec = endSec - startSec;
    const frameCount = Math.max(1, Math.floor(durationSec * sampleFps) + 1);
    const frameInterval = 1 / sampleFps;

    const landmarksFrames: LandmarksFrame[] = new Array(frameCount);

    for (let i = 0; i < frameCount; i++) {
      if (options.signal?.aborted) {
        throw new DOMException('HybrIK solve aborted', 'AbortError');
      }

      const timeSec = Math.min(endSec, startSec + i * frameInterval);
      try {
        await seekVideoTo(video, timeSec);
      } catch (e) {
        console.warn('[HybrikTsEngine] seek failed at', timeSec, e);
        landmarksFrames[i] = null;
        continue;
      }

      // 單調遞增時間戳（相對整條影片）— 乘以 1000 轉毫秒，每幀 +16~33ms
      const monotonicTs = Math.round(timeSec * 1000);
      let lm: PoseLandmarks | null = null;
      try {
        lm = await this.poseRunner.detect(video, monotonicTs);
      } catch (e) {
        console.warn('[HybrikTsEngine] detect failed at', timeSec, e);
        lm = null;
      }
      landmarksFrames[i] = lm;

      if (options.onProgress && (i % PROGRESS_EVERY_N_FRAMES === 0 || i === frameCount - 1)) {
        options.onProgress((i + 1) / frameCount);
      }
    }

    // IK 解算 + 組 SmplTrack（純邏輯，已測）
    return buildSmplTrackFromLandmarks(landmarksFrames, sampleFps);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.poseRunner) {
      this.poseRunner.dispose();
      this.poseRunner = null;
    }
    this.initialized = false;
  }
}
