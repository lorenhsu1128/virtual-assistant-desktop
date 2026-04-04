import { ipcMain, dialog, BrowserWindow, screen } from 'electron';
import * as fileManager from './fileManager.js';
import { WindowMonitor, type WindowRect } from './windowMonitor.js';
import { setWindowRegion, type Rect } from './windowRegion.js';

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
  // ── Config ──

  ipcMain.handle('get_config_exists', () => {
    return fileManager.getConfigExists();
  });

  ipcMain.handle('read_config', () => {
    return fileManager.readConfig();
  });

  ipcMain.handle('write_config', (_event, config: fileManager.AppConfig) => {
    fileManager.writeConfig(config);
  });

  // ── Animation Meta ──

  ipcMain.handle('read_animation_meta', () => {
    return fileManager.readAnimationMeta();
  });

  ipcMain.handle('write_animation_meta', (_event, meta: fileManager.AnimationMeta) => {
    fileManager.writeAnimationMeta(meta);
  });

  ipcMain.handle('scan_animations', (_event, folderPath: string) => {
    return fileManager.scanAnimations(folderPath);
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

  // ── Window Monitor ──

  ipcMain.handle('get_window_list', (): WindowRect[] => {
    return windowMonitor.getLatest();
  });

  // ── Window Region (Occlusion) ──

  ipcMain.handle('set_window_region', (_event, excludeRects: Rect[]) => {
    setWindowRegion(mainWindow, excludeRects);
  });

  // ── Display Info ──

  ipcMain.handle('get_display_info', (): DisplayInfo[] => {
    return screen.getAllDisplays().map((display) => ({
      x: display.bounds.x,
      y: display.bounds.y,
      width: display.bounds.width,
      height: display.bounds.height,
      scaleFactor: display.scaleFactor,
      workArea: {
        x: display.workArea.x,
        y: display.workArea.y,
        width: display.workArea.width,
        height: display.workArea.height,
      },
    }));
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

  // ── Mouse Passthrough ──

  ipcMain.handle('set_ignore_cursor_events', (_event, ignore: boolean) => {
    mainWindow.setIgnoreMouseEvents(ignore, { forward: true });
  });

  // ── App Control ──

  ipcMain.handle('close_window', () => {
    mainWindow.close();
  });
}
