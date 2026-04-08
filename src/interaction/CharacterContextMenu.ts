/**
 * 角色右鍵選單（v0.3.x 雛形 — 測試用假資料）
 *
 * 在游標位於角色身上時按右鍵，顯示自訂選單。
 * 透明區域的右鍵事件由 Electron `setIgnoreMouseEvents` 穿透到桌面，
 * 故此模組不需要額外的命中判定 — HitTestManager 已處理。
 *
 * 設計原則：
 *  - 純 renderer 層 DOM 元件，不呼叫 IPC
 *  - 自包含：style 與 DOM 建立都在建構子內，不污染 index.html
 *  - 選單項目定義可替換（供未來接真資料用），目前硬編碼測試資料
 */

/** 單一選單項目定義 */
export interface MenuItem {
  /** 唯一識別，點擊時 callback 會收到此 id */
  id: string;
  /** 顯示文字 */
  label: string;
  /** 項目左側圖示（emoji 或短文字） */
  icon?: string;
  /** 是否為分隔線（分隔線時忽略 label / icon） */
  separator?: boolean;
}

/** 預設測試用假資料 */
export const DEFAULT_FAKE_ITEMS: MenuItem[] = [
  { id: 'greet', icon: '👋', label: '打招呼' },
  { id: 'talk', icon: '💬', label: '對我說話' },
  { id: 'expression', icon: '🎭', label: '表情' },
  { id: 'action', icon: '🎬', label: '動作' },
  { id: 'sep1', separator: true, label: '' },
  { id: 'settings', icon: '⚙️', label: '設定（測試）' },
  { id: 'close', icon: '✖', label: '關閉選單' },
];

/** 夾限座標所需的尺寸資訊 */
export interface ViewportSize {
  width: number;
  height: number;
}

/**
 * 計算選單顯示座標，避免超出視窗邊界（純函式，便於單元測試）
 *
 * 預設策略：
 *  - 若右下方空間足夠 → 直接用 (x, y)
 *  - 右側不夠 → 往左對齊（x - menuWidth）
 *  - 下方不夠 → 往上對齊（y - menuHeight）
 *  - 最後 clamp 在 [margin, viewport - menuSize - margin]
 */
export function clampMenuPosition(
  mouse: { x: number; y: number },
  menuSize: { width: number; height: number },
  viewport: ViewportSize,
  margin = 4,
): { x: number; y: number } {
  let x = mouse.x;
  let y = mouse.y;

  if (x + menuSize.width + margin > viewport.width) {
    x = mouse.x - menuSize.width;
  }
  if (y + menuSize.height + margin > viewport.height) {
    y = mouse.y - menuSize.height;
  }

  // 最終夾限
  const maxX = Math.max(margin, viewport.width - menuSize.width - margin);
  const maxY = Math.max(margin, viewport.height - menuSize.height - margin);
  if (x < margin) x = margin;
  if (y < margin) y = margin;
  if (x > maxX) x = maxX;
  if (y > maxY) y = maxY;

  return { x, y };
}

/** 選單 CSS（注入 <style> 供選單使用） */
const MENU_CSS = `
#character-context-menu {
  position: fixed;
  min-width: 180px;
  padding: 6px 0;
  background: rgba(30, 30, 46, 0.95);
  color: #cdd6f4;
  font-family: 'Segoe UI', 'Microsoft JhengHei', sans-serif;
  font-size: 13px;
  border: 1px solid rgba(203, 166, 247, 0.35);
  border-radius: 8px;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.5);
  z-index: 9999;
  user-select: none;
  display: none;
  backdrop-filter: blur(6px);
}
#character-context-menu.visible {
  display: block;
}
#character-context-menu .menu-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 14px;
  cursor: pointer;
  transition: background 0.1s ease;
}
#character-context-menu .menu-item:hover {
  background: rgba(203, 166, 247, 0.2);
}
#character-context-menu .menu-icon {
  width: 18px;
  text-align: center;
  font-size: 14px;
}
#character-context-menu .menu-separator {
  height: 1px;
  margin: 4px 8px;
  background: rgba(203, 166, 247, 0.25);
}
`;

/** 點擊選單項目的 callback 型別 */
export type ContextMenuCallback = (id: string) => void;

/**
 * 角色右鍵選單 DOM 元件
 *
 * 使用方式：
 * ```ts
 * const menu = new CharacterContextMenu();
 * menu.setOnSelect((id) => console.log('clicked:', id));
 * // ... 右鍵事件自動觸發
 * menu.dispose(); // 清理
 * ```
 */
export class CharacterContextMenu {
  private rootEl: HTMLDivElement;
  private styleEl: HTMLStyleElement;
  private items: MenuItem[];
  private onSelect: ContextMenuCallback | null = null;
  private visible = false;

