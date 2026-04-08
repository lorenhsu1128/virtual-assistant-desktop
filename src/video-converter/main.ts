/**
 * 影片動作轉換器 — 入口邏輯
 *
 * Phase 1：視窗骨架
 * Phase 7：MediaPipe Runner 整合（console log landmarks 驗證）
 *
 * 後續 Phase：
 *   - Phase 8：左窗格 video + skeleton overlay
 *   - Phase 9：右窗格 VRM 預覽
 *   - Phase 10：Stage 1 即時擷取 pipeline（接 PoseSolver / CaptureBuffer）
 */

import { MediaPipeRunner } from './tracking/MediaPipeRunner';
import type { HolisticResult } from './tracking/landmarkTypes';

const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Missing element: #${id}`);
  return el as T;
};

interface AppState {
  runner: MediaPipeRunner | null;
  videoUrl: string | null;
  detecting: boolean;
  frameCount: number;
  latencySum: number;
  rafId: number | null;
}

const state: AppState = {
  runner: null,
  videoUrl: null,
  detecting: false,
  frameCount: 0,
  latencySum: 0,
  rafId: null,
};

function setStatus(text: string): void {
  $<HTMLDivElement>('vc-status').textContent = text;
}

async function bootstrap(): Promise<void> {
  const loadVideoBtn = $<HTMLButtonElement>('vc-load-video-btn');
  const startBtn = $<HTMLButtonElement>('vc-start-btn');
  const stopBtn = $<HTMLButtonElement>('vc-stop-btn');
  const fileInput = $<HTMLInputElement>('vc-file-input');
  const video = $<HTMLVideoElement>('vc-video');
  const videoStage = $<HTMLDivElement>('vc-video-stage');
  const videoPlaceholder = $<HTMLDivElement>('vc-video-placeholder');
  const previewPlaceholder = $<HTMLDivElement>('vc-preview-placeholder');

  // 預覽窗格 placeholder（Phase 9 才會接上 VRM 預覽）
  previewPlaceholder.style.display = 'flex';

  setStatus('Phase 7 — 等待載入影片');

  // ── 載入影片 ──
  loadVideoBtn.addEventListener('click', () => fileInput.click());

  fileInput.addEventListener('change', () => {
    const file = fileInput.files?.[0];
    if (!file) return;
    if (state.videoUrl) URL.revokeObjectURL(state.videoUrl);
    state.videoUrl = URL.createObjectURL(file);
    video.src = state.videoUrl;
    video.load();
    console.log('[VC] 載入影片:', file.name);
    setStatus(`載入中：${file.name}`);

    video.addEventListener(
      'loadedmetadata',
      () => {
        videoPlaceholder.style.display = 'none';
        videoStage.style.display = 'block';
        startBtn.disabled = false;
        const info = `${video.videoWidth}×${video.videoHeight}, ${video.duration.toFixed(1)}s`;
        console.log(`[VC] 影片就緒: ${info}`);
        setStatus(`影片就緒（${info}）— 點擊「開始擷取」`);
      },
      { once: true }
    );
  });

  // ── 開始擷取（init runner + detect loop） ──
  startBtn.addEventListener('click', async () => {
    startBtn.disabled = true;

    if (!state.runner) {
      setStatus('初始化 MediaPipe...（首次需從 CDN 下載 ~15MB）');
      state.runner = new MediaPipeRunner();
      try {
        const init = await state.runner.init({ preferGpu: true });
        console.log(`[VC] MediaPipeRunner ready: ${init.delegate}, init=${init.initMs.toFixed(0)}ms`);
        setStatus(`MediaPipe 就緒（${init.delegate}, ${init.initMs.toFixed(0)}ms）— 開始偵測`);
      } catch (err) {
        console.error('[VC] MediaPipe init 失敗:', err);
        setStatus(`MediaPipe init 失敗：${(err as Error).message}`);
        startBtn.disabled = false;
        return;
      }
    }

    state.detecting = true;
    state.frameCount = 0;
    state.latencySum = 0;
    state.runner.resetTimestamp();
    stopBtn.disabled = false;
    video.currentTime = 0;
    await video.play();
    detectLoop();
  });

  // ── 停止 ──
  stopBtn.addEventListener('click', () => {
    state.detecting = false;
    if (state.rafId !== null) {
      cancelAnimationFrame(state.rafId);
      state.rafId = null;
    }
    video.pause();
    startBtn.disabled = false;
    stopBtn.disabled = true;
    const avgMs = state.frameCount > 0 ? state.latencySum / state.frameCount : 0;
    console.log(`[VC] 偵測停止：${state.frameCount} 幀，平均 ${avgMs.toFixed(1)}ms`);
    setStatus(`已停止（${state.frameCount} 幀，avg ${avgMs.toFixed(1)}ms）`);
  });

  console.log('[VC] video-converter window bootstrapped (Phase 7)');
}

function detectLoop(): void {
  if (!state.detecting || !state.runner) return;
  const video = $<HTMLVideoElement>('vc-video');
  if (video.paused || video.ended) {
    state.detecting = false;
    $<HTMLButtonElement>('vc-start-btn').disabled = false;
    $<HTMLButtonElement>('vc-stop-btn').disabled = true;
    const avgMs = state.frameCount > 0 ? state.latencySum / state.frameCount : 0;
    console.log(`[VC] 影片播放結束：${state.frameCount} 幀，平均 ${avgMs.toFixed(1)}ms`);
    setStatus(`影片播放結束（${state.frameCount} 幀，avg ${avgMs.toFixed(1)}ms）`);
    return;
  }

  const ts = video.currentTime * 1000;
  const t0 = performance.now();
  const result: HolisticResult | null = state.runner.detect(video, ts);
  const dt = performance.now() - t0;

  if (result) {
    state.frameCount++;
    state.latencySum += dt;

    // 每 30 幀印一次摘要，避免 console 洪水
    if (state.frameCount % 30 === 0) {
      const avgMs = state.latencySum / state.frameCount;
      console.log(
        `[VC] frame ${state.frameCount} | pose=${result.poseLandmarks.length} ` +
          `world=${result.poseWorldLandmarks.length} ` +
          `LH=${result.leftHandLandmarks.length} RH=${result.rightHandLandmarks.length} ` +
          `face=${result.faceLandmarks.length} | dt=${dt.toFixed(1)}ms avg=${avgMs.toFixed(1)}ms`
      );
      setStatus(
        `偵測中：${state.frameCount} 幀，avg ${avgMs.toFixed(1)}ms ` +
          `(pose=${result.poseLandmarks.length} face=${result.faceLandmarks.length})`
      );
    }
  }

  state.rafId = requestAnimationFrame(detectLoop);
}

window.addEventListener('DOMContentLoaded', () => {
  bootstrap().catch((err) => {
    console.error('[VC] bootstrap error:', err);
  });
});
