/**
 * Spike A — MediaPipe HolisticLandmarker 可用性與延遲驗證
 *
 * 目標：
 *   1. 驗證 `@mediapipe/tasks-vision` 的 `HolisticLandmarker` 能否在 Electron Chromium 跑起來
 *   2. 實測 GPU delegate 是否可用（失敗降 CPU）
 *   3. 量測單幀 inference 延遲（avg / p50 / p95）
 *   4. 驗證四個 landmark group 都能穩定回傳
 *
 * 此檔為 investigative spike，不進入 production build。
 */

import {
  HolisticLandmarker,
  FilesetResolver,
  type HolisticLandmarkerResult,
} from '@mediapipe/tasks-vision';

// ────────────────────────────────────────────────────────────────
// DOM
// ────────────────────────────────────────────────────────────────

const video = document.getElementById('spike-video') as HTMLVideoElement;
const overlay = document.getElementById('spike-overlay') as HTMLCanvasElement;
const overlayCtx = overlay.getContext('2d')!;

const delegateSelect = document.getElementById('delegate-select') as HTMLSelectElement;
const btnInit = document.getElementById('btn-init') as HTMLButtonElement;
const btnStart = document.getElementById('btn-start') as HTMLButtonElement;
const btnStop = document.getElementById('btn-stop') as HTMLButtonElement;
const btnClear = document.getElementById('btn-clear') as HTMLButtonElement;
const fileVideo = document.getElementById('file-video') as HTMLInputElement;

const logEl = document.getElementById('spike-log') as HTMLDivElement;

const statDelegate = document.getElementById('stat-delegate')!;
const statInit = document.getElementById('stat-init')!;
const statFrames = document.getElementById('stat-frames')!;
const statAvg = document.getElementById('stat-avg')!;
const statP50 = document.getElementById('stat-p50')!;
const statP95 = document.getElementById('stat-p95')!;
const statPose = document.getElementById('stat-pose')!;
const statLHand = document.getElementById('stat-lhand')!;
const statRHand = document.getElementById('stat-rhand')!;
const statFace = document.getElementById('stat-face')!;

// ────────────────────────────────────────────────────────────────
// State
// ────────────────────────────────────────────────────────────────

let landmarker: HolisticLandmarker | null = null;
let detecting = false;
const latencySamples: number[] = [];
let lastTimestampMs = -1;
let frameCount = 0;

// ────────────────────────────────────────────────────────────────
// Logger
// ────────────────────────────────────────────────────────────────

function log(
  message: string,
  level: 'info' | 'success' | 'warn' | 'error' | 'section' = 'info',
): void {
  const line = document.createElement('div');
  line.className = `log-${level}`;
  const stamp = new Date().toLocaleTimeString();
  line.textContent = `[${stamp}] ${message}`;
  logEl.appendChild(line);
  logEl.scrollTop = logEl.scrollHeight;
  // eslint-disable-next-line no-console
  console.log(`[spike-mediapipe] ${message}`);
}

// ────────────────────────────────────────────────────────────────
// Stats helpers
// ────────────────────────────────────────────────────────────────

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.floor(sorted.length * p);
  return sorted[Math.min(idx, sorted.length - 1)];
}

function updateStats(): void {
  statFrames.textContent = String(frameCount);
  if (latencySamples.length === 0) {
    statAvg.textContent = '—';
    statP50.textContent = '—';
    statP95.textContent = '—';
    return;
  }
  const sum = latencySamples.reduce((a, b) => a + b, 0);
  const avg = sum / latencySamples.length;
  const sorted = [...latencySamples].sort((a, b) => a - b);
  const p50 = percentile(sorted, 0.5);
  const p95 = percentile(sorted, 0.95);

  statAvg.textContent = `${avg.toFixed(1)} ms`;
  statP50.textContent = `${p50.toFixed(1)} ms`;
  statP95.textContent = `${p95.toFixed(1)} ms`;

  // 顏色警示：> 33ms 警告，> 50ms 錯誤
  const colorize = (el: HTMLElement, v: number): void => {
    el.classList.remove('warn', 'error');
    if (v > 50) el.classList.add('error');
    else if (v > 33) el.classList.add('warn');
  };
  colorize(statAvg, avg);
  colorize(statP50, p50);
  colorize(statP95, p95);
}

