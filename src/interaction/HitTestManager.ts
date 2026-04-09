import type * as THREE from 'three';

/** HitTestManager 的依賴注入介面 */
export interface HitTestDeps {
  setIgnoreCursorEvents: (ignore: boolean) => Promise<void>;
}

/**
 * 動態滑鼠穿透管理
 *
 * 透過 WebGL readPixels 偵測滑鼠位置下是否有角色像素，
 * 動態切換 Electron 的 setIgnoreMouseEvents 實現精確點擊穿透。
 * 透明區域的滑鼠事件穿透到後方視窗，角色身上的像素可正常互動。
 */
export class HitTestManager {
  private canvas: HTMLCanvasElement;
  private gl: WebGLRenderingContext | null = null;
  private deps: HitTestDeps;
  private isIgnoring = false;
  private isDragLocked = false;
  private forceInteractive = false;
  private pixel = new Uint8Array(4);
  private ready = false;

  private boundMouseMove: (e: MouseEvent) => void;

  constructor(canvas: HTMLCanvasElement, renderer: THREE.WebGLRenderer, deps: HitTestDeps) {
    this.canvas = canvas;
    this.deps = deps;

    try {
      const ctx = renderer.getContext();
      this.gl = ctx as WebGLRenderingContext;
    } catch (e) {
      console.warn('[HitTestManager] Failed to get WebGL context:', e);
    }

    // 預設穿透
    this.isIgnoring = true;
    this.deps.setIgnoreCursorEvents(true);

    this.boundMouseMove = this.onMouseMove.bind(this);
    window.addEventListener('mousemove', this.boundMouseMove);

    // 延遲啟用，等待第一幀渲染完成
    requestAnimationFrame(() => {
      this.ready = true;
    });
  }

  /** 拖曳開始時鎖定為不穿透 */
  lockForDrag(): void {
    this.isDragLocked = true;
    if (this.isIgnoring) {
      this.isIgnoring = false;
      this.deps.setIgnoreCursorEvents(false);
    }
  }

  /** 拖曳結束時解鎖 */
  unlockDrag(): void {
    this.isDragLocked = false;
  }

  /**
   * 強制整個視窗保持 interactive（不穿透）
   *
   * 用於 Debug overlay 等 HTML 面板場景：HitTestManager 只讀 canvas
   * alpha 判定穿透，DOM 面板蓋在 canvas 透明區域上時會誤判為穿透，
   * 導致點不到面板。啟用此旗標後，onMouseMove 會維持不穿透狀態。
   */
  setForceInteractive(on: boolean): void {
    this.forceInteractive = on;
    if (on && this.isIgnoring) {
      this.isIgnoring = false;
      this.deps.setIgnoreCursorEvents(false);
    }
  }

  /** 銷毀，移除事件監聽 */
  dispose(): void {
    window.removeEventListener('mousemove', this.boundMouseMove);
  }

  private onMouseMove(e: MouseEvent): void {
    // 未就緒或拖曳中不切換
    if (!this.ready || !this.gl || this.isDragLocked) return;

    // 強制互動模式：維持不穿透，完全跳過 alpha 判定
    if (this.forceInteractive) {
      if (this.isIgnoring) {
        this.isIgnoring = false;
        this.deps.setIgnoreCursorEvents(false);
      }
      return;
    }

    try {
      const rect = this.canvas.getBoundingClientRect();
      const mouseX = e.clientX - rect.left;
      const mouseY = e.clientY - rect.top;

      // 超出 canvas 範圍 → 穿透
      if (mouseX < 0 || mouseY < 0 || mouseX >= rect.width || mouseY >= rect.height) {
        if (!this.isIgnoring) {
          this.isIgnoring = true;
          this.deps.setIgnoreCursorEvents(true);
        }
        return;
      }

      // 轉換為 WebGL 像素座標（Y 軸翻轉 + DPI 縮放）
      const dpr = window.devicePixelRatio;
      const glX = Math.floor(mouseX * dpr);
      const glY = Math.floor((rect.height - mouseY) * dpr);

      // 讀取單一像素的 alpha 值
      this.gl.readPixels(glX, glY, 1, 1, this.gl.RGBA, this.gl.UNSIGNED_BYTE, this.pixel);
      const alpha = this.pixel[3];

      const shouldIgnore = alpha === 0;

      if (shouldIgnore !== this.isIgnoring) {
        this.isIgnoring = shouldIgnore;
        this.deps.setIgnoreCursorEvents(shouldIgnore);
      }
    } catch (e) {
      // readPixels 失敗時不中斷，保持當前狀態
      console.warn('[HitTestManager] readPixels error:', e);
    }
  }
}
