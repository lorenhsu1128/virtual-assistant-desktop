import type { AnimationEntry } from '../types/animation';

/** ContextMenu 的依賴注入介面 */
export interface ContextMenuDeps {
  getActionAnimations: () => AnimationEntry[];
  getBlendShapes: () => string[];
  playAnimation: (name: string) => void;
  setExpression: (name: string) => void;
  setScale: (scale: number) => void;
  getCurrentScale: () => number;
  togglePause: () => void;
  isPaused: () => boolean;
  openSettings: () => void;
  isOrbitDragging: () => boolean;
  toggleLoop: () => void;
  isLoopEnabled: () => boolean;
  resetCamera: () => void;
  resetPosition: () => void;
  changeModel: () => void;
  changeAnimationFolder: () => void;
  closeApp: () => void;
  toggleAutoExpression: () => void;
  isAutoExpressionEnabled: () => boolean;
  getManualExpression: () => string | null;
  toggleDebug: () => void;
  isDebugEnabled: () => boolean;
  setAnimationSpeed: (rate: number) => void;
  getAnimationSpeed: () => number;
  expandWindowForMenu: () => Promise<void>;
  restoreWindowFromMenu: () => Promise<void>;
  onMenuOpen?: () => void;
  onMenuClose?: () => void;
}

/** 動畫速率選項 */
const SPEED_OPTIONS = [
  { label: '0.5x', value: 0.5 },
  { label: '0.75x', value: 0.75 },
  { label: '1.0x', value: 1.0 },
  { label: '1.25x', value: 1.25 },
];

/** 縮放選項 */
const SCALE_OPTIONS = [
  { label: '50%', value: 0.5 },
  { label: '75%', value: 0.75 },
  { label: '100%', value: 1.0 },
  { label: '125%', value: 1.25 },
  { label: '150%', value: 1.5 },
  { label: '200%', value: 2.0 },
];

/** 子選單最大顯示項目數（超過啟用捲動） */
const MAX_VISIBLE_ITEMS = 15;

/**
 * 右鍵選單
 *
 * DOM-based 選單，包含動畫/表情/縮放子選單。
 * 透過注入的 callbacks 執行動作，不直接依賴其他模組。
 */
export class ContextMenu {
  private menuElement: HTMLElement | null = null;
  private deps: ContextMenuDeps;
  private canvas: HTMLCanvasElement;
  private pendingMenuPos: { screenX: number; screenY: number } | null = null;

  private boundContextMenu: (e: MouseEvent) => void;
  private boundClickOutside: (e: MouseEvent) => void;

  constructor(canvas: HTMLCanvasElement, deps: ContextMenuDeps) {
    this.canvas = canvas;
    this.deps = deps;

    this.boundContextMenu = this.onContextMenu.bind(this);
    this.boundClickOutside = this.onClickOutside.bind(this);

    canvas.addEventListener('contextmenu', this.boundContextMenu);

    // 注入 CSS
    this.injectStyles();
  }

  /** 銷毀 */
  dispose(): void {
    this.canvas.removeEventListener('contextmenu', this.boundContextMenu);
    document.removeEventListener('click', this.boundClickOutside);
    this.hideMenu();
  }

  private onContextMenu(e: MouseEvent): void {
    e.preventDefault();
    // 右鍵拖曳旋轉攝影機時不開選單
    if (this.deps.isOrbitDragging()) return;

    // 記錄螢幕座標，先擴大視窗再顯示選單
    this.pendingMenuPos = { screenX: e.screenX, screenY: e.screenY };
    this.deps.expandWindowForMenu().then(() => {
      if (this.pendingMenuPos) {
        // 擴大後視窗在 (0,0)，用螢幕座標作為選單位置
        this.showMenu(this.pendingMenuPos.screenX, this.pendingMenuPos.screenY);
        this.pendingMenuPos = null;
      }
    });
  }

  private onClickOutside(e: MouseEvent): void {
    if (this.menuElement && !this.menuElement.contains(e.target as Node)) {
      this.hideMenu();
    }
  }

