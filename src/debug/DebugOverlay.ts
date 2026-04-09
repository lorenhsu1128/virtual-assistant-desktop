/**
 * Debug Overlay
 *
 * 在桌寵視窗上顯示角色狀態資訊與桌面視窗清單的單一合併面板，
 * 可由使用者拖曳至視窗任意位置（位置儲存於 localStorage）。
 * 使用 HTML 元素疊加在 canvas 上，不影響 3D 渲染。
 */

const STORAGE_KEY = 'debugOverlayPosition';
const DEFAULT_POS = { x: 8, y: 8 };

export class DebugOverlay {
  private enabled = false;
  private panel: HTMLDivElement | null = null;
  private header: HTMLDivElement | null = null;
  private stateSection: HTMLDivElement | null = null;
  private windowsSection: HTMLDivElement | null = null;
  private border: HTMLDivElement | null = null;

  /** 拖曳狀態 */
  private dragging = false;
  private dragOffsetX = 0;
  private dragOffsetY = 0;
  private boundOnMouseMove: (e: MouseEvent) => void;
  private boundOnMouseUp: (e: MouseEvent) => void;

  /** 上次的 mesh 清單（合併顯示在 panel 中） */
  private lastMeshList: MeshListEntry[] = [];

  constructor() {
    this.boundOnMouseMove = this.onMouseMove.bind(this);
    this.boundOnMouseUp = this.onMouseUp.bind(this);
  }

