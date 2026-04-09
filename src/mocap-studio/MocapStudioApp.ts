/**
 * 影片動捕工作站 — 應用狀態機
 *
 * 組裝所有 UI 元件（TopBar / VideoPanel / Timeline / PreviewPanel）並處理事件流。
 *
 * Phase 0：建立 PreviewPanel 並載入主視窗當前的 VRM
 * Phase 1：載入影片 → 設定時間軸區間 → scrub / 播放控制
 * Phase 2c：載入靜態 SMPL fixture → 跑下游 pipeline → scrub / 播放套到 VRM 預覽
 *
 * 播放模式（playbackMode）：
 *   - 'none'   ：尚未載入任何內容
 *   - 'video'  ：Phase 1 影片模式（timeupdate 驅動）
 *   - 'fixture'：Phase 2c 動捕 fixture 模式（rAF 驅動）
 *   兩模式互斥：載入 fixture 會切到 fixture 模式（不清除 video）；
 *   再次載入影片會切回 video 模式。
 *
 * 後續 phase 將擴充：
 *   - Phase 3：VRMA exporter（吃 MocapFrame[]）
 *   - Phase 4+：engines（EasyMocap / HybrIK-TS），取代「dev fixture」來源
 */

import { ipc } from '../bridge/ElectronIPC';
import { PreviewPanel } from './PreviewPanel';
import { VideoPanel } from './VideoPanel';
import { Timeline, type TimelineElements } from './Timeline';
import { TopBar } from './TopBar';
import { formatTime } from './timelineLogic';
import { buildMocapFrames } from '../mocap/pipeline';
import { generateLeftArmRaiseFixture } from '../mocap/fixtures/testFixtures';
import { exportMocapToVrma } from '../mocap/exporter/VrmaExporter';
import { PoseRunner } from '../mocap/mediapipe/PoseRunner';
import { drawSkeleton } from '../mocap/mediapipe/SkeletonDrawer';
import type { PoseLandmarks } from '../mocap/mediapipe/types';
import type { MocapFrame } from '../mocap/types';

const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`[MocapStudioApp] Missing element: #${id}`);
  return el as T;
};

type PlaybackMode = 'none' | 'video' | 'fixture';

export class MocapStudioApp {
  private previewPanel: PreviewPanel | null = null;
  private videoPanel: VideoPanel | null = null;
  private timeline: Timeline | null = null;
  private topBar: TopBar | null = null;

  // 快取 DOM 引用
  private previewHintEl: HTMLDivElement | null = null;
  private statusEl: HTMLSpanElement | null = null;
  private playBtn: HTMLButtonElement | null = null;
  private timeDisplayEl: HTMLSpanElement | null = null;
  private exportBtn: HTMLButtonElement | null = null;

  // Phase 2c 狀態
  private mocapFrames: MocapFrame[] = [];
  private fixtureFps = 30;
  private fixturePlaybackRaf: number | null = null;
  private fixturePlaybackStartMs = 0;
  private fixturePlaybackFromSec = 0;
  private currentFixtureTimeSec = 0;

  // Phase 5a 狀態（MediaPipe）
  private poseRunner: PoseRunner | null = null;
  private lastLandmarks: PoseLandmarks | null = null;
  /** 持續偵測模式旗標：true 時每次 timeupdate / seeked 自動跑偵測 */
  private poseDetectionActive = false;
  /** 正在跑 detect 的 guard，避免播放時 timeupdate 堆疊多個 detect call */
  private detectionInflight = false;

  // 通用
  private playbackMode: PlaybackMode = 'none';
  private playing = false;
  private disposed = false;

