/**
 * 影片動作轉換器 — 入口邏輯
 *
 * Phase 1：視窗骨架
 * Phase 7：MediaPipe Runner 整合（console log landmarks 驗證）
 * Phase 8：左窗格 video + skeleton overlay + IPC pickVideoFile
 *
 * 後續 Phase：
 *   - Phase 9：右窗格 VRM 預覽
 *   - Phase 10：Stage 1 即時擷取 pipeline（接 PoseSolver / CaptureBuffer）
 */

import { ipc } from '../bridge/ElectronIPC';
import { MediaPipeRunner } from './tracking/MediaPipeRunner';
import type { HolisticResult } from './tracking/landmarkTypes';
import { VideoSource } from './video/VideoSource';
import { SkeletonOverlay } from './video/SkeletonOverlay';

const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Missing element: #${id}`);
  return el as T;
};

interface AppState {
  runner: MediaPipeRunner | null;
  video: VideoSource | null;
  overlay: SkeletonOverlay | null;
  detecting: boolean;
  frameCount: number;
  latencySum: number;
  rafId: number | null;
}

const state: AppState = {
  runner: null,
  video: null,
  overlay: null,
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
  const videoEl = $<HTMLVideoElement>('vc-video');
  const overlayCanvas = $<HTMLCanvasElement>('vc-skeleton-overlay');
  const videoStage = $<HTMLDivElement>('vc-video-stage');
  const videoPlaceholder = $<HTMLDivElement>('vc-video-placeholder');
  const previewPlaceholder = $<HTMLDivElement>('vc-preview-placeholder');

  state.video = new VideoSource(videoEl);
  state.overlay = new SkeletonOverlay(overlayCanvas, videoEl);

  // 預覽窗格 placeholder（Phase 9 才會接上 VRM 預覽）
  previewPlaceholder.style.display = 'flex';

  setStatus('Phase 8 — 等待載入影片');

  // ── 載入影片：走 IPC pickVideoFile（cancel 不做任何事；
  //               IPC 真正失敗才 fallback 為 <input file>） ──
  let pickerBusy = false;
  loadVideoBtn.addEventListener('click', async () => {
    if (pickerBusy) return; // 防止重複點擊
    pickerBusy = true;
    try {
      const filePath = await ipc.pickVideoFile();
      if (filePath) {
        const url = window.electronAPI.convertToAssetUrl(filePath);
        await loadVideoFromUrl(url, filePath);
      }
      // filePath === null：使用者主動 cancel，什麼都不做
    } catch (err) {
      console.warn('[VC] IPC pickVideoFile 失敗，fallback 為 <input file>:', err);
      fileInput.click();
    } finally {
      pickerBusy = false;
    }
  });

  fileInput.addEventListener('change', async () => {
    const file = fileInput.files?.[0];
    if (!file) return;
    await loadVideoFromFile(file);
    fileInput.value = ''; // reset 讓同一檔案可重選
  });

  async function loadVideoFromUrl(url: string, displayName: string): Promise<void> {
    if (!state.video || !state.overlay) return;
    setStatus(`載入中：${displayName}`);
    console.log('[VC] 載入影片 URL:', displayName);
    try {
      await state.video.loadUrl(url);
    } catch (err) {
      console.error('[VC] 影片載入失敗:', err);
      setStatus(`載入失敗：${(err as Error).message}`);
      return;
    }
    onVideoReady(displayName);
  }

  async function loadVideoFromFile(file: File): Promise<void> {
    if (!state.video || !state.overlay) return;
    setStatus(`載入中：${file.name}`);
    console.log('[VC] 載入影片 File:', file.name);
    try {
      await state.video.loadFile(file);
    } catch (err) {
      console.error('[VC] 影片載入失敗:', err);
      setStatus(`載入失敗：${(err as Error).message}`);
      return;
    }
    onVideoReady(file.name);
  }

  function onVideoReady(name: string): void {
    if (!state.video || !state.overlay) return;
    videoPlaceholder.style.display = 'none';
    videoStage.style.display = 'block';
    // 等下一個 frame 讓 layout 計算完成再 resize overlay
    requestAnimationFrame(() => state.overlay?.resize());
    startBtn.disabled = false;
    const info = `${state.video.videoWidth}×${state.video.videoHeight}, ${state.video.duration.toFixed(1)}s`;
    console.log(`[VC] 影片就緒: ${info}`);
    setStatus(`影片就緒：${name}（${info}）— 點擊「開始擷取」`);
  }

  // 視窗 resize 時重抓 overlay 尺寸
  window.addEventListener('resize', () => state.overlay?.resize());

  // ── 開始擷取（init runner + detect loop） ──
  startBtn.addEventListener('click', async () => {
    if (!state.video || !state.overlay) return;
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
    state.overlay.resize();
    stopBtn.disabled = false;
    await state.video.seekTo(0);
    await state.video.play();
    detectLoop();
  });

  // ── 停止 ──
  stopBtn.addEventListener('click', () => {
    state.detecting = false;
    if (state.rafId !== null) {
      cancelAnimationFrame(state.rafId);
      state.rafId = null;
    }
    state.video?.pause();
    startBtn.disabled = false;
    stopBtn.disabled = true;
    state.overlay?.clear();
    const avgMs = state.frameCount > 0 ? state.latencySum / state.frameCount : 0;
    console.log(`[VC] 偵測停止：${state.frameCount} 幀，平均 ${avgMs.toFixed(1)}ms`);
    setStatus(`已停止（${state.frameCount} 幀，avg ${avgMs.toFixed(1)}ms）`);
  });

  console.log('[VC] video-converter window bootstrapped (Phase 8)');
}

function detectLoop(): void {
  if (!state.detecting || !state.runner || !state.video || !state.overlay) return;
  const videoEl = state.video.element;
  if (videoEl.paused || videoEl.ended) {
    state.detecting = false;
    $<HTMLButtonElement>('vc-start-btn').disabled = false;
    $<HTMLButtonElement>('vc-stop-btn').disabled = true;
    const avgMs = state.frameCount > 0 ? state.latencySum / state.frameCount : 0;
    console.log(`[VC] 影片播放結束：${state.frameCount} 幀，平均 ${avgMs.toFixed(1)}ms`);
    setStatus(`影片播放結束（${state.frameCount} 幀，avg ${avgMs.toFixed(1)}ms）`);
    return;
  }

  const ts = videoEl.currentTime * 1000;
  const t0 = performance.now();
  const result: HolisticResult | null = state.runner.detect(videoEl, ts);
  const dt = performance.now() - t0;

  if (result) {
    state.frameCount++;
    state.latencySum += dt;
    state.overlay.draw(result);

    // 每 30 幀印一次摘要
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
