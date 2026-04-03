/** 單一骨骼的 debug 資料 */
export interface BoneDebugData {
  boneName: string;
  world: { x: number; y: number; z: number } | null;
  screen: { x: number; y: number } | null;
}

/** 視窗 debug 資料（純資料，不 import window.ts） */
export interface WindowDebugData {
  title: string;
  x: number;
  y: number;
  width: number;
  height: number;
  zOrder: number;
}

/** 骨骼與視窗邊緣的接觸資料 */
export interface ContactDebugData {
  /** 接觸點在 overlay 上的位置（CSS 像素） */
  x: number;
  y: number;
  /** 接觸的邊緣方向：水平線或垂直線 */
  direction: 'horizontal' | 'vertical';
}

/** 骨骼標籤與顏色對應 */
const BONE_STYLE: Record<string, { label: string; color: string }> = {
  leftFoot: { label: 'LF', color: '#3b82f6' },   // 藍
  rightFoot: { label: 'RF', color: '#3b82f6' },   // 藍
  hips: { label: 'H', color: '#f97316' },          // 橙
  leftHand: { label: 'LH', color: '#22c55e' },     // 綠
  rightHand: { label: 'RH', color: '#22c55e' },    // 綠
  head: { label: 'HD', color: '#ef4444' },          // 紅
};

/**
 * Debug 視覺化 Overlay
 *
 * 純 DOM 模組，在 canvas 上方顯示骨骼座標資訊與標記圓點。
 * pointer-events: none 確保不影響滑鼠互動。
 */
export class DebugOverlay {
  private container: HTMLElement;
  private panel: HTMLElement;
  private windowPanel: HTMLElement;
  private dots: Map<string, HTMLElement> = new Map();
  private contactLines: HTMLElement[] = [];
  private windowBoxes: HTMLElement[] = [];
  private enabled = false;
  private dpr = 1;

  constructor() {
    this.container = document.createElement('div');
    this.container.id = 'debug-overlay';
    this.container.style.cssText = `
      position: fixed; top: 0; left: 0; width: 100%; height: 100%;
      pointer-events: none; z-index: 9999; display: none;
      box-sizing: border-box; border: 2px dashed rgba(255, 0, 0, 0.7);
    `;

    // 座標面板
    this.panel = document.createElement('div');
    this.panel.style.cssText = `
      position: absolute; top: 8px; left: 8px;
      background: rgba(0,0,0,0.8); color: #e0e0e0;
      font-family: 'Consolas','Courier New',monospace; font-size: 10px;
      line-height: 1.6; padding: 8px 12px; border-radius: 6px;
      border: 1px solid rgba(255,255,255,0.15); white-space: pre;
      min-width: 260px;
    `;
    this.container.appendChild(this.panel);

    // 視窗清單面板（右上角）
    this.windowPanel = document.createElement('div');
    this.windowPanel.style.cssText = `
      position: absolute; top: 8px; right: 8px;
      background: rgba(0,0,0,0.8); color: #e0e0e0;
      font-family: 'Consolas','Courier New',monospace; font-size: 9px;
      line-height: 1.5; padding: 8px 12px; border-radius: 6px;
      border: 1px solid rgba(255,255,255,0.15); white-space: pre;
      max-height: 80vh; overflow-y: auto; min-width: 300px;
      max-width: 420px;
    `;
    this.container.appendChild(this.windowPanel);

    // 建立骨骼圓點
    for (const [boneName, style] of Object.entries(BONE_STYLE)) {
      const dot = document.createElement('div');
      dot.style.cssText = `
        position: absolute; width: 14px; height: 14px; border-radius: 50%;
        background: ${style.color}; border: 2px solid rgba(255,255,255,0.9);
        transform: translate(-50%,-50%); display: none;
        box-shadow: 0 0 6px ${style.color};
      `;
      const label = document.createElement('span');
      label.textContent = style.label;
      label.style.cssText = `
        position: absolute; top: -14px; left: 50%; transform: translateX(-50%);
        font-family: 'Consolas',monospace; font-size: 9px; font-weight: bold;
        color: ${style.color}; text-shadow: 0 0 3px black, 0 0 3px black;
      `;
      dot.appendChild(label);
      this.dots.set(boneName, dot);
      this.container.appendChild(dot);
    }

    document.body.appendChild(this.container);
  }

