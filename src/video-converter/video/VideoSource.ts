/**
 * 影片動作轉換器 — VideoSource
 *
 * 封裝 HTMLVideoElement 的載入、播放、seek 與逐幀回呼。
 *
 * 對應計畫：video-converter-plan.md 第 2.2 節
 *
 * 設計重點：
 *   - loadFile 接受 local-file:// URL 或 blob: URL（呼叫端負責組路徑）
 *   - onFrame 用 requestVideoFrameCallback（如可用）取得影片時間戳，
 *     比 RAF + currentTime 更準確；fallback 為 RAF
 *   - seekTo 回傳 Promise，等待 'seeked' 事件確認 seek 完成
 */

export interface VideoFrameInfo {
  /** performance.now() 時間戳（毫秒） */
  performanceNow: number;
  /** 影片內時間戳（毫秒） */
  videoTimestampMs: number;
}

export class VideoSource {
  private videoEl: HTMLVideoElement;
  private currentUrl: string | null = null;
  /** 是否擁有 currentUrl 對應的 ObjectURL（dispose 時需 revoke） */
  private ownsObjectUrl = false;
  private frameCallbacks = new Set<(info: VideoFrameInfo) => void>();
  private rafHandle: number | null = null;
  private frameLoopActive = false;

  constructor(videoEl: HTMLVideoElement) {
    this.videoEl = videoEl;
  }

  get element(): HTMLVideoElement {
    return this.videoEl;
  }

  get duration(): number {
    return Number.isFinite(this.videoEl.duration) ? this.videoEl.duration : 0;
  }

  get currentTime(): number {
    return this.videoEl.currentTime;
  }

  get isPlaying(): boolean {
    return !this.videoEl.paused && !this.videoEl.ended;
  }

  get videoWidth(): number {
    return this.videoEl.videoWidth;
  }

  get videoHeight(): number {
    return this.videoEl.videoHeight;
  }

  /**
   * MediaPipe 不需要精準的 fps，但 CaptureBuffer.finalize 與 .vad.json
   * 需要一個標稱值。HTMLVideoElement 不直接暴露 fps；用粗估：
   *   - 若有 webkitDecodedFrameCount + currentTime → 推算
   *   - 否則回 30
   */
  get nominalFps(): number {
    const v = this.videoEl as HTMLVideoElement & { webkitDecodedFrameCount?: number };
    if (v.webkitDecodedFrameCount && v.currentTime > 0) {
      return v.webkitDecodedFrameCount / v.currentTime;
    }
    return 30;
  }

  /**
   * 載入影片 URL（local-file:// 或 blob:）。
   *
   * 等待 loadedmetadata 後 resolve。
   */
  async loadUrl(url: string, ownsObjectUrl = false): Promise<void> {
    // 釋放舊的 ObjectURL（若有）
    if (this.currentUrl && this.ownsObjectUrl) {
      URL.revokeObjectURL(this.currentUrl);
    }
    this.currentUrl = url;
    this.ownsObjectUrl = ownsObjectUrl;

    return new Promise((resolve, reject) => {
      const onLoaded = (): void => {
        this.videoEl.removeEventListener('loadedmetadata', onLoaded);
        this.videoEl.removeEventListener('error', onError);
        resolve();
      };
      const onError = (): void => {
        this.videoEl.removeEventListener('loadedmetadata', onLoaded);
        this.videoEl.removeEventListener('error', onError);
        reject(new Error(`Video load error: ${this.videoEl.error?.message ?? 'unknown'}`));
      };
      this.videoEl.addEventListener('loadedmetadata', onLoaded);
      this.videoEl.addEventListener('error', onError);
      this.videoEl.src = url;
      this.videoEl.load();
    });
  }

  /** 從 File 物件載入（透過 createObjectURL；dispose 時自動 revoke） */
  async loadFile(file: File): Promise<void> {
    const url = URL.createObjectURL(file);
    await this.loadUrl(url, true);
  }

  async play(): Promise<void> {
    await this.videoEl.play();
  }

  pause(): void {
    this.videoEl.pause();
  }

  /**
   * Seek 到指定秒數，等待 'seeked' 事件確認完成。
   */
  async seekTo(t: number): Promise<void> {
    return new Promise((resolve) => {
      const onSeeked = (): void => {
        this.videoEl.removeEventListener('seeked', onSeeked);
        resolve();
      };
      this.videoEl.addEventListener('seeked', onSeeked);
      this.videoEl.currentTime = t;
    });
  }

  /**
   * 註冊逐幀回呼。傳回的 unsubscribe 函式可解除註冊。
   *
   * 內部使用 requestVideoFrameCallback（可用時）或 requestAnimationFrame
   * fallback。播放停止時自動暫停回呼，play() 後自動恢復。
   */
  onFrame(cb: (info: VideoFrameInfo) => void): () => void {
    this.frameCallbacks.add(cb);
    if (!this.frameLoopActive) {
      this.frameLoopActive = true;
      this.startFrameLoop();
    }
    return () => {
      this.frameCallbacks.delete(cb);
      if (this.frameCallbacks.size === 0) {
        this.frameLoopActive = false;
        this.stopFrameLoop();
      }
    };
  }

  private startFrameLoop(): void {
    type RvfcVideoEl = HTMLVideoElement & {
      requestVideoFrameCallback?: (
        cb: (now: number, metadata: { mediaTime: number }) => void
      ) => number;
    };
    const v = this.videoEl as RvfcVideoEl;

    if (v.requestVideoFrameCallback) {
      const tick = (now: number, metadata: { mediaTime: number }): void => {
        if (!this.frameLoopActive) return;
        const info: VideoFrameInfo = {
          performanceNow: now,
          videoTimestampMs: metadata.mediaTime * 1000,
        };
        for (const cb of this.frameCallbacks) cb(info);
        v.requestVideoFrameCallback!(tick);
      };
      v.requestVideoFrameCallback(tick);
    } else {
      const rafTick = (): void => {
        if (!this.frameLoopActive) return;
        const info: VideoFrameInfo = {
          performanceNow: performance.now(),
          videoTimestampMs: this.videoEl.currentTime * 1000,
        };
        for (const cb of this.frameCallbacks) cb(info);
        this.rafHandle = requestAnimationFrame(rafTick);
      };
      this.rafHandle = requestAnimationFrame(rafTick);
    }
  }

  private stopFrameLoop(): void {
    if (this.rafHandle !== null) {
      cancelAnimationFrame(this.rafHandle);
      this.rafHandle = null;
    }
    // requestVideoFrameCallback 沒有 cancel API，靠 frameLoopActive flag 攔截
  }

  dispose(): void {
    this.frameCallbacks.clear();
    this.frameLoopActive = false;
    this.stopFrameLoop();
    if (this.currentUrl && this.ownsObjectUrl) {
      URL.revokeObjectURL(this.currentUrl);
    }
    this.currentUrl = null;
    this.videoEl.pause();
    this.videoEl.removeAttribute('src');
    this.videoEl.load();
  }
}
