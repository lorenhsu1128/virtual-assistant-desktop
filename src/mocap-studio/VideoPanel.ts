/**
 * 影片動捕工作站 — 影片面板
 *
 * 包裝 HTML5 `<video>` 元素，提供載入、播放控制與時間查詢介面。
 * 不涉及 3D、MediaPipe 或任何動捕邏輯 — 純影片播放抽象。
 *
 * 後續 phase 會加上：
 *   - Phase 5：MediaPipe PoseLandmarker 從 video frame 抽取 33 landmarks
 *   - VideoPanel 本身不變，只在外部加一層 frame 抽樣器
 */

export type TimeUpdateCallback = (currentTimeSec: number) => void;

export class VideoPanel {
  private readonly video: HTMLVideoElement;
  private readonly overlayCanvas: HTMLCanvasElement | null;
  private timeUpdateCallbacks: TimeUpdateCallback[] = [];
  private disposed = false;

  constructor(video: HTMLVideoElement, overlayCanvas: HTMLCanvasElement | null = null) {
    this.video = video;
    this.overlayCanvas = overlayCanvas;
    this.video.addEventListener('timeupdate', this.onTimeUpdate);
  }

  /**
   * 取得 overlay canvas 2D context（若未提供 overlay canvas 則回傳 null）
   *
   * 供 SkeletonDrawer 等 overlay 繪製使用。
   */
  getOverlayContext(): CanvasRenderingContext2D | null {
    if (!this.overlayCanvas) return null;
    return this.overlayCanvas.getContext('2d');
  }

  /** 取得 overlay canvas 尺寸（與 video 播放區實際尺寸同步） */
  getOverlaySize(): { width: number; height: number } {
    if (!this.overlayCanvas) return { width: 0, height: 0 };
    return {
      width: this.overlayCanvas.width,
      height: this.overlayCanvas.height,
    };
  }

  /**
   * 同步 overlay canvas 的像素尺寸到 video 的顯示尺寸
   *
   * 應在載入影片後、視窗 resize 時呼叫。
   */
  syncOverlaySize(): void {
    if (!this.overlayCanvas) return;
    const rect = this.video.getBoundingClientRect();
    const width = Math.floor(rect.width);
    const height = Math.floor(rect.height);
    if (this.overlayCanvas.width !== width) this.overlayCanvas.width = width;
    if (this.overlayCanvas.height !== height) this.overlayCanvas.height = height;
  }

  /** 清空 overlay canvas */
  clearOverlay(): void {
    if (!this.overlayCanvas) return;
    const ctx = this.overlayCanvas.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, this.overlayCanvas.width, this.overlayCanvas.height);
  }

  /** 取得包裝的 <video> 元素（供 MediaPipe detect 直接讀取） */
  getVideoElement(): HTMLVideoElement {
    return this.video;
  }

  /**
   * 載入影片檔案
   *
   * @param url 影片 URL（通常為 `local-file://...`）
   * @returns 成功載入時回傳影片總長度（秒）；失敗回傳 null
   */
  async loadVideo(url: string): Promise<number | null> {
    if (this.disposed) return null;
    return new Promise<number | null>((resolve) => {
      const onLoaded = (): void => {
        cleanup();
        const duration = this.video.duration;
        resolve(Number.isFinite(duration) ? duration : null);
      };
      const onError = (): void => {
        cleanup();
        console.warn('[VideoPanel] video load error for', url);
        resolve(null);
      };
      const cleanup = (): void => {
        this.video.removeEventListener('loadedmetadata', onLoaded);
        this.video.removeEventListener('error', onError);
      };
      this.video.addEventListener('loadedmetadata', onLoaded, { once: true });
      this.video.addEventListener('error', onError, { once: true });
      this.video.src = url;
      this.video.load();
    });
  }

  /** Seek 到指定時間（秒），自動 clamp 到 [0, duration] */
  seek(timeSec: number): void {
    if (this.disposed) return;
    if (!Number.isFinite(timeSec)) return;
    const dur = this.video.duration || 0;
    this.video.currentTime = Math.max(0, Math.min(timeSec, dur));
  }

  /** 開始播放（被瀏覽器拒絕時 log warning 並 resolve） */
  async play(): Promise<void> {
    if (this.disposed) return;
    try {
      await this.video.play();
    } catch (e) {
      console.warn('[VideoPanel] play() failed:', e);
    }
  }

  pause(): void {
    if (this.disposed) return;
    this.video.pause();
  }

  isPaused(): boolean {
    return this.video.paused;
  }

  getCurrentTime(): number {
    return this.video.currentTime;
  }

  getDuration(): number {
    return this.video.duration || 0;
  }

  /** 註冊 timeupdate 回呼（每次影片時間變動時觸發） */
  addTimeUpdateListener(cb: TimeUpdateCallback): void {
    this.timeUpdateCallbacks.push(cb);
  }

  private readonly onTimeUpdate = (): void => {
    const t = this.video.currentTime;
    for (const cb of this.timeUpdateCallbacks) cb(t);
  };

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.video.removeEventListener('timeupdate', this.onTimeUpdate);
    this.video.pause();
    this.video.removeAttribute('src');
    this.video.load();
    this.timeUpdateCallbacks = [];
  }
}
