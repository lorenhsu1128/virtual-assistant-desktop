import type { AppConfig } from '../types/config';
import type { AnimationMeta } from '../types/animation';
import type { WindowRect, DisplayInfo } from '../types/window';
import type { TrayMenuData } from '../types/tray';
import type { UserVrmaEntry } from '../types/userVrma';

/**
 * Electron API interface exposed via preload script (contextBridge).
 *
 * All methods map to ipcMain.handle() handlers in electron/ipcHandlers.ts.
 */
interface ElectronAPI {
  getConfigExists(): Promise<boolean>;
  readConfig(): Promise<AppConfig>;
  writeConfig(config: AppConfig): Promise<void>;
  readAnimationMeta(): Promise<AnimationMeta>;
  writeAnimationMeta(meta: AnimationMeta): Promise<void>;
  scanAnimations(folderPath: string): Promise<AnimationMeta>;
  scanVrmFiles(folderPath: string): Promise<string[]>;
  scanVrmaFiles(folderPath: string): Promise<string[]>;
  pickVrmFile(): Promise<string | null>;
  pickAnimationFolder(): Promise<string | null>;
  pickVrmFolder(defaultPath?: string): Promise<string | null>;
  openVrmPicker(): Promise<void>;
  applyVrmModel(vrmPath: string): Promise<boolean>;
  openVideoConverter(): Promise<void>;
  pickVideoFile(): Promise<string | null>;
  listUserVrmas(): Promise<UserVrmaEntry[]>;
  writeUserVrma(payload: {
    name: string;
    vadJson: string;
    vrmaBuffer: ArrayBuffer | null;
  }): Promise<{ name: string; vadPath: string; vrmaPath: string | null }>;
  readUserVad(vadPath: string): Promise<string>;
  deleteUserVrma(vadPath: string): Promise<boolean>;
  getUserVrmaDir(): Promise<string>;
  onUserAnimationsChanged(callback: (entries: UserVrmaEntry[]) => void): () => void;
  getWindowList(): Promise<WindowRect[]>;
  getDisplayInfo(): Promise<DisplayInfo[]>;
  setWindowPosition(x: number, y: number): Promise<void>;
  getWindowPosition(): Promise<{ x: number; y: number }>;
  setWindowSize(width: number, height: number): Promise<void>;
  getWindowSize(): Promise<{ width: number; height: number }>;
  moveToDisplay(displayIndex: number): Promise<void>;
  setIgnoreCursorEvents(ignore: boolean): Promise<void>;
  closeWindow(): Promise<void>;
  getAppPath(): Promise<string>;
  onWindowLayoutChanged(callback: (rects: WindowRect[]) => void): () => void;
  onTrayAction(callback: (actionId: string) => void): () => void;
  onRequestMenuData(callback: () => void): () => void;
  sendMenuData(data: TrayMenuData): void;
  onDebugMove(callback: (direction: string) => void): () => void;
  convertToAssetUrl(filePath: string): string;
}

declare global {
  interface Window {
    electronAPI: ElectronAPI;
  }
}

/**
 * Electron IPC Bridge
 *
 * All renderer-to-main process communication must go through this class.
 * Other modules must not use window.electronAPI directly.
 *
 * This replaces the old TauriIPC class, maintaining the same public API.
 */
class ElectronIPC {
  /** Cached config for fallback on IPC failure */
  private configCache: AppConfig | null = null;

  /** Cached window list for fallback */
  private windowListCache: WindowRect[] = [];

  /** Write retry counter */
  private writeRetryCount = 0;
  private readonly maxWriteRetries = 3;

  /**
   * Check if config.json exists (first-run detection)
   */
  async getConfigExists(): Promise<boolean> {
    try {
      return await window.electronAPI.getConfigExists();
    } catch (e) {
      console.warn('[ElectronIPC] getConfigExists failed:', e);
      return false;
    }
  }