  /** 切換 debug overlay 開關 */
  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    this.container.style.display = enabled ? 'block' : 'none';
  }

  /** 取得目前是否啟用 */
  isEnabled(): boolean {
    return this.enabled;
  }

  /**
   * 更新骨骼資料（座標面板 + 圓點位置）
   */
  updateBones(bones: BoneDebugData[]): void {
    if (!this.enabled) return;

    // 更新面板文字
    const lines: string[] = ['=== Bone Debug ==='];
    for (const bone of bones) {
      const style = BONE_STYLE[bone.boneName];
      const tag = style ? style.label : bone.boneName;
      const w = bone.world
        ? `(${bone.world.x.toFixed(2)}, ${bone.world.y.toFixed(2)}, ${bone.world.z.toFixed(2)})`
        : 'N/A';
      const s = bone.screen
        ? `(${Math.round(bone.screen.x)}, ${Math.round(bone.screen.y)})`
        : 'N/A';
      lines.push(`${tag.padEnd(3)} 3D: ${w}`);
      lines.push(`    2D: ${s}`);
    }
    this.panel.textContent = lines.join('\n');

    // 更新圓點位置
    for (const bone of bones) {
      const dot = this.dots.get(bone.boneName);
      if (!dot) continue;

      if (bone.screen) {
        dot.style.display = 'block';
        dot.style.left = `${bone.screen.x}px`;
        dot.style.top = `${bone.screen.y}px`;
      } else {
        dot.style.display = 'none';
      }
    }
  }

  /**
   * 更新桌面視窗清單面板 + 視覺化視窗邊框（含 Z-order）
   *
   * @param mascotPos 桌寵視窗的螢幕位置（邏輯像素），用於座標轉換
   */
  updateWindowList(windows: WindowDebugData[], mascotPos?: { x: number; y: number }): void {
    if (!this.enabled) return;

    this.dpr = window.devicePixelRatio || 1;

    // 更新面板文字（含 Z-order）
    const lines: string[] = [`=== Windows (${windows.length}) ===`];
    for (const w of windows) {
      const title = w.title.length > 28 ? w.title.substring(0, 25) + '...' : w.title;
      lines.push(`[Z${w.zOrder}] ${title}`);
      lines.push(`  x:${w.x} y:${w.y} w:${w.width} h:${w.height}`);
    }
    this.windowPanel.textContent = lines.join('\n');

    // 移除舊的視窗邊框
    for (const box of this.windowBoxes) {
      box.remove();
    }
    this.windowBoxes.length = 0;

    // 畫視窗邊框（轉換為桌寵視窗本地座標）
    if (!mascotPos) return;

    const maxZ = windows.length;
    for (const w of windows) {
      // 物理像素 → 邏輯像素 → 桌寵本地座標
      const localX = w.x / this.dpr - mascotPos.x;
      const localY = w.y / this.dpr - mascotPos.y;
      const localW = w.width / this.dpr;
      const localH = w.height / this.dpr;

      // Z-order 顏色：最上層偏紅，下層偏藍
      const t = maxZ > 1 ? w.zOrder / (maxZ - 1) : 0;
      const r = Math.round(255 * (1 - t));
      const g = Math.round(100 * (1 - t));
      const b = Math.round(255 * t);
      const color = `rgb(${r},${g},${b})`;

      const box = document.createElement('div');
      box.style.cssText = `
        position: absolute;
        left: ${localX}px; top: ${localY}px;
        width: ${localW}px; height: ${localH}px;
        border: 2px solid ${color};
        opacity: 0.6;
        pointer-events: none;
        box-sizing: border-box;
      `;

      // Z-order 標籤
      const label = document.createElement('div');
      label.textContent = `Z${w.zOrder}`;
      label.style.cssText = `
        position: absolute; top: 2px; left: 4px;
        font-family: 'Consolas',monospace; font-size: 10px; font-weight: bold;
        color: ${color}; background: rgba(0,0,0,0.7);
        padding: 1px 4px; border-radius: 3px;
        text-shadow: 0 0 2px black;
      `;
      box.appendChild(label);

      this.container.appendChild(box);
      this.windowBoxes.push(box);
    }
  }

  /**
   * 更新骨骼與視窗邊緣的接觸標示（綠色虛線）
   */
  updateContacts(contacts: ContactDebugData[]): void {
    if (!this.enabled) return;

    // 移除舊的接觸線
    for (const line of this.contactLines) {
      line.remove();
    }
    this.contactLines.length = 0;

    // 建立新的接觸線
    for (const c of contacts) {
      const line = document.createElement('div');
      if (c.direction === 'horizontal') {
        line.style.cssText = `
          position: absolute; left: 0; width: 100%; height: 0;
          top: ${c.y}px;
          border-top: 2px dashed rgba(34, 197, 94, 0.8);
          pointer-events: none;
        `;
      } else {
        line.style.cssText = `
          position: absolute; top: 0; height: 100%; width: 0;
          left: ${c.x}px;
          border-left: 2px dashed rgba(34, 197, 94, 0.8);
          pointer-events: none;
        `;
      }
      // 接觸點圓點標記
      const marker = document.createElement('div');
      marker.style.cssText = `
        position: absolute; width: 8px; height: 8px; border-radius: 50%;
        background: rgba(34, 197, 94, 0.9);
        transform: translate(-50%, -50%);
        left: ${c.x}px; top: ${c.y}px;
        box-shadow: 0 0 6px rgba(34, 197, 94, 0.6);
      `;
      this.container.appendChild(line);
      this.container.appendChild(marker);
      this.contactLines.push(line, marker);
    }
  }

  /** 銷毀 overlay */
  dispose(): void {
    this.container.remove();
    this.dots.clear();
    this.contactLines.length = 0;
  }
}