  async init(): Promise<void> {
    this.previewHintEl = $<HTMLDivElement>('mocap-preview-hint');
    this.statusEl = $<HTMLSpanElement>('mocap-status');
    this.playBtn = $<HTMLButtonElement>('mocap-play-btn');
    this.timeDisplayEl = $<HTMLSpanElement>('mocap-time-display');
    this.exportBtn = $<HTMLButtonElement>('mocap-export-btn');

    // ── PreviewPanel ──
    const canvas = $<HTMLCanvasElement>('mocap-preview-canvas');
    this.previewPanel = new PreviewPanel(canvas);

    this.setStatus('載入主視窗 VRM 模型中...');
    const vrmPath = await ipc.getCurrentVrmPath();
    if (this.disposed) return;

    if (vrmPath) {
      const url = ipc.convertToAssetUrl(vrmPath);
      const ok = await this.previewPanel.loadModel(url);
      if (this.disposed) return;
      if (ok) {
        this.previewHintEl.classList.add('hidden');
        this.setStatus(`VRM 已載入：${basename(vrmPath)}`);
      } else {
        this.previewHintEl.classList.remove('hidden');
        this.previewHintEl.textContent = 'VRM 載入失敗';
        this.setStatus('VRM 載入失敗');
      }
    } else {
      this.previewHintEl.classList.remove('hidden');
      this.previewHintEl.textContent = '主視窗尚未選擇 VRM 模型';
      this.setStatus('就緒（無 VRM）');
    }

    // ── VideoPanel（Phase 5a 加入 overlay canvas） ──
    const videoEl = $<HTMLVideoElement>('mocap-video-element');
    const overlayCanvas = $<HTMLCanvasElement>('mocap-video-overlay');
    this.videoPanel = new VideoPanel(videoEl, overlayCanvas);
    this.videoPanel.addTimeUpdateListener(this.onVideoTimeUpdate);
    // Phase 5a: 'seeked' 事件在任何 seek 完成後觸發（含 scrub / 把手拖曳 / 點擊）
    videoEl.addEventListener('seeked', this.onVideoSeeked);

    // ── Timeline ──
    const tlElements: TimelineElements = {
      root: $<HTMLElement>('mocap-timeline'),
      track: $<HTMLElement>('mocap-tl-track'),
      range: $<HTMLElement>('mocap-tl-range'),
      playhead: $<HTMLElement>('mocap-tl-playhead'),
      inHandle: $<HTMLElement>('mocap-tl-in'),
      outHandle: $<HTMLElement>('mocap-tl-out'),
      inLabel: $<HTMLElement>('mocap-tl-in-label'),
      outLabel: $<HTMLElement>('mocap-tl-out-label'),
    };
    this.timeline = new Timeline(tlElements);
    this.timeline.onInChange = this.onTimelineInChange;
    this.timeline.onOutChange = this.onTimelineOutChange;
    this.timeline.onSeek = this.onTimelineSeek;

    // ── TopBar ──
    this.topBar = new TopBar({
      loadVideoBtn: $<HTMLButtonElement>('mocap-load-video-btn'),
      loadFixtureBtn: $<HTMLButtonElement>('mocap-load-fixture-btn'),
      detectPoseBtn: $<HTMLButtonElement>('mocap-detect-pose-btn'),
    });
    this.topBar.onLoadVideo = this.onLoadVideoClick;
    this.topBar.onLoadFixture = this.onLoadFixtureClick;
    this.topBar.onDetectPose = this.onDetectPoseClick;

    this.playBtn.addEventListener('click', this.onPlayToggle);
    this.exportBtn.addEventListener('click', this.onExportClick);
    window.addEventListener('resize', this.onResize);
  }

  // ── TopBar 事件：載入影片（Phase 1） ──

