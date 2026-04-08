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
import { PreviewCharacterScene } from './preview/PreviewCharacterScene';
import { VrmSwitcher } from './preview/VrmSwitcher';
import { PoseSolver } from './solver/PoseSolver';
import type { SolvedPose } from './solver/PoseSolver';
import { CaptureBuffer } from './capture/CaptureBuffer';
import { smoothCaptureBufferData } from './capture/smoothBuffer';
import { GaussianQuatSmoother } from './filters/GaussianQuatSmoother';
import { Timeline } from './ui/Timeline';
import { SettingsPanel, type SettingsState } from './ui/SettingsPanel';
import { serializeToVadJson } from './export/VadJsonWriter';
import { VrmaExporter } from './export/VrmaExporter';
import { bufferToClip } from '../animation/BufferToClip';

const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Missing element: #${id}`);
  return el as T;
};

interface AppState {
  runner: MediaPipeRunner | null;
  video: VideoSource | null;
  overlay: SkeletonOverlay | null;
  preview: PreviewCharacterScene | null;
  vrmSwitcher: VrmSwitcher;
  poseSolver: PoseSolver;
  captureBuffer: CaptureBuffer;
  /** Stage 1 / Stage 2 凍結後的時間軸長度（秒），0 表示未擷取 */
  bufferDuration: number;
  smoother: GaussianQuatSmoother;
  timeline: Timeline | null;
  settings: SettingsPanel | null;
  /** Stage 2 重抽 fps（由 SettingsPanel 控制） */
  stage2Fps: number;
  detecting: boolean;
  stage2Running: boolean;
  frameCount: number;
  latencySum: number;
  rafId: number | null;
}

const state: AppState = {
  runner: null,
  video: null,
  overlay: null,
  preview: null,
  vrmSwitcher: new VrmSwitcher(),
  // Stage 1 預設關閉手指（plan 第 8 節 Open Question 1：手指即時預覽
  // 門檻由 spike 決定，spike A 結果為手指穩定，但保守起見預設 OFF）
  poseSolver: new PoseSolver({ enableHands: false, enableEyes: true }),
  captureBuffer: new CaptureBuffer(),
  bufferDuration: 0,
  // Stage 2 離線平滑器（plan 第 2.6 / 5.5 節）
  smoother: new GaussianQuatSmoother({ halfWindow: 3, sigma: 1.5 }),
  timeline: null,
  settings: null,
  stage2Fps: 30,
  detecting: false,
  stage2Running: false,
  frameCount: 0,
  latencySum: 0,
  rafId: null,
};

function setStatus(text: string): void {
  $<HTMLDivElement>('vc-status').textContent = text;
}

