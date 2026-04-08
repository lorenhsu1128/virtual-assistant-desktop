/**
 * 影片動作轉換器 — MediaPipe HolisticLandmarker 包裝
 *
 * 封裝 `@mediapipe/tasks-vision` 的 HolisticLandmarker：
 *   - 從 CDN 載入 WASM + .task 模型
 *   - GPU delegate 失敗自動降級 CPU
 *   - 對單幀影片做 holistic detection
 *   - 把 MediaPipe 原始輸出（pose / hand / face / iris）轉為本專案的
 *     HolisticResult 型別，供 PoseSolver 直接使用
 *
 * 對應計畫：video-converter-plan.md 第 2.3 / 7 節 Phase 7
 *
 * 此模組由 Phase 0 spike A 驗證可行（GPU delegate 可用，單幀延遲符合
 * 30fps 即時標準）。CDN 路徑與初始化參數沿用 spike 的成功配置。
 *
 * 注意：
 *   - detectForVideo 要求 timestamp 嚴格遞增；呼叫端應傳遞影片
 *     currentTime 換算的毫秒值，並避免重複幀
 *   - 首次 init 需從 CDN 下載 ~15MB 模型 + WASM，UI 應顯示「初始化中」
 *   - dispose 後實例不可重用，需要重新建立
 */

import {
  HolisticLandmarker,
  FilesetResolver,
  type HolisticLandmarkerResult,
  type NormalizedLandmark,
  type Landmark as MpLandmark,
} from '@mediapipe/tasks-vision';
import type { Landmark, HolisticResult } from './landmarkTypes';

const WASM_CDN =
  'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.34/wasm';

const HOLISTIC_MODEL_URL =
  'https://storage.googleapis.com/mediapipe-models/holistic_landmarker/holistic_landmarker/float16/latest/holistic_landmarker.task';

export type Delegate = 'GPU' | 'CPU';

export interface MediaPipeRunnerOptions {
  /** 是否優先使用 GPU delegate（失敗自動降級 CPU） */
  preferGpu?: boolean;
  /** 自訂模型 URL（預設用 Google 官方 CDN） */
  modelAssetPath?: string;
  /** 自訂 WASM CDN（預設用 jsdelivr） */
  wasmAssetPath?: string;
}

export interface InitResult {
  delegate: Delegate;
  initMs: number;
}

/** 把 MediaPipe NormalizedLandmark / Landmark 轉為本專案 Landmark 型別 */
function toLandmark(lm: NormalizedLandmark | MpLandmark): Landmark {
  return {
    x: lm.x,
    y: lm.y,
    z: lm.z,
    visibility: 'visibility' in lm ? (lm as { visibility?: number }).visibility : undefined,
  };
}

/** 把整個 array 轉換 */
function toLandmarkArray(arr: readonly (NormalizedLandmark | MpLandmark)[] | undefined): Landmark[] {
  if (!arr) return [];
  return arr.map(toLandmark);
}

export class MediaPipeRunner {
  private landmarker: HolisticLandmarker | null = null;
  private currentDelegate: Delegate | null = null;
  private lastDetectTimestampMs = -1;

  /** 是否已成功初始化（可呼叫 detect） */
  get isReady(): boolean {
    return this.landmarker !== null;
  }

  /** 當前使用的 delegate（GPU 或 CPU），未 init 為 null */
  get delegate(): Delegate | null {
    return this.currentDelegate;
  }

  /**
   * 初始化 HolisticLandmarker。
   *
   * 嘗試順序：preferGpu=true → GPU → 失敗則 CPU；preferGpu=false → 直接 CPU。
   * 已初始化時直接回傳上次結果。
   */
  async init(opts: MediaPipeRunnerOptions = {}): Promise<InitResult> {
    if (this.landmarker) {
      return { delegate: this.currentDelegate ?? 'CPU', initMs: 0 };
    }

    const preferGpu = opts.preferGpu ?? true;
    const wasmPath = opts.wasmAssetPath ?? WASM_CDN;
    const modelPath = opts.modelAssetPath ?? HOLISTIC_MODEL_URL;

    const t0 = performance.now();
    const fileset = await FilesetResolver.forVisionTasks(wasmPath);

    const tryCreate = async (delegate: Delegate): Promise<HolisticLandmarker> =>
      HolisticLandmarker.createFromOptions(fileset, {
        baseOptions: {
          modelAssetPath: modelPath,
          delegate,
        },
        runningMode: 'VIDEO',
        outputFaceBlendshapes: false,
        outputPoseSegmentationMasks: false,
      });

    if (preferGpu) {
      try {
        this.landmarker = await tryCreate('GPU');
        this.currentDelegate = 'GPU';
      } catch (gpuErr) {
        console.warn('[MediaPipeRunner] GPU delegate 失敗，降級 CPU:', gpuErr);
        this.landmarker = await tryCreate('CPU');
        this.currentDelegate = 'CPU';
      }
    } else {
      this.landmarker = await tryCreate('CPU');
      this.currentDelegate = 'CPU';
    }

    const initMs = performance.now() - t0;
    return { delegate: this.currentDelegate, initMs };
  }

  /**
   * 對單幀影片做 holistic detection。
   *
   * @param video 已 loadedmetadata 的 HTMLVideoElement
   * @param timestampMs 嚴格遞增的時間戳（毫秒），通常為 video.currentTime * 1000
   * @returns HolisticResult 或 null（landmarker 未初始化 / 時間戳重複）
   */
  detect(video: HTMLVideoElement, timestampMs: number): HolisticResult | null {
    if (!this.landmarker) return null;
    if (timestampMs <= this.lastDetectTimestampMs) return null;
    this.lastDetectTimestampMs = timestampMs;

    const raw: HolisticLandmarkerResult = this.landmarker.detectForVideo(video, timestampMs);

    return {
      poseLandmarks: toLandmarkArray(raw.poseLandmarks?.[0]),
      poseWorldLandmarks: toLandmarkArray(raw.poseWorldLandmarks?.[0]),
      leftHandLandmarks: toLandmarkArray(raw.leftHandLandmarks?.[0]),
      rightHandLandmarks: toLandmarkArray(raw.rightHandLandmarks?.[0]),
      faceLandmarks: toLandmarkArray(raw.faceLandmarks?.[0]),
      timestampMs,
    };
  }

  /** 重置內部時間戳（影片 seek 或 restart 後呼叫） */
  resetTimestamp(): void {
    this.lastDetectTimestampMs = -1;
  }

  /** 釋放資源。dispose 後實例不可重用 */
  dispose(): void {
    if (this.landmarker) {
      this.landmarker.close();
      this.landmarker = null;
    }
    this.currentDelegate = null;
    this.lastDetectTimestampMs = -1;
  }
}