  private readonly onLoadVideoClick = async (): Promise<void> => {
    if (this.disposed || !this.videoPanel || !this.timeline) return;

    this.setStatus('選擇影片...');
    const videoPath = await ipc.pickVideo();
    if (this.disposed) return;
    if (!videoPath) {
      this.setStatus('已取消');
      return;
    }

    this.setStatus(`載入影片：${basename(videoPath)}...`);
    const url = ipc.convertToAssetUrl(videoPath);
    const duration = await this.videoPanel.loadVideo(url);
    if (this.disposed) return;

    if (duration === null || !Number.isFinite(duration) || duration <= 0) {
      this.setStatus('影片載入失敗');
      return;
    }

    // 停止任何現行播放、切回 video 模式
    this.stopPlayback();
    this.playbackMode = 'video';
    this.mocapFrames = [];
    this.previewPanel?.resetMocapPose();

    this.timeline.setDuration(duration);
    this.timeline.setEnabled(true);
    if (this.playBtn) this.playBtn.disabled = false;
    this.updateTimeDisplay(0, duration);
    // Phase 5a：啟用偵測姿態按鈕、同步 overlay canvas 尺寸、清空舊 overlay
    this.topBar?.setDetectPoseEnabled(true);
    this.videoPanel.syncOverlaySize();
    this.videoPanel.clearOverlay();
    this.lastLandmarks = null;
    this.setStatus(`影片已載入：${basename(videoPath)}（${formatTime(duration)}）`);
  };

  // ── TopBar 事件：持續姿態偵測（Phase 5a） ──

  private readonly onDetectPoseClick = async (): Promise<void> => {
    if (this.disposed || !this.videoPanel) return;

    // 已開啟 → 關閉並清除 overlay
    if (this.poseDetectionActive) {
      this.poseDetectionActive = false;
      this.videoPanel.clearOverlay();
      this.lastLandmarks = null;
      this.setStatus('姿態偵測已停用');
      return;
    }

    // Lazy init PoseRunner
    if (!this.poseRunner) {
      this.setStatus('載入 MediaPipe 模型...（首次可能較慢）');
      this.poseRunner = new PoseRunner();
      try {
        await this.poseRunner.init();
      } catch (e) {
        console.warn('[MocapStudioApp] PoseRunner init failed:', e);
        this.setStatus(`MediaPipe 初始化失敗：${(e as Error).message}`);
        this.poseRunner.dispose();
        this.poseRunner = null;
        return;
      }
      if (this.disposed) return;
    }

    // 啟用持續偵測模式，立即對當前幀偵測一次
    this.poseDetectionActive = true;
    this.setStatus(`持續姿態偵測中（${this.poseRunner.getUsedDelegate()}）`);
    await this.maybeDetectAndDraw();
  };

  /**
   * 對當前影片 frame 跑 MediaPipe 偵測並畫到 overlay
   *
   * 只在 poseDetectionActive=true 時運作。
   * 用 detectionInflight 旗標避免 timeupdate（50-60Hz）堆疊多個 detect call。
   * 使用 performance.now() 當 MediaPipe 時間戳（單調遞增、支援 scrub 回跳）。
   */
  private async maybeDetectAndDraw(): Promise<void> {
    if (this.disposed) return;
    if (!this.poseDetectionActive) return;
    if (this.detectionInflight) return;
    if (!this.poseRunner || !this.videoPanel) return;

    const video = this.videoPanel.getVideoElement();
    if (video.readyState < 2) return;

    this.detectionInflight = true;
    try {
      // MediaPipe VIDEO 模式要求單調遞增時間戳；
      // 用 performance.now() 避免 scrub 回跳導致 detectForVideo 失敗
      const monotonicTs = Math.round(performance.now());
      const landmarks = await this.poseRunner.detect(video, monotonicTs);
      if (this.disposed || !this.poseDetectionActive) return;
      if (landmarks) {
        this.lastLandmarks = landmarks;
        this.drawPoseOverlay();
      } else {
        this.lastLandmarks = null;
        this.videoPanel.clearOverlay();
      }
    } finally {
      this.detectionInflight = false;
    }
  }

