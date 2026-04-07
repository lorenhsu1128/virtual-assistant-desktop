import { Tray, Menu, BrowserWindow, nativeImage, app, ipcMain } from 'electron';

/** Scale options for the menu */
const SCALE_OPTIONS = [
  { label: '50%', value: 0.5, actionId: 'scale_50' },
  { label: '75%', value: 0.75, actionId: 'scale_75' },
  { label: '100%', value: 1.0, actionId: 'scale_100' },
  { label: '125%', value: 1.25, actionId: 'scale_125' },
  { label: '150%', value: 1.5, actionId: 'scale_150' },
  { label: '200%', value: 2.0, actionId: 'scale_200' },
];

/** Animation speed options */
const SPEED_OPTIONS = [
  { label: '0.5x', value: 0.5, actionId: 'speed_050' },
  { label: '0.75x', value: 0.75, actionId: 'speed_075' },
  { label: '1.0x', value: 1.0, actionId: 'speed_100' },
  { label: '1.25x', value: 1.25, actionId: 'speed_125' },
];

/** Move speed options (50%~150%, every 10%) */
const MOVE_SPEED_OPTIONS = [
  { label: '50%', value: 0.5, actionId: 'move_speed_050' },
  { label: '60%', value: 0.6, actionId: 'move_speed_060' },
  { label: '70%', value: 0.7, actionId: 'move_speed_070' },
  { label: '80%', value: 0.8, actionId: 'move_speed_080' },
  { label: '90%', value: 0.9, actionId: 'move_speed_090' },
  { label: '100%', value: 1.0, actionId: 'move_speed_100' },
  { label: '110%', value: 1.1, actionId: 'move_speed_110' },
  { label: '120%', value: 1.2, actionId: 'move_speed_120' },
  { label: '130%', value: 1.3, actionId: 'move_speed_130' },
  { label: '140%', value: 1.4, actionId: 'move_speed_140' },
  { label: '150%', value: 1.5, actionId: 'move_speed_150' },
];

/** TrayMenuData from renderer (mirrors src/types/tray.ts) */
interface TrayMenuData {
  animations: { fileName: string; displayName: string }[];
  expressions: string[];
  currentScale: number;
  currentSpeed: number;
  currentMoveSpeed: number;
  isPaused: boolean;
  isAutoExpressionEnabled: boolean;
  isLoopEnabled: boolean;
  isDebugEnabled: boolean;
  currentExpression: string | null;
  displays: { index: number; label: string }[];
}

/**
 * System tray setup and management
 *
 * On Windows, setContextMenu() shows the menu on right-click only.
 * Left-click is handled via tray 'click' event + popUpContextMenu.
 * Renderer pushes menu data updates; main process caches and rebuilds.
 */
export class SystemTray {
  private tray: Tray | null = null;
  private mainWindow: BrowserWindow;
  private cachedData: TrayMenuData | null = null;
  private currentMenu: Menu | null = null;
  private ipcHandler: ((_event: Electron.IpcMainEvent, data: TrayMenuData) => void) | null = null;

  constructor(mainWindow: BrowserWindow) {
    this.mainWindow = mainWindow;
  }

  /** Create system tray icon and listen for menu data updates */
  setup(): void {
    const icon = nativeImage.createFromBuffer(
      this.createDefaultIcon(),
      { width: 16, height: 16 },
    );

    this.tray = new Tray(icon);
    this.tray.setToolTip('Virtual Assistant Desktop');

    // Left-click: show menu via popUpContextMenu
    this.tray.on('click', () => {
      if (this.tray && this.currentMenu) {
        this.tray.popUpContextMenu(this.currentMenu);
      }
    });

    // Build initial static menu
    this.rebuildMenu();

    // Listen for menu data updates from renderer
    this.ipcHandler = (_event, data) => {
      this.cachedData = data;
      this.rebuildMenu();
    };
    ipcMain.on('menu_data_response', this.ipcHandler);
  }

  /** 上一次選單資料的 hash（避免重複 rebuild） */
  private lastDataHash = '';