// ────────────────────────────────────────────────────────────────
// Initialize HolisticLandmarker
// ────────────────────────────────────────────────────────────────

async function initLandmarker(): Promise<void> {
  const preferDelegate = delegateSelect.value as 'GPU' | 'CPU';
  log(`═══ 初始化 HolisticLandmarker（${preferDelegate}）═══`, 'section');

  const t0 = performance.now();
  try {
    // FilesetResolver 會從 CDN 載入 WASM
    const filesetResolver = await FilesetResolver.forVisionTasks(
      'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.34/wasm',
    );
    log('  WASM fileset 載入完成', 'success');

    landmarker = await HolisticLandmarker.createFromOptions(filesetResolver, {
      baseOptions: {
        modelAssetPath:
          'https://storage.googleapis.com/mediapipe-models/holistic_landmarker/holistic_landmarker/float16/latest/holistic_landmarker.task',
        delegate: preferDelegate,
      },
      runningMode: 'VIDEO',
      outputFaceBlendshapes: false,
      outputPoseSegmentationMasks: false,
    });

    const initMs = performance.now() - t0;
    statDelegate.textContent = preferDelegate;
    statInit.textContent = `${initMs.toFixed(0)} ms`;
    log(`✓ HolisticLandmarker 初始化成功（${initMs.toFixed(0)}ms）`, 'success');
    log(`  Delegate: ${preferDelegate}`, 'info');
  } catch (err) {
    const msg = (err as Error).message;
    log(`✗ ${preferDelegate} delegate 初始化失敗: ${msg}`, 'error');
    statDelegate.textContent = `${preferDelegate} FAILED`;
    statDelegate.classList.add('error');

    if (preferDelegate === 'GPU') {
      log('  自動降級嘗試 CPU delegate...', 'warn');
      delegateSelect.value = 'CPU';
      await initLandmarker();
      return;
    }
    throw err;
  }
}

// ────────────────────────────────────────────────────────────────
// Detect loop
// ────────────────────────────────────────────────────────────────

function resizeOverlay(): void {
  // 對齊影片實際顯示尺寸
  const rect = video.getBoundingClientRect();
  overlay.width = rect.width;
  overlay.height = rect.height;
  overlay.style.width = `${rect.width}px`;
  overlay.style.height = `${rect.height}px`;
}

function drawSkeleton(result: HolisticLandmarkerResult): void {
  overlayCtx.clearRect(0, 0, overlay.width, overlay.height);
  overlayCtx.lineWidth = 2;
  overlayCtx.strokeStyle = 'rgba(163, 190, 140, 0.9)';
  overlayCtx.fillStyle = 'rgba(235, 203, 139, 0.9)';

  // Draw pose landmarks
  const pose = result.poseLandmarks?.[0];
  if (pose) {
    for (const lm of pose) {
      if ((lm.visibility ?? 1) < 0.3) continue;
      const x = lm.x * overlay.width;
      const y = lm.y * overlay.height;
      overlayCtx.beginPath();
      overlayCtx.arc(x, y, 3, 0, Math.PI * 2);
      overlayCtx.fill();
    }
  }

  // Draw hand landmarks
  const drawHand = (hand: typeof result.leftHandLandmarks extends (infer T)[] ? T : never, color: string): void => {
    if (!hand) return;
    overlayCtx.fillStyle = color;
    for (const lm of hand) {
      const x = lm.x * overlay.width;
      const y = lm.y * overlay.height;
      overlayCtx.beginPath();
      overlayCtx.arc(x, y, 2, 0, Math.PI * 2);
      overlayCtx.fill();
    }
  };
  drawHand(result.leftHandLandmarks?.[0], 'rgba(136, 192, 208, 0.9)');
  drawHand(result.rightHandLandmarks?.[0], 'rgba(191, 97, 106, 0.9)');

  // Face: 畫輪廓點
  const face = result.faceLandmarks?.[0];
  if (face) {
    overlayCtx.fillStyle = 'rgba(180, 142, 173, 0.6)';
    for (const lm of face) {
      const x = lm.x * overlay.width;
      const y = lm.y * overlay.height;
      overlayCtx.beginPath();
      overlayCtx.arc(x, y, 1, 0, Math.PI * 2);
      overlayCtx.fill();
    }
  }
}