  /** 把 lastLandmarks 畫到 overlay canvas（若有） */
  private drawPoseOverlay(): void {
    if (!this.videoPanel || !this.lastLandmarks) return;
    this.videoPanel.syncOverlaySize();
    const ctx = this.videoPanel.getOverlayContext();
    if (!ctx) return;
    const { width, height } = this.videoPanel.getOverlaySize();
    ctx.clearRect(0, 0, width, height);
    drawSkeleton(ctx, this.lastLandmarks, width, height);
  }

  /** 影片 seek 完成（含播放中 timeupdate 的 seeked、手動 scrub 的 seeked） */
  private readonly onVideoSeeked = (): void => {
    void this.maybeDetectAndDraw();
  };

  // ── TopBar 事件：載入 fixture（Phase 2c） ──

  private readonly onLoadFixtureClick = (): void => {
    if (this.disposed || !this.previewPanel || !this.timeline) return;

    const availableBones = this.previewPanel.getAvailableHumanoidBones();
    if (availableBones.size === 0) {
      this.setStatus('尚未載入 VRM，無法產生 fixture');
      return;
    }

    this.setStatus('生成測試 fixture...');

    // 1. 生成 SMPL track
    const track = generateLeftArmRaiseFixture(30, 2.0);

    // 2. 跑下游 pipeline
    this.mocapFrames = buildMocapFrames(track, availableBones, {
      filter: { minCutoff: 2.0, beta: 0.5 },
    });

    // 3. 切到 fixture 模式
    this.stopPlayback();
    this.playbackMode = 'fixture';
    this.fixtureFps = track.fps;
    this.currentFixtureTimeSec = 0;

    // 4. Timeline 以 fixture 的時間範圍為準
    const durationSec = track.frameCount / track.fps;
    this.timeline.setDuration(durationSec);
    this.timeline.setEnabled(true);
    if (this.playBtn) this.playBtn.disabled = false;
    this.updateTimeDisplay(0, durationSec);

    // 5. 立即套用首幀
    this.applyFixtureFrameAtTime(0);

    // 6. 啟用匯出按鈕（Phase 3）
    if (this.exportBtn) this.exportBtn.disabled = false;

    this.setStatus(
      `Fixture 已載入：${track.frameCount} 幀 @ ${track.fps}fps（${formatTime(durationSec)}）`,
    );
  };

  // ── TopBar 事件：匯出 .vrma（Phase 3） ──

  private readonly onExportClick = async (): Promise<void> => {
    if (this.disposed || this.mocapFrames.length === 0) {
      this.setStatus('無動捕資料可匯出');
      return;
    }
    this.setStatus('匯出 .vrma...');
    const metaVersion = this.previewPanel?.getVrmMetaVersion() ?? null;
    let bytes: Uint8Array;
    try {
      bytes = exportMocapToVrma(this.mocapFrames, {
        generator: 'virtual-assistant-desktop mocap studio',
        animationName: 'mocap',
        sourceMetaVersion: metaVersion,
      });
    } catch (e) {
      console.warn('[MocapStudioApp] exportMocapToVrma failed:', e);
      this.setStatus(`匯出失敗：${(e as Error).message}`);
      return;
    }
    const suggestedName = `mocap_${timestampForFilename()}.vrma`;
    const savedPath = await ipc.saveVrma(bytes, suggestedName);
    if (this.disposed) return;
    if (!savedPath) {
      this.setStatus('匯出已取消');
      return;
    }
    this.setStatus(`已匯出：${savedPath}（${bytes.byteLength} bytes）`);
  };

  // ── Timeline 事件 ──

  private readonly onTimelineInChange = (inSec: number): void => {
    this.pausePlayback();
    if (this.playbackMode === 'video') {
      this.videoPanel?.seek(inSec);
    } else if (this.playbackMode === 'fixture') {
      this.currentFixtureTimeSec = inSec;
      this.applyFixtureFrameAtTime(inSec);
      this.updateTimeDisplay(inSec, this.getFixtureDurationSec());
    }
  };

