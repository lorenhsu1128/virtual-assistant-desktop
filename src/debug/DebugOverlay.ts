/** 單一骨骼的 debug 資料 */
export interface BoneDebugData {
  boneName: string;
  world: { x: number; y: number; z: number } | null;
  screen: { x: number; y: number } | null;
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
  private dots: Map<string, HTMLElement> = new Map();
  private enabled = false;

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

  /** 銷毀 overlay */
  dispose(): void {
    this.container.remove();
    this.dots.clear();
  }
}
