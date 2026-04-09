/**
 * 影片動捕工作站 — 應用狀態機
 *
 * 組裝所有 UI 元件（TopBar / VideoPanel / Timeline / PreviewPanel）並處理事件流。
 *
 * Phase 0：
 *   - 建立 PreviewPanel 並載入主視窗當前的 VRM
 * Phase 1：
 *   - 載入影片 → 設定時間軸區間 → scrub / 播放控制
 *   - 播放僅在 [in, out] 區間內，播到 out 自動暫停
 *   - 拖曳 in/out 把手時會暫停並 seek 預覽該位置
 *
 * 後續 phase 將擴充：
 *   - Phase 2c：static SMPL fixture → smplToVrm → scrub 套到 VRM 預覽
 *   - Phase 3：VRMA exporter
 *   - Phase 4+：engines（EasyMocap sidecar / HybrIK-TS）
 */

import { ipc } from '../bridge/ElectronIPC';
import { PreviewPanel } from './PreviewPanel';
import { VideoPanel } from './VideoPanel';
import { Timeline, type TimelineElements } from './Timeline';
import { TopBar } from './TopBar';
import { formatTime } from './timelineLogic';

const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`[MocapStudioApp] Missing element: #${id}`);
  return el as T;
};

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

  private videoLoaded = false;
  private playing = false;
  private disposed = false;

  async init(): Promise<void> {
    this.previewHintEl = $<HTMLDivElement>('mocap-preview-hint');
    this.statusEl = $<HTMLSpanElement>('mocap-status');
    this.playBtn = $<HTMLButtonElement>('mocap-play-btn');
    this.timeDisplayEl = $<HTMLSpanElement>('mocap-time-display');

    // ── PreviewPanel（Phase 0） ──
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

    // ── VideoPanel（Phase 1） ──
    const videoEl = $<HTMLVideoElement>('mocap-video-element');
    this.videoPanel = new VideoPanel(videoEl);
    this.videoPanel.addTimeUpdateListener(this.onVideoTimeUpdate);

    // ── Timeline（Phase 1） ──
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

    // ── TopBar（Phase 1） ──
    this.topBar = new TopBar({
      loadVideoBtn: $<HTMLButtonElement>('mocap-load-video-btn'),
    });
    this.topBar.onLoadVideo = this.onLoadVideoClick;

    // 播放按鈕
    this.playBtn.addEventListener('click', this.onPlayToggle);

    // Resize：重新計算 Timeline 位置
    window.addEventListener('resize', this.onResize);
  }

  // ── TopBar 事件 ──

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

    this.videoLoaded = true;
    this.timeline.setDuration(duration);
    this.timeline.setEnabled(true);
    if (this.playBtn) this.playBtn.disabled = false;
    this.updateTimeDisplay(0, duration);
    this.setStatus(`影片已載入：${basename(videoPath)}（${formatTime(duration)}）`);
  };

  // ── Timeline 事件 ──

  private readonly onTimelineInChange = (inSec: number): void => {
    if (!this.videoPanel) return;
    if (this.playing) this.pausePlayback();
    this.videoPanel.seek(inSec);
  };

  private readonly onTimelineOutChange = (outSec: number): void => {
    if (!this.videoPanel) return;
    if (this.playing) this.pausePlayback();
    this.videoPanel.seek(outSec);
  };

  private readonly onTimelineSeek = (timeSec: number): void => {
    if (!this.videoPanel) return;
    this.videoPanel.seek(timeSec);
  };

  // ── 播放控制 ──

  private readonly onPlayToggle = (): void => {
    if (!this.videoLoaded || !this.videoPanel || !this.timeline) return;
    if (this.playing) {
      this.pausePlayback();
    } else {
      this.startPlayback();
    }
  };

  private startPlayback(): void {
    if (!this.videoPanel || !this.timeline || !this.playBtn) return;
    const inSec = this.timeline.getIn();
    const outSec = this.timeline.getOut();
    const currentTime = this.videoPanel.getCurrentTime();
    // 若目前時間不在 [in, out] 區間內，先 reset 到 in
    if (currentTime < inSec || currentTime >= outSec) {
      this.videoPanel.seek(inSec);
    }
    void this.videoPanel.play();
    this.playing = true;
    this.playBtn.textContent = '⏸ 暫停';
  }

  private pausePlayback(): void {
    if (!this.videoPanel || !this.playBtn) return;
    this.videoPanel.pause();
    this.playing = false;
    this.playBtn.textContent = '▶ 播放';
  }

  // ── VideoPanel 事件 ──

  private readonly onVideoTimeUpdate = (currentTimeSec: number): void => {
    if (!this.timeline || !this.videoPanel) return;
    this.timeline.setPlayhead(currentTimeSec);
    this.updateTimeDisplay(currentTimeSec, this.videoPanel.getDuration());
    // 播放到 out 把手 → 自動暫停並停在 out 位置
    if (this.playing) {
      const outSec = this.timeline.getOut();
      if (currentTimeSec >= outSec) {
        this.pausePlayback();
        this.videoPanel.seek(outSec);
      }
    }
  };

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
  };

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    window.removeEventListener('resize', this.onResize);
    if (this.playBtn) this.playBtn.removeEventListener('click', this.onPlayToggle);
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