  private readonly onTimelineOutChange = (outSec: number): void => {
    this.pausePlayback();
    if (this.playbackMode === 'video') {
      this.videoPanel?.seek(outSec);
    } else if (this.playbackMode === 'fixture') {
      this.currentFixtureTimeSec = outSec;
      this.applyFixtureFrameAtTime(outSec);
      this.updateTimeDisplay(outSec, this.getFixtureDurationSec());
    }
  };

  private readonly onTimelineSeek = (timeSec: number): void => {
    if (this.playbackMode === 'video') {
      this.videoPanel?.seek(timeSec);
    } else if (this.playbackMode === 'fixture') {
      this.currentFixtureTimeSec = timeSec;
      this.applyFixtureFrameAtTime(timeSec);
      this.updateTimeDisplay(timeSec, this.getFixtureDurationSec());
    }
  };

  // ── 播放控制 ──

  private readonly onPlayToggle = (): void => {
    if (this.playbackMode === 'none' || !this.timeline) return;
    if (this.playing) {
      this.pausePlayback();
    } else {
      this.startPlayback();
    }
  };

  private startPlayback(): void {
    if (!this.timeline || !this.playBtn) return;
    const inSec = this.timeline.getIn();
    const outSec = this.timeline.getOut();

    if (this.playbackMode === 'video') {
      if (!this.videoPanel) return;
      const currentTime = this.videoPanel.getCurrentTime();
      if (currentTime < inSec || currentTime >= outSec) {
        this.videoPanel.seek(inSec);
      }
      void this.videoPanel.play();
    } else if (this.playbackMode === 'fixture') {
      if (this.mocapFrames.length === 0) return;
      let startFrom = this.currentFixtureTimeSec;
      if (startFrom < inSec || startFrom >= outSec) {
        startFrom = inSec;
      }
      this.currentFixtureTimeSec = startFrom;
      this.fixturePlaybackFromSec = startFrom;
      this.fixturePlaybackStartMs = performance.now();
      this.fixturePlaybackRaf = requestAnimationFrame(this.fixtureTick);
    } else {
      return;
    }

    this.playing = true;
    this.playBtn.textContent = '⏸ 暫停';
  }

  private pausePlayback(): void {
    if (!this.playBtn) return;
    if (this.playbackMode === 'video') {
      this.videoPanel?.pause();
    } else if (this.playbackMode === 'fixture') {
      if (this.fixturePlaybackRaf !== null) {
        cancelAnimationFrame(this.fixturePlaybackRaf);
        this.fixturePlaybackRaf = null;
      }
    }
    this.playing = false;
    this.playBtn.textContent = '▶ 播放';
  }

  /** 完全停止播放（切換模式前呼叫，重置內部狀態） */
  private stopPlayback(): void {
    this.pausePlayback();
  }

  // ── Video 模式 ──

  private readonly onVideoTimeUpdate = (currentTimeSec: number): void => {
    if (this.playbackMode !== 'video' || !this.timeline || !this.videoPanel) return;
    this.timeline.setPlayhead(currentTimeSec);
    this.updateTimeDisplay(currentTimeSec, this.videoPanel.getDuration());
    if (this.playing) {
      const outSec = this.timeline.getOut();
      if (currentTimeSec >= outSec) {
        this.pausePlayback();
        this.videoPanel.seek(outSec);
      }
    }
    // Phase 5a：若處於持續偵測模式，播放中每幀跑 MediaPipe（inflight 防堆疊）
    void this.maybeDetectAndDraw();
  };

  // ── Fixture 模式 ──

  /** fixture 總長度（秒） */
  private getFixtureDurationSec(): number {
    if (this.mocapFrames.length === 0) return 0;
    return this.mocapFrames.length / this.fixtureFps;
  }