  private showMenu(x: number, y: number): void {
    this.hideMenu();
    this.deps.onMenuOpen?.();

    const menu = document.createElement('div');
    menu.className = 'ctx-menu';

    // 動畫子選單
    const animations = this.deps.getActionAnimations();
    if (animations.length > 0) {
      menu.appendChild(this.createSubmenuItem('動畫', animations.map((a) => ({
        label: a.displayName,
        onClick: () => this.deps.playAnimation(a.fileName),
      }))));
    }

    // 表情子選單
    const blendShapes = this.deps.getBlendShapes();
    if (blendShapes.length > 0) {
      const currentManual = this.deps.getManualExpression();
      menu.appendChild(this.createSubmenuItem('表情', blendShapes.map((name) => ({
        label: `${name}${name === currentManual ? ' ✓' : ''}`,
        onClick: () => this.deps.setExpression(name),
      }))));
    }

    // 分隔線
    if (animations.length > 0 || blendShapes.length > 0) {
      menu.appendChild(this.createSeparator());
    }

    // 縮放子選單
    const currentScale = this.deps.getCurrentScale();
    menu.appendChild(this.createSubmenuItem('縮放', SCALE_OPTIONS.map((opt) => ({
      label: `${opt.label}${Math.abs(opt.value - currentScale) < 0.01 ? ' ✓' : ''}`,
      onClick: () => this.deps.setScale(opt.value),
    }))));

    // 動畫速率子選單
    const currentSpeed = this.deps.getAnimationSpeed();
    menu.appendChild(this.createSubmenuItem('動畫速率', SPEED_OPTIONS.map((opt) => ({
      label: `${opt.label}${Math.abs(opt.value - currentSpeed) < 0.01 ? ' ✓' : ''}`,
      onClick: () => this.deps.setAnimationSpeed(opt.value),
    }))));

    // 暫停自主移動
    const pauseItem = this.createMenuItem(
      this.deps.isPaused() ? '恢復自主移動' : '暫停自主移動',
      () => this.deps.togglePause(),
    );
    menu.appendChild(pauseItem);

    // 自動表情開關
    menu.appendChild(this.createMenuItem(
      this.deps.isAutoExpressionEnabled() ? '暫停自動表情' : '恢復自動表情',
      () => this.deps.toggleAutoExpression(),
    ));

    // 分隔線
    menu.appendChild(this.createSeparator());

    // 動畫循環開關
    menu.appendChild(this.createMenuItem(
      this.deps.isLoopEnabled() ? '暫停動畫循環' : '恢復動畫循環',
      () => this.deps.toggleLoop(),
    ));

    // 重置鏡頭
    menu.appendChild(this.createMenuItem('重置鏡頭角度', () => this.deps.resetCamera()));
    menu.appendChild(this.createMenuItem('重置回桌面正中央', () => this.deps.resetPosition()));

    // 更換模型/動畫
    menu.appendChild(this.createMenuItem('更換 VRM 模型', () => this.deps.changeModel()));
    menu.appendChild(this.createMenuItem('更換動畫資料夾', () => this.deps.changeAnimationFolder()));

    // 分隔線
    menu.appendChild(this.createSeparator());

    // Debug 模式
    menu.appendChild(this.createMenuItem(
      this.deps.isDebugEnabled() ? 'Debug 模式 ✓' : 'Debug 模式',
      () => this.deps.toggleDebug(),
    ));

    // 設定
    menu.appendChild(this.createMenuItem('設定', () => this.deps.openSettings()));

    // 分隔線
    menu.appendChild(this.createSeparator());

    // 關閉
    menu.appendChild(this.createMenuItem('關閉', () => this.deps.closeApp()));

    // 定位
    menu.style.left = `${x}px`;
    menu.style.top = `${y}px`;

    document.body.appendChild(menu);
    this.menuElement = menu;

    // 確保選單不超出視窗
    const rect = menu.getBoundingClientRect();
    if (rect.right > window.innerWidth) {
      menu.style.left = `${x - rect.width}px`;
    }
    if (rect.bottom > window.innerHeight) {
      menu.style.top = `${y - rect.height}px`;
    }

    // 延遲綁定外部點擊（避免立即觸發）
    requestAnimationFrame(() => {
      document.addEventListener('click', this.boundClickOutside);
    });
  }