  // 綁定事件（用於清理）
  private boundContextMenu: (e: MouseEvent) => void;
  private boundWindowClick: (e: MouseEvent) => void;
  private boundKeyDown: (e: KeyboardEvent) => void;
  private boundBlur: () => void;

  constructor(items: MenuItem[] = DEFAULT_FAKE_ITEMS) {
    this.items = items;

    // 注入 CSS（若已存在則共用）
    const existingStyle = document.getElementById('character-context-menu-style');
    if (existingStyle) {
      this.styleEl = existingStyle as HTMLStyleElement;
    } else {
      this.styleEl = document.createElement('style');
      this.styleEl.id = 'character-context-menu-style';
      this.styleEl.textContent = MENU_CSS;
      document.head.appendChild(this.styleEl);
    }

    // 建立根元素
    this.rootEl = document.createElement('div');
    this.rootEl.id = 'character-context-menu';
    this.rootEl.setAttribute('role', 'menu');
    this.renderItems();
    document.body.appendChild(this.rootEl);

    // 綁定事件
    this.boundContextMenu = this.onContextMenu.bind(this);
    this.boundWindowClick = this.onWindowClick.bind(this);
    this.boundKeyDown = this.onKeyDown.bind(this);
    this.boundBlur = this.hide.bind(this);

    window.addEventListener('contextmenu', this.boundContextMenu);
    window.addEventListener('mousedown', this.boundWindowClick, true);
    window.addEventListener('keydown', this.boundKeyDown);
    window.addEventListener('blur', this.boundBlur);
  }

  /** 設定選單項目點擊 callback */
  setOnSelect(callback: ContextMenuCallback | null): void {
    this.onSelect = callback;
  }

  /** 替換選單項目（供動態資料使用） */
  setItems(items: MenuItem[]): void {
    this.items = items;
    this.renderItems();
  }

  /** 是否可見 */
  isVisible(): boolean {
    return this.visible;
  }

  /**
   * 顯示選單於指定座標（自動夾限避免超出視窗）
   */
  show(clientX: number, clientY: number): void {
    // 先顯示取得實際尺寸才能做夾限
    this.rootEl.classList.add('visible');
    this.rootEl.style.left = '0px';
    this.rootEl.style.top = '0px';

    const rect = this.rootEl.getBoundingClientRect();
    const pos = clampMenuPosition(
      { x: clientX, y: clientY },
      { width: rect.width, height: rect.height },
      { width: window.innerWidth, height: window.innerHeight },
    );
    this.rootEl.style.left = `${pos.x}px`;
    this.rootEl.style.top = `${pos.y}px`;
    this.visible = true;
  }

  /** 隱藏選單 */
  hide(): void {
    if (!this.visible) return;
    this.rootEl.classList.remove('visible');
    this.visible = false;
  }

  /** 銷毀：移除 DOM 與事件監聽 */
  dispose(): void {
    window.removeEventListener('contextmenu', this.boundContextMenu);
    window.removeEventListener('mousedown', this.boundWindowClick, true);
    window.removeEventListener('keydown', this.boundKeyDown);
    window.removeEventListener('blur', this.boundBlur);
    if (this.rootEl.parentNode) {
      this.rootEl.parentNode.removeChild(this.rootEl);
    }
    // 不移除 styleEl（可能被其他實例共用）
  }

  // ── 內部 ──

  private renderItems(): void {
    this.rootEl.innerHTML = '';
    for (const item of this.items) {
      if (item.separator) {
        const sep = document.createElement('div');
        sep.className = 'menu-separator';
        this.rootEl.appendChild(sep);
        continue;
      }
      const row = document.createElement('div');
      row.className = 'menu-item';
      row.dataset.id = item.id;
      row.setAttribute('role', 'menuitem');

      const icon = document.createElement('span');
      icon.className = 'menu-icon';
      icon.textContent = item.icon ?? '';
      row.appendChild(icon);

      const label = document.createElement('span');
      label.className = 'menu-label';
      label.textContent = item.label;
      row.appendChild(label);

      row.addEventListener('click', (e) => {
        e.stopPropagation();
        this.handleItemClick(item.id);
      });
      this.rootEl.appendChild(row);
    }
  }

  private handleItemClick(id: string): void {
    // 測試階段：log 點擊行為
    console.log('[CharacterContextMenu] clicked:', id);
    this.hide();
    this.onSelect?.(id);
  }

  private onContextMenu(e: MouseEvent): void {
    // 由 HitTestManager 負責透明穿透，此事件只會在游標位於角色上時觸發
    e.preventDefault();
    this.show(e.clientX, e.clientY);
  }

  private onWindowClick(e: MouseEvent): void {
    if (!this.visible) return;
    // 點在選單內不關閉（由選單項目自身的 click handler 處理）
    if (e.target instanceof Node && this.rootEl.contains(e.target)) {
      return;
    }
    this.hide();
  }

  private onKeyDown(e: KeyboardEvent): void {
    if (e.key === 'Escape') this.hide();
  }
}