function detectLoop(): void {
  if (!detecting || !landmarker) return;
  if (video.paused || video.ended) {
    detecting = false;
    btnStart.disabled = false;
    btnStop.disabled = true;
    log('影片播放結束', 'info');
    return;
  }

  // Must use monotonically increasing timestamps
  const videoTs = video.currentTime * 1000;
  if (videoTs <= lastTimestampMs) {
    requestAnimationFrame(detectLoop);
    return;
  }
  lastTimestampMs = videoTs;

  const t0 = performance.now();
  try {
    const result = landmarker.detectForVideo(video, videoTs);
    const dt = performance.now() - t0;
    latencySamples.push(dt);
    if (latencySamples.length > 500) latencySamples.shift();
    frameCount++;

    // 更新 group stats
    statPose.textContent = result.poseLandmarks?.[0]?.length
      ? `${result.poseLandmarks[0].length} pts`
      : '—';
    statLHand.textContent = result.leftHandLandmarks?.[0]?.length
      ? `${result.leftHandLandmarks[0].length} pts`
      : '—';
    statRHand.textContent = result.rightHandLandmarks?.[0]?.length
      ? `${result.rightHandLandmarks[0].length} pts`
      : '—';
    statFace.textContent = result.faceLandmarks?.[0]?.length
      ? `${result.faceLandmarks[0].length} pts`
      : '—';

    drawSkeleton(result);
    updateStats();
  } catch (err) {
    log(`detectForVideo 錯誤: ${(err as Error).message}`, 'error');
  }

  requestAnimationFrame(detectLoop);
}

// ────────────────────────────────────────────────────────────────
// Wire up
// ────────────────────────────────────────────────────────────────

btnInit.addEventListener('click', async () => {
  btnInit.disabled = true;
  try {
    await initLandmarker();
    btnStart.disabled = !video.src;
  } catch {
    btnInit.disabled = false;
  }
});

fileVideo.addEventListener('change', () => {
  const file = fileVideo.files?.[0];
  if (!file) return;
  const url = URL.createObjectURL(file);
  video.src = url;
  video.load();
  log(`載入影片: ${file.name}`, 'info');
  video.addEventListener(
    'loadedmetadata',
    () => {
      log(`  尺寸: ${video.videoWidth}×${video.videoHeight}，時長: ${video.duration.toFixed(1)}s`, 'success');
      resizeOverlay();
      if (landmarker) btnStart.disabled = false;
    },
    { once: true },
  );
});

btnStart.addEventListener('click', () => {
  if (!landmarker) {
    log('尚未初始化 landmarker', 'error');
    return;
  }
  detecting = true;
  btnStart.disabled = true;
  btnStop.disabled = false;
  latencySamples.length = 0;
  frameCount = 0;
  lastTimestampMs = -1;
  log('═══ 開始偵測 ═══', 'section');
  video.currentTime = 0;
  video.play();
  detectLoop();
});

btnStop.addEventListener('click', () => {
  detecting = false;
  video.pause();
  btnStart.disabled = false;
  btnStop.disabled = true;
  log(`偵測停止：共 ${frameCount} 幀`, 'info');
});

btnClear.addEventListener('click', () => {
  logEl.innerHTML = '';
});

window.addEventListener('resize', resizeOverlay);

log('═══ Spike A: MediaPipe HolisticLandmarker ═══', 'section');
log('流程：', 'info');
log('  1. 選 delegate（預設 GPU）→ 按「初始化」', 'info');
log('  2. 載入影片（建議用專案根目錄的「人物推動大箱子影片.mp4」）', 'info');
log('  3. 按「開始偵測」→ 觀察延遲與 landmark group 回傳情況', 'info');
log('成功準則：delegate 可用、中位延遲 < 33ms、4 個 group 都有資料', 'info');
log('注意：首次初始化需從 CDN 下載 .task 模型與 WASM（~15MB），可能 5-15 秒', 'warn');