  private hideMenu(): void {
    if (this.menuElement) {
      this.menuElement.remove();
      this.menuElement = null;
      this.deps.onMenuClose?.();
      this.deps.restoreWindowFromMenu();
    }
    document.removeEventListener('click', this.boundClickOutside);
  }

  private createMenuItem(label: string, onClick: () => void): HTMLElement {
    const item = document.createElement('div');
    item.className = 'ctx-menu-item';
    item.textContent = label;
    item.addEventListener('click', () => {
      onClick();
      this.hideMenu();
    });
    return item;
  }

  private createSubmenuItem(label: string, items: { label: string; onClick: () => void }[]): HTMLElement {
    const container = document.createElement('div');
    container.className = 'ctx-menu-item ctx-menu-submenu';

    const trigger = document.createElement('span');
    trigger.textContent = `${label} ▸`;
    container.appendChild(trigger);

    const submenu = document.createElement('div');
    submenu.className = 'ctx-submenu';

    // 超過 MAX_VISIBLE_ITEMS 啟用捲動
    if (items.length > MAX_VISIBLE_ITEMS) {
      submenu.style.maxHeight = `${MAX_VISIBLE_ITEMS * 28}px`;
      submenu.style.overflowY = 'auto';
    }

    for (const item of items) {
      const subItem = document.createElement('div');
      subItem.className = 'ctx-menu-item';
      subItem.textContent = item.label;
      subItem.addEventListener('click', (e) => {
        e.stopPropagation();
        item.onClick();
        this.hideMenu();
      });
      submenu.appendChild(subItem);
    }

    container.appendChild(submenu);
    return container;
  }

  private createSeparator(): HTMLElement {
    const sep = document.createElement('div');
    sep.className = 'ctx-menu-separator';
    return sep;
  }

  private injectStyles(): void {
    if (document.getElementById('ctx-menu-styles')) return;

    const style = document.createElement('style');
    style.id = 'ctx-menu-styles';
    style.textContent = `
      .ctx-menu {
        position: fixed;
        z-index: 10000;
        background: rgba(30, 30, 30, 0.95);
        border: 1px solid rgba(255, 255, 255, 0.15);
        border-radius: 8px;
        padding: 4px 0;
        min-width: 160px;
        box-shadow: 0 4px 16px rgba(0, 0, 0, 0.4);
        font-family: 'Segoe UI', sans-serif;
        font-size: 13px;
        color: #e0e0e0;
        backdrop-filter: blur(12px);
      }
      .ctx-menu-item {
        padding: 6px 16px;
        cursor: pointer;
        position: relative;
        white-space: nowrap;
        user-select: none;
      }
      .ctx-menu-item:hover {
        background: rgba(255, 255, 255, 0.1);
      }
      .ctx-menu-submenu {
        position: relative;
      }
      .ctx-submenu {
        display: none;
        position: absolute;
        left: 100%;
        top: -4px;
        background: rgba(30, 30, 30, 0.95);
        border: 1px solid rgba(255, 255, 255, 0.15);
        border-radius: 8px;
        padding: 4px 0;
        min-width: 140px;
        box-shadow: 0 4px 16px rgba(0, 0, 0, 0.4);
        backdrop-filter: blur(12px);
      }
      .ctx-menu-submenu:hover > .ctx-submenu {
        display: block;
      }
      .ctx-menu-separator {
        height: 1px;
        background: rgba(255, 255, 255, 0.1);
        margin: 4px 8px;
      }
      .ctx-submenu::-webkit-scrollbar {
        width: 6px;
      }
      .ctx-submenu::-webkit-scrollbar-thumb {
        background: rgba(255, 255, 255, 0.2);
        border-radius: 3px;
      }
    `;
    document.head.appendChild(style);
  }
}
