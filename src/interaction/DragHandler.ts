/** DragHandler 的依賴注入介面 */
export interface DragHandlerDeps {
  /** 取得角色目前位置（同步，螢幕座標） */
  getCharacterPosition: () => { x: number; y: number };
  getCharacterSize: () => { width: number; height: number };
  onDragStart: () => void;
  onDragEnd: (position: { x: number; y: number }) => void;
  onDragMove?: (x: number, y: number) => void;
  onDragLock?: () => void;
  onDragUnlock?: () => void;
}

/**
 * 拖曳互動處理
 *
 * 處理滑鼠拖曳、邊緣夾限、視窗吸附判定。
 * 透過注入的 callbacks 操作，不直接依賴 Tauri 或其他模組。
 */
export class DragHandler {
  private isDragging = false;
  private dragStartPos = { x: 0, y: 0 };
  private charStartPos = { x: 0, y: 0 };
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
    this.dragStartPos = { x: e.screenX, y: e.screenY };
    // 同步取得角色位置（全螢幕模式不需 async IPC）
    this.charStartPos = { ...this.deps.getCharacterPosition() };

    this.deps.onDragLock?.();
    this.deps.onDragStart();
    e.preventDefault();
  }

  private onMouseMove(e: MouseEvent): void {
    if (!this.isDragging) return;

    const dx = e.screenX - this.dragStartPos.x;
    const dy = e.screenY - this.dragStartPos.y;

    const newX = this.charStartPos.x + dx;
    const newY = this.charStartPos.y + dy;

    this.deps.onDragMove?.(newX, newY);
  }

  private onMouseUp(e: MouseEvent): void {
    if (!this.isDragging) return;
    this.isDragging = false;
    this.deps.onDragUnlock?.();

    const dx = e.screenX - this.dragStartPos.x;
    const dy = e.screenY - this.dragStartPos.y;

    const finalX = this.charStartPos.x + dx;
    const finalY = this.charStartPos.y + dy;

    this.deps.onDragEnd({ x: finalX, y: finalY });
  }
}
