/**
 * MediaPipe Pose Landmarker 執行器
 *
 * 封裝 @mediapipe/tasks-vision 的 PoseLandmarker，提供：
 *   - 非同步載入 WASM + 模型檔（從 CDN）
 *   - GPU delegate 優先，失敗降 CPU
 *   - VIDEO 模式（跨幀狀態保留，穩定性較高）
 *   - detect(video, timestampMs) → PoseLandmarks
 *
 * 模組邊界：
 *   - 不依賴 DOM（除了型別 HTMLVideoElement）
 *   - 不依賴 VRM / Three.js
 *   - 純粹「影片 frame → 33 點關鍵點」的單一職責
 *
 * Phase 5a 用途：手動觸發單張 frame 偵測，用 SkeletonDrawer 畫 overlay。
 * Phase 5b 將擴充為批次處理：迴圈呼叫 detect 得到整個區間的 landmark 軌道，
 *         供 HybrIK IK solver 產生 SMPL θ。
 *
 * 載入策略：
 *   - wasm base：從 MediaPipe 官方 CDN 載入（jsdelivr）
 *   - model：從 Google 官方 CDN 載入 pose_landmarker_lite.task
 *   - 未來 Phase 7 polish 若要離線支援，可改為打包本地檔案
 */

import {
  FilesetResolver,
  PoseLandmarker,
  type PoseLandmarkerResult,
} from '@mediapipe/tasks-vision';

import type { PoseLandmarks } from './types';
import { POSE_LANDMARK_COUNT } from './types';

/** 預設模型 URL（lite 版本，約 5MB，CPU 友善） */
const DEFAULT_MODEL_URL =
  'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task';

/** MediaPipe tasks-vision WASM 與 asset 的 CDN base */
const DEFAULT_WASM_BASE =
  'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.34/wasm';

export interface PoseRunnerOptions {
  /** 覆寫模型 URL（預設為 MediaPipe lite） */
  modelAssetPath?: string;
  /** 覆寫 WASM base URL（預設為 jsdelivr CDN） */
  wasmBase?: string;
  /** 是否優先嘗試 GPU delegate（預設 true，失敗自動降 CPU） */
  preferGpu?: boolean;
}

export class PoseRunner {
  private landmarker: PoseLandmarker | null = null;
  private initialized = false;
  private initPromise: Promise<void> | null = null;
  private disposed = false;

  /** 實際使用的 delegate（init 完成後才有值） */
  private usedDelegate: 'GPU' | 'CPU' | null = null;

  constructor(private readonly options: PoseRunnerOptions = {}) {}

  /**
   * 初始化 MediaPipe（載入 WASM + 模型）
   *
   * 重複呼叫會共用同一個 Promise，不會重複載入。
   */
  async init(): Promise<void> {
    if (this.initialized) return;
    if (this.initPromise) return this.initPromise;

    this.initPromise = this.doInit();
    try {
      await this.initPromise;
    } finally {
      this.initPromise = null;
    }
  }

  private async doInit(): Promise<void> {
    const wasmBase = this.options.wasmBase ?? DEFAULT_WASM_BASE;
    const modelAssetPath = this.options.modelAssetPath ?? DEFAULT_MODEL_URL;
    const preferGpu = this.options.preferGpu ?? true;

    const vision = await FilesetResolver.forVisionTasks(wasmBase);

    // 嘗試 GPU，失敗降 CPU
    if (preferGpu) {
      try {
        this.landmarker = await PoseLandmarker.createFromOptions(vision, {
          baseOptions: {
            modelAssetPath,
            delegate: 'GPU',
          },
          runningMode: 'VIDEO',
          numPoses: 1,
        });
        this.usedDelegate = 'GPU';
      } catch (e) {
        console.warn('[PoseRunner] GPU delegate failed, falling back to CPU:', e);
        this.landmarker = null;
      }
    }

    if (!this.landmarker) {
      this.landmarker = await PoseLandmarker.createFromOptions(vision, {
        baseOptions: {
          modelAssetPath,
          delegate: 'CPU',
        },
        runningMode: 'VIDEO',
        numPoses: 1,
      });
      this.usedDelegate = 'CPU';
    }

    this.initialized = true;
    if (this.disposed) {
      // 若 init 過程中被 dispose，清掉 landmarker
      this.landmarker?.close();
      this.landmarker = null;
    }
  }

  /** 取得實際使用的 delegate，init 前為 null */
  getUsedDelegate(): 'GPU' | 'CPU' | null {
    return this.usedDelegate;
  }

  /**
   * 對單一 frame 執行偵測
   *
   * @param video       HTMLVideoElement，必須已經 seek 到目標時間且 readyState >= 2
   * @param timestampMs MediaPipe VIDEO 模式需要遞增的時間戳（毫秒）
   * @returns           偵測結果（image + world landmarks），無人物時回傳 null
   */
  async detect(
    video: HTMLVideoElement,
    timestampMs: number,
  ): Promise<PoseLandmarks | null> {
    if (!this.initialized || !this.landmarker || this.disposed) return null;
    if (video.readyState < 2) {
      console.warn('[PoseRunner] video not ready, readyState =', video.readyState);
      return null;
    }

    let result: PoseLandmarkerResult;
    try {
      result = this.landmarker.detectForVideo(video, timestampMs);
    } catch (e) {
      console.warn('[PoseRunner] detectForVideo failed:', e);
      return null;
    }

    if (!result.landmarks || result.landmarks.length === 0) {
      return null;
    }

    const imageLm = result.landmarks[0];
    const worldLm = result.worldLandmarks?.[0];
    if (!imageLm || imageLm.length !== POSE_LANDMARK_COUNT) {
      return null;
    }

    return {
      image: imageLm.map((lm) => ({
        x: lm.x,
        y: lm.y,
        z: lm.z,
        visibility: lm.visibility ?? 0,
      })),
      world:
        worldLm?.map((lm) => ({
          x: lm.x,
          y: lm.y,
          z: lm.z,
          visibility: lm.visibility ?? 0,
        })) ?? [],
    };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.landmarker) {
      this.landmarker.close();
      this.landmarker = null;
    }
    this.initialized = false;
  }
}