  /**
   * fixture 播放 rAF tick：推進時間、套用該時間對應的 MocapFrame
   * 到達 out 把手自動暫停
   */
  private readonly fixtureTick = (nowMs: number): void => {
    if (!this.playing || this.playbackMode !== 'fixture' || !this.timeline) {
      this.fixturePlaybackRaf = null;
      return;
    }
    const elapsedSec = (nowMs - this.fixturePlaybackStartMs) / 1000;
    const currentSec = this.fixturePlaybackFromSec + elapsedSec;
    const outSec = this.timeline.getOut();

    if (currentSec >= outSec) {
      this.currentFixtureTimeSec = outSec;
      this.applyFixtureFrameAtTime(outSec);
      this.timeline.setPlayhead(outSec);
      this.updateTimeDisplay(outSec, this.getFixtureDurationSec());
      this.pausePlayback();
      return;
    }

    this.currentFixtureTimeSec = currentSec;
    this.applyFixtureFrameAtTime(currentSec);
    this.timeline.setPlayhead(currentSec);
    this.updateTimeDisplay(currentSec, this.getFixtureDurationSec());
    this.fixturePlaybackRaf = requestAnimationFrame(this.fixtureTick);
  };

  /**
   * 將時間（秒）對應到最近的 MocapFrame 並套用到 VRM 預覽
   *
   * 簡單採用「nearest frame」查表（不做插值），Phase 3+ 視需要升級。
   */
  private applyFixtureFrameAtTime(sec: number): void {
    if (!this.previewPanel || this.mocapFrames.length === 0) return;
    const rawIdx = Math.round(sec * this.fixtureFps);
    const idx = Math.max(0, Math.min(this.mocapFrames.length - 1, rawIdx));
    this.previewPanel.applyMocapFrame(this.mocapFrames[idx]);
  }

  // ── Helpers ──

  private updateTimeDisplay(currentSec: number, totalSec: number): void {
    if (!this.timeDisplayEl) return;
    this.timeDisplayEl.textContent = `${formatTime(currentSec)} / ${formatTime(totalSec)}`;
  }

  private setStatus(text: string): void {
    if (this.statusEl) this.statusEl.textContent = text;
  }

  private readonly onResize = (): void => {
    if (this.timeline) this.timeline.handleResize();
    // Overlay canvas 尺寸要跟著視窗大小變化
    if (this.videoPanel) {
      this.videoPanel.syncOverlaySize();
      if (this.lastLandmarks) this.drawPoseOverlay();
    }
  };

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.fixturePlaybackRaf !== null) {
      cancelAnimationFrame(this.fixturePlaybackRaf);
      this.fixturePlaybackRaf = null;
    }
    if (this.poseRunner) {
      this.poseRunner.dispose();
      this.poseRunner = null;
    }
    // Remove 'seeked' listener from video element
    if (this.videoPanel) {
      this.videoPanel.getVideoElement().removeEventListener('seeked', this.onVideoSeeked);
    }
    window.removeEventListener('resize', this.onResize);
    if (this.playBtn) this.playBtn.removeEventListener('click', this.onPlayToggle);
    if (this.exportBtn) this.exportBtn.removeEventListener('click', this.onExportClick);
    if (this.topBar) {
      this.topBar.dispose();
      this.topBar = null;
    }
    if (this.timeline) {
      this.timeline.dispose();
      this.timeline = null;
    }
    if (this.videoPanel) {
      this.videoPanel.dispose();
      this.videoPanel = null;
    }
    if (this.previewPanel) {
      this.previewPanel.dispose();
      this.previewPanel = null;
    }
  }
}

function basename(p: string): string {
  const idx = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
  return idx >= 0 ? p.slice(idx + 1) : p;
}

/** 產生檔名用的時間戳記（YYYYMMDD_HHmmss） */
function timestampForFilename(): string {
  const d = new Date();
  const pad = (n: number): string => n.toString().padStart(2, '0');
  return (
    `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}` +
    `_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
  );
}
