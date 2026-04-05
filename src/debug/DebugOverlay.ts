/**
 * Debug Overlay
 *
 * 在桌寵視窗上顯示角色狀態資訊和紅虛線外框。
 * 使用 HTML 元素疊加在 canvas 上，不影響 3D 渲染。
 */
export class DebugOverlay {
  private enabled = false;
  private panel: HTMLDivElement | null = null;
  private border: HTMLDivElement | null = null;

  /** 建立 overlay 元素 */
  private createElements(): void {
    if (this.panel) return;

    // 狀態資訊面板（左上角）
    this.panel = document.createElement('div');
    this.panel.style.cssText = `
      position: fixed;
      top: 8px;
      left: 8px;
      background: rgba(0, 0, 0, 0.7);
      color: #0f0;
      font-family: monospace;
      font-size: 12px;
      padding: 8px 12px;
      border-radius: 4px;
      pointer-events: none;
      z-index: 9999;
      white-space: pre;
      line-height: 1.5;
      display: none;
    `;
    document.body.appendChild(this.panel);

    // 紅虛線外框
    this.border = document.createElement('div');
    this.border.style.cssText = `
      position: fixed;
      top: 0;
      left: 0;
      right: 0;
      bottom: 0;
      border: 2px dashed red;
      pointer-events: none;
      z-index: 9998;
      display: none;
    `;
    document.body.appendChild(this.border);
  }

  /** 啟用/停用 debug overlay */
  setEnabled(enabled: boolean): void {
    this.enabled = enabled;

    if (enabled) {
      this.createElements();
    }

    if (this.panel) {
      this.panel.style.display = enabled ? 'block' : 'none';
    }
    if (this.border) {
      this.border.style.display = enabled ? 'block' : 'none';
    }
  }

  /** 是否啟用 */
  isEnabled(): boolean {
    return this.enabled;
  }

  /** 更新狀態資訊 */
  update(info: DebugInfo): void {
    if (!this.enabled || !this.panel) return;

    const lines = [
      `State: ${info.state}`,
      `Pos: (${Math.round(info.posX)}, ${Math.round(info.posY)})`,
      `Scale: ${info.scale.toFixed(2)}`,
      `FPS: ${info.fps.toFixed(0)}`,
      `MoveSpeed: ${info.moveSpeed.toFixed(2)}x`,
      `Paused: ${info.paused ? 'Yes' : 'No'}`,
    ];

    if (info.facingDirection !== undefined) {
      lines.push(`Facing: ${info.facingDirection > 0 ? 'Right' : 'Left'}`);
    }

    this.panel.textContent = lines.join('\n');
  }

  /** 銷毀 overlay 元素 */
  dispose(): void {
    this.panel?.remove();
    this.border?.remove();
    this.panel = null;
    this.border = null;
  }
}

/** Debug 顯示資訊 */
export interface DebugInfo {
  state: string;
  posX: number;
  posY: number;
  scale: number;
  fps: number;
  moveSpeed: number;
  paused: boolean;
  facingDirection?: number;
}
