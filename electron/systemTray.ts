import { Tray, Menu, BrowserWindow, nativeImage, app } from 'electron';

/** System tray setup and management */
export class SystemTray {
  private tray: Tray | null = null;
  private mainWindow: BrowserWindow;

  constructor(mainWindow: BrowserWindow) {
    this.mainWindow = mainWindow;
  }

  /** Create system tray icon and context menu */
  setup(): void {
    // Create a simple 16x16 tray icon (transparent with a colored square)
    const icon = nativeImage.createFromBuffer(
      this.createDefaultIcon(),
      { width: 16, height: 16 },
    );

    this.tray = new Tray(icon);
    this.tray.setToolTip('Virtual Assistant Desktop');
    this.buildMenu();
  }

  /** Rebuild the context menu */
  private buildMenu(): void {
    if (!this.tray) return;

    const scaleSubmenu = Menu.buildFromTemplate([
      { label: '50%', click: () => this.emitAction('scale_50') },
      { label: '75%', click: () => this.emitAction('scale_75') },
      { label: '100%', click: () => this.emitAction('scale_100') },
      { label: '125%', click: () => this.emitAction('scale_125') },
      { label: '150%', click: () => this.emitAction('scale_150') },
      { label: '200%', click: () => this.emitAction('scale_200') },
    ]);

    const menu = Menu.buildFromTemplate([
      {
        label: '\u986f\u793a\u684c\u5bf5',
        click: () => {
          this.mainWindow.show();
          this.mainWindow.focus();
        },
      },
      { type: 'separator' },
      { label: '\u7e2e\u653e', submenu: scaleSubmenu },
      { label: '\u66ab\u505c/\u6062\u5fa9\u81ea\u4e3b\u79fb\u52d5', click: () => this.emitAction('toggle_pause') },
      { label: '\u66ab\u505c/\u6062\u5fa9\u81ea\u52d5\u8868\u60c5', click: () => this.emitAction('toggle_auto_expr') },
      { label: '\u66ab\u505c/\u6062\u5fa9\u52d5\u756b\u5faa\u74b0', click: () => this.emitAction('toggle_loop') },
      { label: '\u91cd\u7f6e\u93e1\u982d\u89d2\u5ea6', click: () => this.emitAction('reset_camera') },
      { label: '\u91cd\u7f6e\u56de\u684c\u9762\u6b63\u4e2d\u592e', click: () => this.emitAction('reset_position') },
      { type: 'separator' },
      { label: '\u66f4\u63db VRM \u6a21\u578b', click: () => this.emitAction('change_model') },
      { label: '\u66f4\u63db\u52d5\u756b\u8cc7\u6599\u593e', click: () => this.emitAction('change_anim') },
      { type: 'separator' },
      { label: 'Debug \u6a21\u5f0f', click: () => this.emitAction('toggle_debug') },
      { label: '\u8a2d\u5b9a', click: () => this.emitAction('settings') },
      { type: 'separator' },
      {
        label: '\u7d50\u675f',
        click: () => {
          app.quit();
        },
      },
    ]);

    this.tray.setContextMenu(menu);
  }

  /** Send action to renderer process */
  private emitAction(actionId: string): void {
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
        // Simple cyan-ish circle
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
    if (this.tray) {
      this.tray.destroy();
      this.tray = null;
    }
  }
}
