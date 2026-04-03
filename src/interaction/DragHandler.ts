import type { Rect, WindowRect } from '../types/window';

/** DragHandler 的依賴注入介面 */
export interface DragHandlerDeps {
  getWindowPosition: () => Promise<{ x: number; y: number }>;
  setWindowPosition: (x: number, y: number) => Promise<void>;
  getSnappableWindows: (bounds: Rect, threshold: number) => WindowRect[];
  clampToScreen: (position: { x: number; y: number }, charWidth: number, charHeight: number) => { x: number; y: number };
  getCharacterSize: () => { width: number; height: number };
  onDragStart: () => void;
  onDragEnd: (position: { x: number; y: number }, snappedWindow: WindowRect | null) => void;
}

/** 吸附判定閾值（px） */
const SNAP_THRESHOLD = 20;

/**
 * 拖曳互動處理
 *
 * 處理滑鼠拖曳、邊緣夾限、視窗吸附判定。
 * 透過注入的 callbacks 操作，不直接依賴 Tauri 或其他模組。
 */
export class DragHandler {
  private isDragging = false;
  private positionReady = false;
  private dragStartPos = { x: 0, y: 0 };
  private windowStartPos = { x: 0, y: 0 };
  private deps: DragHandlerDeps;
  private canvas: HTMLCanvasElement;

  // 綁定的事件處理器（用於清理）
  private boundMouseDown: (e: MouseEvent) => void;
  private boundMouseMove: (e: MouseEvent) => void;
  private boundMouseUp: (e: MouseEvent) => void;

  constructor(canvas: HTMLCanvasElement, deps: DragHandlerDeps) {
    this.canvas = canvas;
    this.deps = deps;

    this.boundMouseDown = this.onMouseDown.bind(this);
    this.boundMouseMove = this.onMouseMove.bind(this);
    this.boundMouseUp = this.onMouseUp.bind(this);

    canvas.addEventListener('mousedown', this.boundMouseDown);
    window.addEventListener('mousemove', this.boundMouseMove);
    window.addEventListener('mouseup', this.boundMouseUp);
  }

  /** 銷毀，移除事件監聽 */
  dispose(): void {
    this.canvas.removeEventListener('mousedown', this.boundMouseDown);
    window.removeEventListener('mousemove', this.boundMouseMove);
    window.removeEventListener('mouseup', this.boundMouseUp);
  }

  /** 是否正在拖曳 */
  isDragActive(): boolean {
    return this.isDragging;
  }

  private onMouseDown(e: MouseEvent): void {
    // 只處理左鍵
    if (e.button !== 0) return;

    this.isDragging = true;
    this.positionReady = false;
    this.dragStartPos = { x: e.screenX, y: e.screenY };

    // 取得當前視窗位置（async，mousemove 在解析前會被跳過）
    this.deps.getWindowPosition().then((pos) => {
      this.windowStartPos = pos;
      this.positionReady = true;
    });

    this.deps.onDragStart();
    e.preventDefault();
  }

  private onMouseMove(e: MouseEvent): void {
    if (!this.isDragging || !this.positionReady) return;

    const dx = e.screenX - this.dragStartPos.x;
    const dy = e.screenY - this.dragStartPos.y;

    let newX = this.windowStartPos.x + dx;
    let newY = this.windowStartPos.y + dy;

    // 邊緣夾限（保留 20% 可見）
    const charSize = this.deps.getCharacterSize();
    const clamped = this.deps.clampToScreen({ x: newX, y: newY }, charSize.width, charSize.height);
    newX = clamped.x;
    newY = clamped.y;

    // fire-and-forget，不等待完成
    this.deps.setWindowPosition(newX, newY);
  }

  private onMouseUp(e: MouseEvent): void {
    if (!this.isDragging) return;
    this.isDragging = false;

    const dx = e.screenX - this.dragStartPos.x;
    const dy = e.screenY - this.dragStartPos.y;

    let finalX = this.windowStartPos.x + dx;
    let finalY = this.windowStartPos.y + dy;

    // 邊緣夾限
    const charSize = this.deps.getCharacterSize();
    const clamped = this.deps.clampToScreen({ x: finalX, y: finalY }, charSize.width, charSize.height);
    finalX = clamped.x;
    finalY = clamped.y;

    // 吸附判定
    const characterBounds: Rect = {
      x: finalX,
      y: finalY,
      width: charSize.width,
      height: charSize.height,
    };

    const snappable = this.deps.getSnappableWindows(characterBounds, SNAP_THRESHOLD);

    if (snappable.length > 0) {
      // 吸附到最近的視窗
      const target = snappable[0];
      finalX = target.x + target.width / 2 - charSize.width / 2;
      finalY = target.y - charSize.height;
      this.deps.setWindowPosition(finalX, finalY);
      this.deps.onDragEnd({ x: finalX, y: finalY }, target);
    } else {
      this.deps.setWindowPosition(finalX, finalY);
      this.deps.onDragEnd({ x: finalX, y: finalY }, null);
    }
  }
}