async function bootstrap(): Promise<void> {
  const loadVideoBtn = $<HTMLButtonElement>('vc-load-video-btn');
  const loadVrmBtn = $<HTMLButtonElement>('vc-load-vrm-btn');
  const startBtn = $<HTMLButtonElement>('vc-start-btn');
  const stopBtn = $<HTMLButtonElement>('vc-stop-btn');
  const hqBtn = $<HTMLButtonElement>('vc-hq-btn');
  const exportBtn = $<HTMLButtonElement>('vc-export-btn');
  const fileInput = $<HTMLInputElement>('vc-file-input');
  const videoEl = $<HTMLVideoElement>('vc-video');
  const overlayCanvas = $<HTMLCanvasElement>('vc-skeleton-overlay');
  const previewCanvas = $<HTMLCanvasElement>('vc-preview-canvas');
  const videoStage = $<HTMLDivElement>('vc-video-stage');
  const videoPlaceholder = $<HTMLDivElement>('vc-video-placeholder');
  const previewPlaceholder = $<HTMLDivElement>('vc-preview-placeholder');
  const timelineContainer = $<HTMLDivElement>('vc-timeline-container');

  state.video = new VideoSource(videoEl);
  state.overlay = new SkeletonOverlay(overlayCanvas, videoEl);
  state.preview = new PreviewCharacterScene(previewCanvas);
  state.timeline = new Timeline(timelineContainer);

  // Settings panel（Phase 14）
  const settingsContainer = $<HTMLDivElement>('vc-settings-panel');
  const settingsBtn = $<HTMLButtonElement>('vc-settings-btn');
  state.settings = new SettingsPanel(settingsContainer, {
    enableHands: false,
    enableEyes: true,
    gaussianSigma: 1.5,
    gaussianHalfWindow: 3,
    stage2Fps: 30,
  });
  state.settings.onChange((s: SettingsState) => {
    state.poseSolver.setOptions({
      enableHands: s.enableHands,
      enableEyes: s.enableEyes,
    });
    state.smoother.setOptions({
      sigma: s.gaussianSigma,
      halfWindow: s.gaussianHalfWindow,
    });
    state.stage2Fps = s.stage2Fps;
    console.log('[VC] settings changed:', s);
  });
  settingsBtn.addEventListener('click', () => state.settings?.toggle());

  // Timeline scrub → sampleAt buffer → applyPose
  state.timeline.onScrub((t) => {
    if (!state.preview || state.captureBuffer.length === 0) return;
    const frame = state.captureBuffer.sampleAt(t * 1000);
    if (frame) {
      state.preview.applyPose({
        hipsTranslation: frame.hipsTranslation,
        boneRotations: frame.boneRotations,
      });
    }
  });

  setStatus('Phase 9 — 載入 VRM 預覽中...');

  // ── 載入預設 VRM（從主視窗 config.vrmModelPath） ──
  loadVrmBtn.disabled = true;
  try {
    const config = await ipc.readConfig();
    if (config?.vrmModelPath) {
      const url = window.electronAPI.convertToAssetUrl(config.vrmModelPath);
      previewCanvas.style.display = 'block';
      // 等下一幀讓 layout 完成再 resize
      requestAnimationFrame(() => state.preview?.resize());
      await state.preview.loadVrm(url);
      applyCalibration();
      state.preview.start();
      previewPlaceholder.style.display = 'none';
      console.log('[VC] 預設 VRM 載入成功:', config.vrmModelPath);
    } else {
      previewPlaceholder.style.display = 'flex';
      console.log('[VC] config 中無 vrmModelPath，請點「切換 VRM」載入');
    }
  } catch (err) {
    console.warn('[VC] 預設 VRM 載入失敗:', err);
    previewPlaceholder.style.display = 'flex';
  }
  loadVrmBtn.disabled = false;

  /** 從當前載入的 VRM 校正 REF_DIR 並餵給 PoseSolver */
  function applyCalibration(): void {
    if (!state.preview) return;
    const calibrated = state.preview.calibrateRefDirs();
    state.poseSolver.setRefDirs(calibrated);
    console.log(
      `[VC] REF_DIR calibrated: ${Object.keys(calibrated).length} bones from VRM bind pose`
    );
  }

  setStatus('Phase 9 — 等待載入影片');

  // ── 切換 VRM ──
  loadVrmBtn.addEventListener('click', async () => {
    if (!state.preview) return;
    await state.vrmSwitcher.pickAndApply(async (vrmPath) => {
      const url = window.electronAPI.convertToAssetUrl(vrmPath);
      previewCanvas.style.display = 'block';
      requestAnimationFrame(() => state.preview?.resize());
      await state.preview!.loadVrm(url);
      if (!state.preview!.isModelLoaded) return;
      applyCalibration();
      state.preview!.start();
      previewPlaceholder.style.display = 'none';
      console.log('[VC] 切換 VRM:', vrmPath);
    });
  });

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

  // 視窗 resize 時重抓 overlay + preview scene 尺寸
  window.addEventListener('resize', () => {
    state.overlay?.resize();
    state.preview?.resize();
  });

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
    state.captureBuffer.clear();
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
    const finalized = state.captureBuffer.finalize(state.video?.nominalFps ?? 30);
    state.bufferDuration = finalized.duration;
    const avgMs = state.frameCount > 0 ? state.latencySum / state.frameCount : 0;
    console.log(
      `[VC] 偵測停止：${state.frameCount} 幀，平均 ${avgMs.toFixed(1)}ms，` +
        `buffer.duration=${finalized.duration.toFixed(2)}s frames=${finalized.frames.length}`
    );
    setStatus(
      `Stage 1 完成（${finalized.frames.length} 幀 / ${finalized.duration.toFixed(2)}s）— 可拖曳時間軸或點「高品質處理」`
    );
    // 啟用 timeline、HQ、匯出按鈕
    state.timeline?.setDuration(finalized.duration);
    hqBtn.disabled = finalized.frames.length === 0;
    exportBtn.disabled = finalized.frames.length === 0;
  });

  // ── 匯出為 .vad.json（Phase 12；Phase 13 會再加 .vrma 同步產出） ──
  // 名稱取自工具列的 input 欄位；留空則用 timestamp 預設名
  const exportNameInput = $<HTMLInputElement>('vc-export-name-input');
  exportBtn.addEventListener('click', async () => {
    if (state.captureBuffer.length === 0) return;
    const typed = exportNameInput.value.trim();
    const name =
      typed ||
      `capture-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}`;

    exportBtn.disabled = true;
    setStatus('匯出中：序列化 .vad.json...');
    try {
      const finalized = state.captureBuffer.finalize(
        state.video?.nominalFps ?? 30
      );
      const vadJson = serializeToVadJson(finalized);

      // 同步產出 .vrma（Phase 13）：用 BufferToClip 轉為 AnimationClip 後
      // 經 VrmaExporter（GLTFExporter + VRMC_vrm_animation 注入）
      let vrmaBuffer: ArrayBuffer | null = null;
      try {
        setStatus('匯出中：產出 .vrma...');
        const clip = bufferToClip(finalized, name);
        const vrmaExporter = new VrmaExporter();
        vrmaBuffer = await vrmaExporter.export(clip);
        console.log(`[VC] .vrma 產出成功：${vrmaBuffer.byteLength} bytes`);
      } catch (vrmaErr) {
        console.warn('[VC] .vrma 匯出失敗，僅輸出 .vad.json:', vrmaErr);
      }

      const result = await ipc.writeUserVrma(name, vadJson, vrmaBuffer);
      if (result) {
        console.log('[VC] 匯出成功:', result);
        const vrmaSuffix = result.vrmaPath ? ' + .vrma' : '';
        setStatus(
          `匯出成功：${result.name}.vad.json${vrmaSuffix}（${finalized.frames.length} 幀）`
        );
        exportNameInput.value = '';
      } else {
        setStatus('匯出失敗，請查看 console');
      }
    } catch (err) {
      console.error('[VC] 匯出失敗:', err);
      setStatus(`匯出失敗：${(err as Error).message}`);
    } finally {
      exportBtn.disabled = state.captureBuffer.length === 0;
    }
  });

  // ── 高品質處理（Stage 2 batch + Gaussian smoothing） ──
  hqBtn.addEventListener('click', async () => {
    if (state.stage2Running) return;
    if (!state.video || !state.runner || state.captureBuffer.length === 0) return;
    state.stage2Running = true;
    hqBtn.disabled = true;
    startBtn.disabled = true;
    state.timeline?.setEnabled(false);

    try {
      await runStage2(hqBtn);
    } catch (err) {
      console.error('[VC] Stage 2 失敗:', err);
      setStatus(`Stage 2 失敗：${(err as Error).message}`);
    } finally {
      state.stage2Running = false;
      startBtn.disabled = false;
      hqBtn.disabled = state.captureBuffer.length === 0;
      state.timeline?.setEnabled(true);
    }
  });

  console.log('[VC] video-converter window bootstrapped (Phase 8)');
}