  /**
   * Read config.json
   *
   * Falls back to cache or null on failure.
   */
  async readConfig(): Promise<AppConfig | null> {
    try {
      const config = await window.electronAPI.readConfig();
      this.configCache = config;
      return config;
    } catch (e) {
      console.warn('[ElectronIPC] readConfig failed, using cache:', e);
      return this.configCache;
    }
  }

  /**
   * Write config.json
   *
   * Retries up to 3 times on failure.
   */
  async writeConfig(config: AppConfig): Promise<boolean> {
    try {
      await window.electronAPI.writeConfig(config);
      this.configCache = config;
      this.writeRetryCount = 0;
      return true;
    } catch (e) {
      console.warn('[ElectronIPC] writeConfig failed:', e);
      this.writeRetryCount++;
      if (this.writeRetryCount < this.maxWriteRetries) {
        console.warn(`[ElectronIPC] Will retry writeConfig (${this.writeRetryCount}/${this.maxWriteRetries})`);
      }
      return false;
    }
  }

  /**
   * Read animations.json
   */
  async readAnimationMeta(): Promise<AnimationMeta | null> {
    try {
      return await window.electronAPI.readAnimationMeta();
    } catch (e) {
      console.warn('[ElectronIPC] readAnimationMeta failed:', e);
      return null;
    }
  }

  /**
   * Write animations.json
   */
  async writeAnimationMeta(meta: AnimationMeta): Promise<boolean> {
    try {
      await window.electronAPI.writeAnimationMeta(meta);
      return true;
    } catch (e) {
      console.warn('[ElectronIPC] writeAnimationMeta failed:', e);
      return false;
    }
  }

  /**
   * Scan animation folder and sync metadata
   */
  async scanAnimations(folderPath: string): Promise<AnimationMeta | null> {
    try {
      return await window.electronAPI.scanAnimations(folderPath);
    } catch (e) {
      console.warn('[ElectronIPC] scanAnimations failed:', e);
      return null;
    }
  }

  /**
   * Scan VRM files in a directory
   *
   * Returns full paths to .vrm files.
   */
  async scanVrmFiles(folderPath: string): Promise<string[]> {
    try {
      return await window.electronAPI.scanVrmFiles(folderPath);
    } catch (e) {
      console.warn('[ElectronIPC] scanVrmFiles failed:', e);
      return [];
    }
  }

  /**
   * Scan .vrma animation files in a directory
   *
   * Returns full paths to .vrma files. Empty array on error or missing folder.
   */
  async scanVrmaFiles(folderPath: string): Promise<string[]> {
    try {
      return await window.electronAPI.scanVrmaFiles(folderPath);
    } catch (e) {
      console.warn('[ElectronIPC] scanVrmaFiles failed:', e);
      return [];
    }
  }

  /**
   * Open file picker for VRM model
   *
   * Returns null if cancelled (normal operation, no error).
   */
  async pickVrmFile(): Promise<string | null> {
    try {
      return await window.electronAPI.pickVrmFile();
    } catch (e) {
      console.warn('[ElectronIPC] pickVrmFile failed:', e);
      return null;
    }
  }

  /**
   * Open folder picker for animation folder
   *
   * Returns null if cancelled (normal operation, no error).
   */
  async pickAnimationFolder(): Promise<string | null> {
    try {
      return await window.electronAPI.pickAnimationFolder();
    } catch (e) {
      console.warn('[ElectronIPC] pickAnimationFolder failed:', e);
      return null;
    }
  }

  /**
   * Open folder picker for VRM browse dialog
   *
   * Returns null if cancelled (normal operation, no error).
   */
  async pickVrmFolder(defaultPath?: string): Promise<string | null> {
    try {
      return await window.electronAPI.pickVrmFolder(defaultPath);
    } catch (e) {
      console.warn('[ElectronIPC] pickVrmFolder failed:', e);
      return null;
    }
  }

