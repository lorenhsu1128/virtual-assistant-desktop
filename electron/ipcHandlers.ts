import { ipcMain, dialog, BrowserWindow, screen, app } from 'electron';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import * as fileManager from './fileManager.js';
import { WindowMonitor, type WindowRect } from './windowMonitor.js';
import { openPickerWindow, closePickerWindow } from './vrmPickerWindow.js';
import { openMocapStudioWindow } from './mocapStudioWindow.js';
import { isMac } from './platform/index.js';

/** Display info returned to renderer */
interface DisplayInfo {
  x: number;
  y: number;
  width: number;
  height: number;
  scaleFactor: number;
  workArea: { x: number; y: number; width: number; height: number };
}

/**
 * Register all IPC handlers for the main process.
 *
 * Maps 1:1 to the Tauri commands that existed before migration.
 */
export function registerIpcHandlers(
  mainWindow: BrowserWindow,
  windowMonitor: WindowMonitor,
): void {
  // 追蹤目前的 passthrough 狀態，讓 setBounds 類操作之後能重新套用
  // （Electron 在某些情況下 setBounds 後會悄悄丟失 setIgnoreMouseEvents 狀態）
  let currentIgnoreState = true;
  // ── Config ──

  ipcMain.handle('get_config_exists', () => {
    return fileManager.getConfigExists();
  });

  ipcMain.handle('read_config', () => {
    return fileManager.readConfig();
  });

  ipcMain.handle('write_config', (_event, config: fileManager.AppConfig) => {
    return fileManager.writeConfig(config);
  });

  // ── Animation Meta ──

  ipcMain.handle('read_animation_meta', () => {
    return fileManager.readAnimationMeta();
  });

  ipcMain.handle('write_animation_meta', (_event, meta: fileManager.AnimationMeta) => {
    return fileManager.writeAnimationMeta(meta);
  });

  ipcMain.handle('scan_animations', (_event, folderPath: string) => {
    return fileManager.scanAnimations(folderPath);
  });

  ipcMain.handle('scan_vrm_files', (_event, folderPath: string) => {
    return fileManager.scanVrmFiles(folderPath);
  });

  ipcMain.handle('scan_vrma_files', async (_event, folderPath: string): Promise<string[]> => {
    try {
      const files = await fileManager.scanVrmaFiles(folderPath);
      // fileManager.scanVrmaFiles 回傳檔名，這裡 join 為完整路徑以便 renderer 透過 convertToAssetUrl 載入
      return files.map((f) => path.join(folderPath, f));
    } catch (e) {
      console.warn('[ipcHandlers] scan_vrma_files failed:', e);
      return [];
    }
  });

  // ── File Pickers ──

  ipcMain.handle('pick_vrm_file', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: '\u9078\u64c7 VRM \u6a21\u578b',
      filters: [{ name: 'VRM Model', extensions: ['vrm'] }],
      properties: ['openFile'],
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    return result.filePaths[0];
  });

  ipcMain.handle('pick_animation_folder', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: '\u9078\u64c7\u52d5\u756b\u8cc7\u6599\u593e',
      properties: ['openDirectory'],
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    return result.filePaths[0];
  });

  ipcMain.handle('pick_vrm_folder', async (event, defaultPath?: string) => {
    const senderWindow = BrowserWindow.fromWebContents(event.sender) ?? mainWindow;
    const result = await dialog.showOpenDialog(senderWindow, {
      title: '\u9078\u64c7 VRM \u8cc7\u6599\u593e',
      properties: ['openDirectory'],
      defaultPath,
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    return result.filePaths[0];
  });

  // ── VRM Picker Window ──

  ipcMain.handle('open_vrm_picker', () => {
    openPickerWindow(mainWindow);
  });

  ipcMain.handle('apply_vrm_model', async (_event, vrmPath: string) => {
    const config = await fileManager.readConfig();
    config.vrmModelPath = vrmPath;
    await fileManager.writeConfig(config);
    // 通知主視窗 reload，沿用既有「page reload 載入新模型」流程
    if (!mainWindow.isDestroyed()) {
      mainWindow.webContents.reload();
    }
    closePickerWindow();
    return true;
  });

  // ── Mocap Studio Window ──

  /** 開啟（或聚焦）影片動捕工作站子視窗 */
  ipcMain.handle('open_mocap_studio', () => {
    openMocapStudioWindow(mainWindow);
  });

  /** 取得主視窗當前的 VRM 模型路徑（mocap studio 預覽面板使用） */
  ipcMain.handle('mocap_get_current_vrm_path', async (): Promise<string | null> => {
    const config = await fileManager.readConfig();
    return config.vrmModelPath ?? null;
  });

  /**
   * 儲存 VRMA 檔案（mocap studio 匯出用）
   *
   * 開啟存檔對話框並將 bytes 寫入選定路徑。
   * 使用者取消或失敗時回傳 null；成功回傳完整檔案路徑。
   */
  ipcMain.handle(
    'mocap_save_vrma',
    async (
      event,
      bytes: Uint8Array,
      suggestedName: string,
    ): Promise<string | null> => {
      const senderWindow = BrowserWindow.fromWebContents(event.sender) ?? mainWindow;
      const result = await dialog.showSaveDialog(senderWindow, {
        title: '\u532f\u51fa VRMA \u52d5\u756b',
        defaultPath: suggestedName,
        filters: [{ name: 'VRM Animation', extensions: ['vrma'] }],
      });
      if (result.canceled || !result.filePath) return null;
      try {
        await fs.writeFile(result.filePath, Buffer.from(bytes));
        return result.filePath;
      } catch (e) {
        console.warn('[ipcHandlers] mocap_save_vrma writeFile failed:', e);
        return null;
      }
    },
  );

  /** 影片檔案選擇器（mocap studio 使用） */
  ipcMain.handle('mocap_pick_video', async (event): Promise<string | null> => {
    const senderWindow = BrowserWindow.fromWebContents(event.sender) ?? mainWindow;
    const result = await dialog.showOpenDialog(senderWindow, {
      title: '\u9078\u64c7\u5f71\u7247',
      filters: [
        { name: 'Video', extensions: ['mp4', 'webm', 'mov', 'mkv', 'avi', 'm4v'] },
        { name: 'All Files', extensions: ['*'] },
      ],
      properties: ['openFile'],
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    return result.filePaths[0];
  });

  // ── Window Monitor ──

  ipcMain.handle('get_window_list', (): WindowRect[] => {
    return windowMonitor.getLatest();
  });

  // (Window Region / Occlusion 已移除，未來重新開發)

  // ── Display Info ──

  ipcMain.handle('get_display_info', (): DisplayInfo[] => {
    // macOS：視窗被 menu bar 推下，用實際視窗位置作為螢幕原點
    // 否則 CGWindowListCopyWindowInfo 的絕對座標與 canvas 座標會有 menu bar 高度的偏移
    const winBounds = isMac ? mainWindow.getBounds() : null;

    return screen.getAllDisplays().map((display) => {
      // macOS 上，只修正桌寵視窗所在的螢幕
      let effectiveY = display.bounds.y;
      if (winBounds) {
        const inThisDisplay =
          winBounds.x >= display.bounds.x &&
          winBounds.x < display.bounds.x + display.bounds.width;
        if (inThisDisplay) {
          effectiveY = winBounds.y;
        }
      }

      return {
        x: display.bounds.x,
        y: effectiveY,
        width: display.bounds.width,
        height: display.bounds.height,
        scaleFactor: display.scaleFactor,
        workArea: {
          x: display.workArea.x,
          y: display.workArea.y,
          width: display.workArea.width,
          height: display.workArea.height,
        },
      };
    });
  });

  // ── Window Position / Size ──

  ipcMain.handle('set_window_position', (_event, x: number, y: number) => {
    mainWindow.setPosition(Math.round(x), Math.round(y));
  });

  ipcMain.handle('get_window_position', () => {
    const [x, y] = mainWindow.getPosition();
    return { x, y };
  });

  ipcMain.handle('set_window_size', (_event, width: number, height: number) => {
    // Temporarily enable resizable (window is normally non-resizable)
    mainWindow.setResizable(true);
    mainWindow.setSize(Math.round(width), Math.round(height));
    mainWindow.setResizable(false);
  });

  ipcMain.handle('get_window_size', () => {
    const [width, height] = mainWindow.getSize();
    return { width, height };
  });

  // ── Multi-Display ──

  ipcMain.handle('move_to_display', (_event, displayIndex: number) => {
    const displays = screen.getAllDisplays();
    const d = displays[displayIndex];
    if (!d) return;
    mainWindow.setBounds(d.bounds);
    mainWindow.setAlwaysOnTop(true, 'screen-saver');
    // setBounds 可能重置 passthrough 狀態，重新套用
    mainWindow.setIgnoreMouseEvents(currentIgnoreState, { forward: true });
  });

  // ── Mouse Passthrough ──

  ipcMain.handle('set_ignore_cursor_events', (_event, ignore: boolean) => {
    currentIgnoreState = ignore;
    mainWindow.setIgnoreMouseEvents(ignore, { forward: true });
  });

  // ── App Path ──

  ipcMain.handle('get_app_path', () => {
    return app.getAppPath();
  });

  // ── App Control ──

  ipcMain.handle('close_window', () => {
    mainWindow.close();
  });
}