  /** Rebuild the context menu from cached data */
  private rebuildMenu(): void {
    if (!this.tray) return;

    // 比對資料是否變化，未變化時跳過 rebuild
    const dataHash = JSON.stringify(this.cachedData);
    if (dataHash === this.lastDataHash) return;
    this.lastDataHash = dataHash;

    const data = this.cachedData;
    const template: Electron.MenuItemConstructorOptions[] = [];

    // 顯示桌寵
    template.push({
      label: '\u986f\u793a\u684c\u5bf5',
      click: () => {
        this.mainWindow.show();
        this.mainWindow.focus();
      },
    });
    template.push({ type: 'separator' });

    // 動畫子選單（dynamic）
    if (data && data.animations.length > 0) {
      template.push({
        label: '\u52d5\u756b',
        submenu: data.animations.map((a) => ({
          label: a.displayName,
          click: () => this.emitAction(`play_anim::${a.fileName}`),
        })),
      });
    }

    // 表情子選單（dynamic）
    if (data && data.expressions.length > 0) {
      template.push({
        label: '\u8868\u60c5',
        submenu: data.expressions.map((name) => ({
          label: name,
          type: 'checkbox' as const,
          checked: name === data.currentExpression,
          click: () => this.emitAction(`set_expr::${name}`),
        })),
      });
    }

    if (data && (data.animations.length > 0 || data.expressions.length > 0)) {
      template.push({ type: 'separator' });
    }

    // 縮放子選單
    template.push({
      label: '\u7e2e\u653e',
      submenu: SCALE_OPTIONS.map((opt) => ({
        label: opt.label,
        type: 'radio' as const,
        checked: data ? Math.abs(opt.value - data.currentScale) < 0.01 : opt.value === 1.0,
        click: () => this.emitAction(opt.actionId),
      })),
    });

    // 動畫速率子選單
    template.push({
      label: '\u52d5\u756b\u901f\u7387',
      submenu: SPEED_OPTIONS.map((opt) => ({
        label: opt.label,
        type: 'radio' as const,
        checked: data ? Math.abs(opt.value - data.currentSpeed) < 0.01 : opt.value === 1.0,
        click: () => this.emitAction(opt.actionId),
      })),
    });

    // 移動速率子選單
    template.push({
      label: '\u79fb\u52d5\u901f\u7387',
      submenu: MOVE_SPEED_OPTIONS.map((opt) => ({
        label: opt.label,
        type: 'radio' as const,
        checked: data ? Math.abs(opt.value - data.currentMoveSpeed) < 0.01 : opt.value === 1.0,
        click: () => this.emitAction(opt.actionId),
      })),
    });

    // 暫停/恢復自主移動
    template.push({
      label: data?.isPaused ? '\u6062\u5fa9\u81ea\u4e3b\u79fb\u52d5' : '\u66ab\u505c\u81ea\u4e3b\u79fb\u52d5',
      click: () => this.emitAction('toggle_pause'),
    });

    // 暫停/恢復自動表情
    template.push({
      label: data?.isAutoExpressionEnabled ? '\u66ab\u505c\u81ea\u52d5\u8868\u60c5' : '\u6062\u5fa9\u81ea\u52d5\u8868\u60c5',
      click: () => this.emitAction('toggle_auto_expr'),
    });

    // 暫停/恢復動畫循環
    template.push({
      label: data?.isLoopEnabled ? '\u66ab\u505c\u52d5\u756b\u5faa\u74b0' : '\u6062\u5fa9\u52d5\u756b\u5faa\u74b0',
      click: () => this.emitAction('toggle_loop'),
    });

    template.push({ type: 'separator' });

    // 特殊演出
    template.push({
      label: '\u885d\u5411\u93e1\u982d',
      click: () => this.emitAction('cinematic_run'),
    });

    // 重置鏡頭角度
    template.push({
      label: '\u91cd\u7f6e\u93e1\u982d\u89d2\u5ea6',
      click: () => this.emitAction('reset_camera'),
    });

    // 重置回桌面正中央
    template.push({
      label: '\u91cd\u7f6e\u56de\u684c\u9762\u6b63\u4e2d\u592e',
      click: () => this.emitAction('reset_position'),
    });

    // 螢幕子選單（多螢幕時才顯示）
    if (data && data.displays.length > 1) {
      template.push({ type: 'separator' });
      template.push({
        label: '\u87a2\u5e55',
        submenu: data.displays.map((d) => ({
          label: d.label,
          click: () => this.emitAction(`switch_display_${d.index}`),
        })),
      });
    }

    template.push({ type: 'separator' });

    // 更換 VRM 模型
    template.push({
      label: '\u66f4\u63db VRM \u6a21\u578b',
      click: () => this.emitAction('change_model'),
    });

    // 瀏覽 VRM 模型...（自訂預覽對話框）
    template.push({
      label: '\u700f\u89bd VRM \u6a21\u578b...',
      click: () => this.emitAction('browse_models'),
    });

    // 更換動畫資料夾
    template.push({
      label: '\u66f4\u63db\u52d5\u756b\u8cc7\u6599\u593e',
      click: () => this.emitAction('change_anim'),
    });

    template.push({ type: 'separator' });

    // Debug 模式
    template.push({
      label: 'Debug \u6a21\u5f0f',
      type: 'checkbox',
      checked: data?.isDebugEnabled ?? false,
      click: () => this.emitAction('toggle_debug'),
    });

    // 設定
    template.push({
      label: '\u8a2d\u5b9a',
      click: () => this.emitAction('settings'),
    });

    template.push({ type: 'separator' });

    // 結束
    template.push({
      label: '\u7d50\u675f',
      click: () => {
        app.quit();
      },
    });

    // Store reference to prevent GC, and set for both left+right click
    this.currentMenu = Menu.buildFromTemplate(template);
    this.tray.setContextMenu(this.currentMenu);
  }

  /** Send action to renderer process */
  private emitAction(actionId: string): void {
    console.log('[SystemTray] emitAction:', actionId);
    if (!this.mainWindow.isDestroyed()) {
      this.mainWindow.webContents.send('tray_action', actionId);
    }
  }

  /** Create a simple default tray icon (16x16 RGBA) */
  private createDefaultIcon(): Buffer {
    const size = 16;
    const buf = Buffer.alloc(size * size * 4);

    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const i = (y * size + x) * 4;
        const cx = x - 7.5;
        const cy = y - 7.5;
        const dist = Math.sqrt(cx * cx + cy * cy);
        if (dist < 7) {
          buf[i] = 100;     // R
          buf[i + 1] = 200; // G
          buf[i + 2] = 255; // B
          buf[i + 3] = 255; // A
        } else {
          buf[i + 3] = 0; // transparent
        }
      }
    }
    return buf;
  }

  /** Destroy tray */
  dispose(): void {
    if (this.ipcHandler) {
      ipcMain.removeListener('menu_data_response', this.ipcHandler);
      this.ipcHandler = null;
    }
    if (this.tray) {
      this.tray.destroy();
      this.tray = null;
    }
  }
}