  /**
   * Open the custom VRM model browser dialog window
   */
  async openVrmPicker(): Promise<void> {
    try {
      await window.electronAPI.openVrmPicker();
    } catch (e) {
      console.warn('[ElectronIPC] openVrmPicker failed:', e);
    }
  }

  /**
   * Open the video motion converter standalone window (Phase 1+)
   */
  async openVideoConverter(): Promise<void> {
    try {
      await window.electronAPI.openVideoConverter();
    } catch (e) {
      console.warn('[ElectronIPC] openVideoConverter failed:', e);
    }
  }

  /**
   * Open native file picker for video files (mp4 / webm / mov / mkv / avi).
   * Returns absolute path or null if cancelled.
   */
  async pickVideoFile(): Promise<string | null> {
    try {
      return await window.electronAPI.pickVideoFile();
    } catch (e) {
      console.warn('[ElectronIPC] pickVideoFile failed:', e);
      return null;
    }
  }

  // ── User VRMA (Phase 12) ──

  async listUserVrmas(): Promise<UserVrmaEntry[]> {
    try {
      return await window.electronAPI.listUserVrmas();
    } catch (e) {
      console.warn('[ElectronIPC] listUserVrmas failed:', e);
      return [];
    }
  }

  async writeUserVrma(
    name: string,
    vadJson: string,
    vrmaBuffer: ArrayBuffer | null
  ): Promise<{ name: string; vadPath: string; vrmaPath: string | null } | null> {
    try {
      return await window.electronAPI.writeUserVrma({ name, vadJson, vrmaBuffer });
    } catch (e) {
      console.warn('[ElectronIPC] writeUserVrma failed:', e);
      return null;
    }
  }

  async readUserVad(vadPath: string): Promise<string | null> {
    try {
      return await window.electronAPI.readUserVad(vadPath);
    } catch (e) {
      console.warn('[ElectronIPC] readUserVad failed:', e);
      return null;
    }
  }

  async deleteUserVrma(vadPath: string): Promise<boolean> {
    try {
      return await window.electronAPI.deleteUserVrma(vadPath);
    } catch (e) {
      console.warn('[ElectronIPC] deleteUserVrma failed:', e);
      return false;
    }
  }

  async getUserVrmaDir(): Promise<string | null> {
    try {
      return await window.electronAPI.getUserVrmaDir();
    } catch (e) {
      console.warn('[ElectronIPC] getUserVrmaDir failed:', e);
      return null;
    }
  }

  onUserAnimationsChanged(callback: (entries: UserVrmaEntry[]) => void): () => void {
    return window.electronAPI.onUserAnimationsChanged(callback);
  }

  /**
   * Apply selected VRM model: writes config and reloads main window
   */
  async applyVrmModel(vrmPath: string): Promise<boolean> {
    try {
      return await window.electronAPI.applyVrmModel(vrmPath);
    } catch (e) {
      console.warn('[ElectronIPC] applyVrmModel failed:', e);
      return false;
    }
  }

  // ── Window Monitor ──

  /**
   * Get current visible window list
   *
   * Falls back to cached data on failure.
   */
  async getWindowList(): Promise<WindowRect[]> {
    try {
      const rects = await window.electronAPI.getWindowList();
      this.windowListCache = rects;
      return rects;
    } catch (e) {
      console.warn('[ElectronIPC] getWindowList failed, using cache:', e);
      return this.windowListCache;
    }
  }

  /**
   * Listen for window layout changes
   *
   * Returns unlisten function.
   */
  async onWindowLayoutChanged(callback: (rects: WindowRect[]) => void): Promise<() => void> {
    const unlisten = window.electronAPI.onWindowLayoutChanged((rects) => {
      this.windowListCache = rects;
      callback(rects);
    });
    return unlisten;
  }

  /**
   * Get display/monitor info
   */
  async getDisplayInfo(): Promise<DisplayInfo[]> {
    try {
      return await window.electronAPI.getDisplayInfo();
    } catch (e) {
      console.warn('[ElectronIPC] getDisplayInfo failed:', e);
      return [];
    }
  }