/**
 * Stage 2 批次重抽：以固定 HQ_FPS seek 影片每一幀，重新跑 MediaPipe +
 * PoseSolver，收集完整時序後套用 Gaussian 平滑，最後回寫 state.captureBuffer。
 *
 * 對應 plan 第 7 節 Phase 11 規格：「Stage 2 重抽 fps：先固定 30fps」。
 */
async function runStage2(hqBtn: HTMLButtonElement): Promise<void> {
  if (!state.video || !state.runner) return;
  const HQ_FPS = state.stage2Fps;
  const frameInterval = 1 / HQ_FPS;
  const duration = state.video.duration;
  const numFrames = Math.max(1, Math.floor(duration * HQ_FPS));

  // 取得處理 overlay DOM（一次，後續重用）
  const stage2Overlay = $<HTMLDivElement>('vc-stage2-overlay');
  const progressEl = $<HTMLDivElement>('vc-stage2-progress');
  const frameEl = $<HTMLDivElement>('vc-stage2-frame');

  console.log(`[VC] Stage 2 開始：${numFrames} 幀 @ ${HQ_FPS}fps`);
  setStatus(`Stage 2 處理中：0/${numFrames} (0%)`);

  // 顯示處理 overlay 蓋住 video 高速 seek 造成的畫面閃爍
  stage2Overlay.classList.remove('hidden');
  progressEl.textContent = '0%';
  frameEl.textContent = `0 / ${numFrames}`;

  const newBuffer = new CaptureBuffer();
  state.video.pause();

  try {
    // MediaPipe 內部的 calculator graph 記住 Stage 1 最後一個 timestamp（影片
    // 時間），如果 Stage 2 又從 t=0 餵給 detectForVideo 會被 reject（非單調）。
    // 解法：Stage 2 的 MediaPipe timestamp 用 performance.now()（全域單調），
    // CaptureBuffer 仍然存 video time。兩者分離。
    for (let i = 0; i < numFrames; i++) {
      if (!state.stage2Running) {
        console.log('[VC] Stage 2 被中斷');
        break;
      }
      const t = i * frameInterval;
      await state.video.seekTo(t);
      const mpTimestamp = performance.now();
      const result = state.runner.detect(state.video.element, mpTimestamp);
      if (result) {
        const solved = state.poseSolver.solve(result);
        newBuffer.push({
          timestampMs: t * 1000, // 注意：存 video time，不是 mpTimestamp
          hipsTranslation: solved.hipsTranslation,
          boneRotations: solved.boneRotations,
        });
      }

      // 進度回報（每 10 幀或每 5% 更新）
      if (i % 10 === 0 || i === numFrames - 1) {
        const pct = Math.round((i / numFrames) * 100);
        const pctStr = pct.toString();
        setStatus(`Stage 2 處理中：${i + 1}/${numFrames} (${pctStr}%)`);
        state.timeline?.setCurrentTime(t);
        hqBtn.textContent = `處理中 ${pctStr}%`;
        progressEl.textContent = `${pctStr}%`;
        frameEl.textContent = `${i + 1} / ${numFrames}`;
        // 讓事件迴圈跑一下，避免 UI 卡死
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
      }
    }

    // 進入平滑階段，overlay 更新文字
    progressEl.textContent = '平滑';
    frameEl.textContent = `${numFrames} / ${numFrames}`;

    const rawFinalized = newBuffer.finalize(HQ_FPS);
    console.log(`[VC] Stage 2 raw: ${rawFinalized.frames.length} 幀，開始 Gaussian 平滑`);

    // 離線 Gaussian 平滑
    const smoothed = smoothCaptureBufferData(rawFinalized, state.smoother);

    // 回寫 state.captureBuffer
    state.captureBuffer.clear();
    for (const f of smoothed.frames) state.captureBuffer.push(f);
    state.bufferDuration = smoothed.duration;

    console.log(
      `[VC] Stage 2 完成：${smoothed.frames.length} 幀平滑後，duration=${smoothed.duration.toFixed(2)}s`
    );
    setStatus(
      `Stage 2 完成（${smoothed.frames.length} 幀平滑後 / ${smoothed.duration.toFixed(2)}s）— 拖曳時間軸預覽`
    );
    state.timeline?.setDuration(smoothed.duration);
  } finally {
    // 無論成功 / 失敗 / 中斷，都要隱藏 overlay 與還原按鈕文字
    stage2Overlay.classList.add('hidden');
    hqBtn.textContent = '高品質處理';
  }
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

  const videoTimeMs = videoEl.currentTime * 1000;
  // MediaPipe 內部 calculator graph 需要嚴格單調遞增的 timestamp。
  // 用 performance.now() 避開「Stage 1 → Stage 2 → 再 Stage 1」重跑時
  // video.currentTime 倒退觸發 MediaPipe INVALID_ARGUMENT 的坑。
  // CaptureBuffer 仍然存 video time 作為可 scrub 的時間軸。
  const t0 = performance.now();
  const result: HolisticResult | null = state.runner.detect(videoEl, t0);
  const dt = performance.now() - t0;

  if (result) {
    state.frameCount++;
    state.latencySum += dt;
    state.overlay.draw(result);

    // ── PoseSolver → applyPose → CaptureBuffer ──
    const solved: SolvedPose = state.poseSolver.solve(result);
    state.preview?.applyPose(solved);
    state.captureBuffer.push({
      timestampMs: videoTimeMs,
      hipsTranslation: solved.hipsTranslation,
      boneRotations: solved.boneRotations,
    });

    // 每 30 幀印一次摘要
    if (state.frameCount % 30 === 0) {
      const avgMs = state.latencySum / state.frameCount;
      const boneCount = Object.keys(solved.boneRotations).length;
      console.log(
        `[VC] frame ${state.frameCount} | pose=${result.poseLandmarks.length} ` +
          `face=${result.faceLandmarks.length} | bones=${boneCount} ` +
          `hips=${solved.hipsTranslation ? 'yes' : 'no'} | ` +
          `dt=${dt.toFixed(1)}ms avg=${avgMs.toFixed(1)}ms`
      );
      setStatus(
        `偵測中：${state.frameCount} 幀，avg ${avgMs.toFixed(1)}ms ` +
          `(bones ${boneCount}, buffer ${state.captureBuffer.length})`
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