  /** 從 localStorage 讀取儲存位置，失敗時回傳預設 */
  private loadPosition(): { x: number; y: number } {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return { ...DEFAULT_POS };
      const parsed = JSON.parse(raw) as { x: number; y: number };
      if (typeof parsed.x !== 'number' || typeof parsed.y !== 'number') {
        return { ...DEFAULT_POS };
      }
      return parsed;
    } catch {
      return { ...DEFAULT_POS };
    }
  }

  /** 儲存位置到 localStorage，失敗時靜默略過 */
  private savePosition(x: number, y: number): void {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ x, y }));
    } catch {
      // localStorage 不可用時略過
    }
  }

  /** 建立 overlay 元素 */
  private createElements(): void {
    if (this.panel) return;

    const pos = this.loadPosition();

    // 合併面板：header + body(state + windows)
    this.panel = document.createElement('div');
    this.panel.style.cssText = `
      position: fixed;
      top: ${pos.y}px;
      left: ${pos.x}px;
      background: rgba(0, 0, 0, 0.75);
      color: #0f0;
      font-family: monospace;
      font-size: 12px;
      border-radius: 4px;
      pointer-events: auto;
      z-index: 9999;
      display: none;
      max-height: 85vh;
      max-width: 480px;
      overflow: hidden;
      box-shadow: 0 2px 8px rgba(0, 0, 0, 0.4);
      user-select: none;
    `;

    // 標題列（拖曳把手）
    this.header = document.createElement('div');
    this.header.textContent = 'DEBUG ▸ drag to move';
    this.header.style.cssText = `
      padding: 4px 10px;
      background: rgba(0, 180, 0, 0.25);
      color: #cfc;
      font-size: 11px;
      cursor: move;
      border-bottom: 1px solid rgba(0, 255, 0, 0.3);
      border-radius: 4px 4px 0 0;
    `;
    this.header.addEventListener('mousedown', this.onHeaderMouseDown);
    this.panel.appendChild(this.header);

    // body 容器（可捲動）
    const body = document.createElement('div');
    body.style.cssText = `
      padding: 8px 12px;
      max-height: calc(85vh - 28px);
      overflow-y: auto;
      overflow-x: hidden;
    `;

    // 狀態區段
    this.stateSection = document.createElement('div');
    this.stateSection.style.cssText = `
      white-space: pre;
      line-height: 1.5;
      color: #0f0;
    `;
    body.appendChild(this.stateSection);

    // 視窗清單區段
    this.windowsSection = document.createElement('div');
    this.windowsSection.style.cssText = `
      white-space: pre;
      line-height: 1.4;
      color: #0ff;
      font-size: 11px;
      margin-top: 8px;
      padding-top: 8px;
      border-top: 1px dashed rgba(0, 255, 255, 0.3);
    `;
    body.appendChild(this.windowsSection);

    this.panel.appendChild(body);
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

  /** Header mousedown: 啟動拖曳 */
  private onHeaderMouseDown = (e: MouseEvent): void => {
    if (!this.panel) return;
    // 避免觸發 DragHandler 拖曳桌寵
    e.stopPropagation();
    e.preventDefault();

    const rect = this.panel.getBoundingClientRect();
    this.dragOffsetX = e.clientX - rect.left;
    this.dragOffsetY = e.clientY - rect.top;
    this.dragging = true;

    window.addEventListener('mousemove', this.boundOnMouseMove);
    window.addEventListener('mouseup', this.boundOnMouseUp);
  };

  private onMouseMove(e: MouseEvent): void {
    if (!this.dragging || !this.panel) return;

    const panelWidth = this.panel.offsetWidth;
    const panelHeight = this.panel.offsetHeight;
    const maxX = Math.max(0, window.innerWidth - panelWidth);
    const maxY = Math.max(0, window.innerHeight - panelHeight);

    const x = Math.min(maxX, Math.max(0, e.clientX - this.dragOffsetX));
    const y = Math.min(maxY, Math.max(0, e.clientY - this.dragOffsetY));

    this.panel.style.left = `${x}px`;
    this.panel.style.top = `${y}px`;
  }

  private onMouseUp = (): void => {
    if (!this.dragging || !this.panel) return;
    this.dragging = false;
    window.removeEventListener('mousemove', this.boundOnMouseMove);
    window.removeEventListener('mouseup', this.boundOnMouseUp);

    // 儲存最終位置
    const x = parseInt(this.panel.style.left, 10) || 0;
    const y = parseInt(this.panel.style.top, 10) || 0;
    this.savePosition(x, y);
  };

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
    if (!this.enabled || !this.stateSection) return;

    const lines = [
      `State: ${info.state}`,
      `Pos: (${Math.round(info.posX)}, ${Math.round(info.posY)})`,
      `Scale: ${info.scale.toFixed(2)}`,
      `FPS: ${info.fps.toFixed(0)}`,
      `MoveSpeed: ${info.baseMoveSpeed.toFixed(1)} px/s`,
      `Multiplier: ${info.moveSpeedMultiplier.toFixed(2)}x`,
      `Paused: ${info.paused ? 'Yes' : 'No'}`,
      `OffScreen: ${info.offScreenDir ?? 'No'} (${((info.offScreenRatio ?? 0) * 100).toFixed(0)}%)`,
      `Occluded: ${(info.occlusionRatio ?? 0) >= 0.8 ? 'YES' : 'No'} (${((info.occlusionRatio ?? 0) * 100).toFixed(0)}%)`,
    ];

    if (info.currentAnimation) {
      lines.push(`Anim: ${info.currentAnimation}`);
    }

    if (info.stepLength !== undefined && info.stepLength > 0) {
      const effectiveStep = info.stepLength * info.scale;
      const effectiveSpeed = info.baseMoveSpeed * info.scale * info.moveSpeedMultiplier;
      lines.push(`StepLen: ${info.stepLength.toFixed(3)} (x${info.scale.toFixed(2)}=${effectiveStep.toFixed(3)})`);
      lines.push(`Effective: ${effectiveSpeed.toFixed(1)} px/s`);
    }

    // Mesh 清單
    if (this.lastMeshList.length > 0) {
      lines.push(`--- Meshes (${this.lastMeshList.length}) ---`);
      for (const m of this.lastMeshList) {
        const pos = `(${m.x.toFixed(2)}, ${m.y.toFixed(2)}, ${m.z.toFixed(2)})`;
        lines.push(`  ${m.name} ${pos} ${m.visible ? '' : '[hidden]'}`);
      }
    }

    // 遮擋系統資訊
    if (info.characterZ !== undefined || (info.occlusionMeshes && info.occlusionMeshes.length > 0)) {
      lines.push(`--- Occlusion ---`);
      if (info.characterZ !== undefined) {
        lines.push(`CharZ: ${info.characterZ.toFixed(2)}`);
      }
      if (info.occlusionMeshes && info.occlusionMeshes.length > 0) {
        lines.push(`Meshes (${info.occlusionMeshes.length}):`);
        for (const m of info.occlusionMeshes.slice(0, 10)) {
          const title = m.title.length > 20 ? m.title.substring(0, 17) + '...' : m.title;
          lines.push(`  z=${m.meshZ.toFixed(1)} ${String(m.width).padStart(5)}x${String(m.height).padEnd(5)} ${title}`);
        }
        if (info.occlusionMeshes.length > 10) {
          lines.push(`  ... +${info.occlusionMeshes.length - 10} more`);
        }
      }
    }

    // 可站立平面清單
    if (info.platforms && info.platforms.length > 0) {
      lines.push(`--- Platforms (${info.platforms.length}) ---`);
      for (const p of info.platforms.slice(0, 10)) {
        const label = p.id.length > 25 ? p.id.substring(0, 22) + '...' : p.id;
        lines.push(`  y=${Math.round(p.screenY)} w=${Math.round(p.width)} ${label}`);
      }
      if (info.platforms.length > 10) {
        lines.push(`  ... +${info.platforms.length - 10} more`);
      }
    }

    this.stateSection.textContent = lines.join('\n');
  }

  /** 更新桌面視窗清單 */
  updateWindowList(windows: WindowListEntry[]): void {
    if (!this.enabled || !this.windowsSection) return;

    if (windows.length === 0) {
      this.windowsSection.textContent = '-- No windows --';
      return;
    }

    const header = `Desktop Windows (${windows.length})`;
    const separator = '-'.repeat(50);
    const rows = windows.slice(0, 15).map((w, i) => {
      const title = w.title.length > 25 ? w.title.substring(0, 22) + '...' : w.title;
      return `${String(i + 1).padStart(2)}. z=${String(w.zOrder).padStart(3)} ${String(w.width).padStart(5)}x${String(w.height).padEnd(5)} ${title}`;
    });

    if (windows.length > 15) {
      rows.push(`   ... +${windows.length - 15} more`);
    }

    this.windowsSection.textContent = [header, separator, ...rows].join('\n');
  }

  /** 更新場景 mesh 清單 */
  updateMeshList(meshes: MeshListEntry[]): void {
    if (!this.enabled || !this.stateSection) return;
    this.lastMeshList = meshes;
  }

  /** 銷毀 overlay 元素 */
  dispose(): void {
    // 清除可能殘留的拖曳 listener
    window.removeEventListener('mousemove', this.boundOnMouseMove);
    window.removeEventListener('mouseup', this.boundOnMouseUp);
    if (this.header) {
      this.header.removeEventListener('mousedown', this.onHeaderMouseDown);
    }

    this.panel?.remove();
    this.border?.remove();
    this.panel = null;
    this.header = null;
    this.stateSection = null;
    this.windowsSection = null;
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
  /** 基礎移動速度（px/s，scale=1） */
  baseMoveSpeed: number;
  /** 速率倍率 */
  moveSpeedMultiplier: number;
  paused: boolean;
  /** 步伐長度（世界單位，scale=1 基準） */
  stepLength?: number;
  /** 當前播放的動畫名稱 */
  currentAnimation?: string;
  /** 角色當前 Z 深度 */
  characterZ?: number;
  /** 角色超出螢幕方向（null=在螢幕內，'LEFT'/'RIGHT'/'TOP'/'BOTTOM' 或組合） */
  offScreenDir?: string | null;
  /** 角色超出螢幕的面積比率（0~1） */
  offScreenRatio?: number;
  /** 角色被視窗覆蓋的最大比率（0~1） */
  occlusionRatio?: number;
  /** 遮擋 mesh 清單 */
  occlusionMeshes?: OcclusionDebugEntry[];
  /** 可站立平面清單 */
  platforms?: PlatformDebugEntry[];
}

/** Platform debug 條目 */
export interface PlatformDebugEntry {
  id: string;
  screenY: number;
  width: number;
}

/** 遮擋 mesh debug 條目 */
export interface OcclusionDebugEntry {
  title: string;
  width: number;
  height: number;
  meshZ: number;
}

/** 視窗清單條目 */
export interface WindowListEntry {
  title: string;
  zOrder: number;
  width: number;
  height: number;
}

/** Mesh 清單條目 */
export interface MeshListEntry {
  name: string;
  x: number;
  y: number;
  z: number;
  visible: boolean;
}