  // ── Multi-Display ──

  /**
   * 將桌寵視窗移到指定 display（等同於 setBounds 為該螢幕 bounds）
   */
  async moveToDisplay(displayIndex: number): Promise<void> {
    try {
      await window.electronAPI.moveToDisplay(displayIndex);
    } catch (e) {
      console.warn('[ElectronIPC] moveToDisplay failed:', e);
    }
  }

  // ── Window Position / Size ──

  /**
   * Set mascot window position (physical pixels)
   */
  async setWindowPosition(x: number, y: number): Promise<void> {
    try {
      await window.electronAPI.setWindowPosition(x, y);
    } catch (e) {
      console.warn('[ElectronIPC] setWindowPosition failed:', e);
    }
  }

  /**
   * Get mascot window position
   */
  async getWindowPosition(): Promise<{ x: number; y: number }> {
    try {
      return await window.electronAPI.getWindowPosition();
    } catch (e) {
      console.warn('[ElectronIPC] getWindowPosition failed:', e);
      return { x: 0, y: 0 };
    }
  }

  /**
   * Get mascot window size
   */
  async getWindowSize(): Promise<{ width: number; height: number }> {
    try {
      return await window.electronAPI.getWindowSize();
    } catch (e) {
      console.warn('[ElectronIPC] getWindowSize failed:', e);
      return { width: 400, height: 600 };
    }
  }

  /**
   * Set mascot window size (physical pixels)
   */
  async setWindowSize(width: number, height: number): Promise<void> {
    try {
      await window.electronAPI.setWindowSize(width, height);
    } catch (e) {
      console.warn('[ElectronIPC] setWindowSize failed:', e);
    }
  }

  /**
   * Set mouse passthrough (transparent areas don't intercept mouse events)
   */
  async setIgnoreCursorEvents(ignore: boolean): Promise<void> {
    try {
      await window.electronAPI.setIgnoreCursorEvents(ignore);
    } catch (e) {
      console.warn('[ElectronIPC] setIgnoreCursorEvents failed:', e);
    }
  }

  /**
   * Get application root path
   */
  async getAppPath(): Promise<string> {
    try {
      return await window.electronAPI.getAppPath();
    } catch (e) {
      console.warn('[ElectronIPC] getAppPath failed:', e);
      return '.';
    }
  }

  /**
   * Close the application
   */
  async closeWindow(): Promise<void> {
    try {
      await window.electronAPI.closeWindow();
    } catch (e) {
      console.warn('[ElectronIPC] closeWindow failed:', e);
    }
  }

  /**
   * Listen for system tray menu actions
   *
   * Returns unlisten function.
   */
  async onTrayAction(callback: (actionId: string) => void): Promise<() => void> {
    return window.electronAPI.onTrayAction(callback);
  }

  /**
   * Listen for menu data requests from main process (tray left-click)
   *
   * Returns unlisten function.
   */
  async onRequestMenuData(callback: () => void): Promise<() => void> {
    return window.electronAPI.onRequestMenuData(callback);
  }

  /**
   * Send menu data to main process for tray menu construction
   */
  sendMenuData(data: TrayMenuData): void {
    window.electronAPI.sendMenuData(data);
  }

  /** Listen for debug move events (Ctrl+Arrow global shortcuts) */
  async onDebugMove(callback: (direction: string) => void): Promise<() => void> {
    return window.electronAPI.onDebugMove(callback);
  }

  /**
   * Convert local file path to loadable URL
   *
   * Three.js loaders cannot load local paths (e.g., C:\...) directly.
   * This converts them to the custom local-file:// protocol.
   */
  convertToAssetUrl(filePath: string): string {
    return window.electronAPI.convertToAssetUrl(filePath);
  }
}

/** Global ElectronIPC instance */
export const ipc = new ElectronIPC();
