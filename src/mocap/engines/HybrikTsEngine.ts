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
import type { PoseLandmark, PoseLandmarks } from '../mediapipe/types';
import type { SmplTrack } from '../types';
import { buildSmplTrackFromLandmarks, type LandmarksFrame } from '../hybrik/buildSmplTrackFromLandmarks';
import { landmarksToSmplJointPositions } from '../hybrik/LandmarkToSmplJoint';
import { solveSmplFromJointPositions } from '../hybrik/SolverCore';
import { seekVideoTo } from './videoFrameSeeker';
import { SMPL_JOINT_NAMES } from '../smpl/SmplSkeleton';

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

      // Phase 5d+ 診斷：第一幀 dump raw MP / SMPL / solver axis-angles
      if (i === 0 && lm) {
        logFirstFrameDiagnostics(lm);
      }

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

// ═══════════════════════════════════════════════════════════
// 診斷工具（Phase 5d+）
// ═══════════════════════════════════════════════════════════

/**
 * MediaPipe 33 個 landmark 中的關鍵點索引與語意名稱
 * 供第一幀 dump 使用，便於肉眼辨認實際座標方向
 */
const DIAG_KEYPOINTS: ReadonlyArray<readonly [number, string]> = [
  [0, 'nose'],
  [11, 'L_shoulder'],
  [12, 'R_shoulder'],
  [13, 'L_elbow'],
  [14, 'R_elbow'],
  [15, 'L_wrist'],
  [16, 'R_wrist'],
  [23, 'L_hip'],
  [24, 'R_hip'],
  [25, 'L_knee'],
  [26, 'R_knee'],
  [27, 'L_ankle'],
  [28, 'R_ankle'],
];

const DIAG_SMPL_JOINTS: ReadonlyArray<number> = [
  0,  // pelvis
  3,  // spine1
  12, // neck
  15, // head
  16, // leftShoulder (upper arm)
  18, // leftElbow (lower arm)
  20, // leftWrist
  1,  // leftHip
  4,  // leftKnee
  7,  // leftAnkle
];

/** 格式化一個浮點數為 4 位小數 */
function fmt(n: number): string {
  return n.toFixed(4).padStart(8);
}

/** 一個 PoseLandmark 印成單行字串 */
function formatLandmark(lm: PoseLandmark): string {
  return `x=${fmt(lm.x)} y=${fmt(lm.y)} z=${fmt(lm.z)}  vis=${lm.visibility.toFixed(2)}`;
}

/**
 * 印出第一幀診斷訊息到 console
 *
 * 目的：把 MediaPipe 實際輸出的 world landmark 值、經過 mediaPipeWorldToSmpl
 * 轉換後的 SMPL 位置、以及 HybrIK solver 輸出的 axis-angle 全部 dump 出來，
 * 以便肉眼比對「預期方向」vs「實際方向」，精準定位座標系 / solver 的錯誤。
 *
 * 只在第一幀呼叫一次，不會 spam console。
 */
function logFirstFrameDiagnostics(lm: PoseLandmarks): void {
  /* eslint-disable no-console */
  const world = lm.world;
  if (!world || world.length < 33) {
    console.warn('[HybrIK diag] first frame world landmarks missing');
    return;
  }

  console.group('%c[HybrIK diag] First frame dump', 'color:#7ac; font-weight:bold');

  // ── 1. Raw MediaPipe world landmarks（關鍵點）──
  console.group('1. Raw MediaPipe world landmarks (meters, hip-centered)');
  console.log('Hint: 站立面向鏡頭時，觀察 head/foot 的 y 值誰大誰小 → 判斷 y 上/下；');
  console.log('      手部/臉部的 z 值比 hip 大還小 → 判斷 z 前/後');
  for (const [idx, name] of DIAG_KEYPOINTS) {
    const p = world[idx];
    if (p) {
      console.log(`  [${String(idx).padStart(2)}] ${name.padEnd(12)}  ${formatLandmark(p)}`);
    }
  }
  console.groupEnd();

  // ── 2. Transformed SMPL positions ──
  const smplPositions = landmarksToSmplJointPositions(world);
  console.group('2. After mediaPipeWorldToSmpl → SMPL positions');
  console.log('Hint: SMPL +Y 應該是「上」、+X 應該是「主體左側」、+Z 應該是「主體前方」');
  for (const jIdx of DIAG_SMPL_JOINTS) {
    const p = smplPositions[jIdx];
    const n = SMPL_JOINT_NAMES[jIdx];
    console.log(
      `  [${String(jIdx).padStart(2)}] ${n.padEnd(14)}  x=${fmt(p.x)} y=${fmt(p.y)} z=${fmt(p.z)}`,
    );
  }
  console.groupEnd();

  // ── 3. Solver output axis-angles ──
  const solveResult = solveSmplFromJointPositions(smplPositions);
  console.group('3. HybrIK solver output axis-angles (radians)');
  console.log('Hint: 每個 joint 顯示 [ax, ay, az]，向量長度 = 旋轉角度；');
  console.log('      若 pelvis rotation 近零但身體該前傾 → 兩軸擬合有問題');
  for (const jIdx of DIAG_SMPL_JOINTS) {
    const aa = solveResult.axisAngles[jIdx];
    const mag = Math.sqrt(aa[0] * aa[0] + aa[1] * aa[1] + aa[2] * aa[2]);
    const n = SMPL_JOINT_NAMES[jIdx];
    console.log(
      `  [${String(jIdx).padStart(2)}] ${n.padEnd(14)}  ` +
        `[${fmt(aa[0])}, ${fmt(aa[1])}, ${fmt(aa[2])}]  |aa|=${mag.toFixed(4)} (${((mag * 180) / Math.PI).toFixed(1)}°)`,
    );
  }
  console.groupEnd();

  // ── 4. Root translation ──
  console.log(
    `4. Root translation: [${solveResult.rootTranslation.map(fmt).join(', ')}]`,
  );

  console.groupEnd();
  /* eslint-enable no-console */
}
