import { invoke, convertFileSrc } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { PhysicalPosition, PhysicalSize } from '@tauri-apps/api/dpi';
import type { AppConfig } from '../types/config';
import type { AnimationMeta } from '../types/animation';
import type { WindowRect, Rect, DisplayInfo } from '../types/window';

/**
 * Tauri IPC 橋接層
 *
 * 所有前端對 Rust 側的呼叫都必須經過此類別。
 * 其他模組禁止直接呼叫 invoke() 或 listen()。
 */
class TauriIPC {
  /** 上一次讀取的設定快取（IPC 失敗時的 fallback） */
  private configCache: AppConfig | null = null;

  /** 上一次取得的視窗列表快取 */
  private windowListCache: WindowRect[] = [];

  /** 寫入設定的重試計數 */
  private writeRetryCount = 0;
  private readonly maxWriteRetries = 3;

  /**
   * 檢查 config.json 是否存在
   *
   * 用於判斷是否為首次啟動。
   */
  async getConfigExists(): Promise<boolean> {
    try {
      return await invoke<boolean>('get_config_exists');
    } catch (e) {
      console.warn('[TauriIPC] getConfigExists failed:', e);
      return false;
    }
  }

  /**
   * 讀取 config.json
   *
   * 失敗時回傳快取或 null，不中斷流程。
   */
  async readConfig(): Promise<AppConfig | null> {
    try {
      const config = await invoke<AppConfig>('read_config');
      this.configCache = config;
      return config;
    } catch (e) {
      console.warn('[TauriIPC] readConfig failed, using cache:', e);
      return this.configCache;
    }
  }

  /**
   * 寫入 config.json
   *
   * 失敗時重試最多 3 次。
   */
  async writeConfig(config: AppConfig): Promise<boolean> {
    try {
      await invoke('write_config', { config });
      this.configCache = config;
      this.writeRetryCount = 0;
      return true;
    } catch (e) {
      console.warn('[TauriIPC] writeConfig failed:', e);
      this.writeRetryCount++;
      if (this.writeRetryCount < this.maxWriteRetries) {
        console.warn(`[TauriIPC] Will retry writeConfig (${this.writeRetryCount}/${this.maxWriteRetries})`);
      }
      return false;
    }
  }

  /**
   * 讀取 animations.json
   */
  async readAnimationMeta(): Promise<AnimationMeta | null> {
    try {
      return await invoke<AnimationMeta>('read_animation_meta');
    } catch (e) {
      console.warn('[TauriIPC] readAnimationMeta failed:', e);
      return null;
    }
  }

  /**
   * 寫入 animations.json
   */
  async writeAnimationMeta(meta: AnimationMeta): Promise<boolean> {
    try {
      await invoke('write_animation_meta', { meta });
      return true;
    } catch (e) {
      console.warn('[TauriIPC] writeAnimationMeta failed:', e);
      return false;
    }
  }

  /**
   * 掃描動畫資料夾並同步 metadata
   *
   * 新發現的 .vrma 預設歸類為 action。
   */
  async scanAnimations(folderPath: string): Promise<AnimationMeta | null> {
    try {
      return await invoke<AnimationMeta>('scan_animations', { folderPath });
    } catch (e) {
      console.warn('[TauriIPC] scanAnimations failed:', e);
      return null;
    }
  }

  /**
   * 開啟檔案選擇器選取 VRM 模型
   *
   * 使用者取消時回傳 null（正常操作，不報錯）。
   */
  async pickVrmFile(): Promise<string | null> {
    try {
      return await invoke<string | null>('pick_vrm_file');
    } catch (e) {
      console.warn('[TauriIPC] pickVrmFile failed:', e);
      return null;
    }
  }

  /**
   * 開啟資料夾選擇器選取動畫資料夾
   *
   * 使用者取消時回傳 null（正常操作，不報錯）。
   */
  async pickAnimationFolder(): Promise<string | null> {
    try {
      return await invoke<string | null>('pick_animation_folder');
    } catch (e) {
      console.warn('[TauriIPC] pickAnimationFolder failed:', e);
      return null;
    }
  }

  // ── 視窗監控 ──

  /**
   * 取得當前可見視窗清單
   *
   * 失敗時回傳快取資料，不中斷 render loop。
   */
  async getWindowList(): Promise<WindowRect[]> {
    try {
      const rects = await invoke<WindowRect[]>('get_window_list');
      this.windowListCache = rects;
      return rects;
    } catch (e) {
      console.warn('[TauriIPC] getWindowList failed, using cache:', e);
      return this.windowListCache;
    }
  }

  /**
   * 監聽視窗佈局變化事件
   *
   * WindowMonitor 偵測到視窗佈局變化時觸發。
   * 回傳 unlisten 函式，用於取消監聽。
   */
  async onWindowLayoutChanged(callback: (rects: WindowRect[]) => void): Promise<UnlistenFn> {
    return listen<WindowRect[]>('window_layout_changed', (event) => {
      this.windowListCache = event.payload;
      callback(event.payload);
    });
  }

  /**
   * 設定桌寵視窗的裁切區域（遮擋效果）
   *
   * 傳入空陣列時重置為完整視窗。
   */
  async setWindowRegion(excludeRects: Rect[]): Promise<boolean> {
    try {
      await invoke('set_window_region', { excludeRects });
      return true;
    } catch (e) {
      console.warn('[TauriIPC] setWindowRegion failed:', e);
      return false;
    }
  }

  /**
   * 取得螢幕資訊
   */
  async getDisplayInfo(): Promise<DisplayInfo[]> {
    try {
      return await invoke<DisplayInfo[]>('get_display_info');
    } catch (e) {
      console.warn('[TauriIPC] getDisplayInfo failed:', e);
      return [];
    }
  }

  // ── 視窗位置控制 ──

  /**
   * 設定桌寵視窗位置（邏輯像素）
   */
  async setWindowPosition(x: number, y: number): Promise<void> {
    try {
      const window = getCurrentWindow();
      await window.setPosition(new PhysicalPosition(Math.round(x), Math.round(y)));
    } catch (e) {
      console.warn('[TauriIPC] setWindowPosition failed:', e);
    }
  }

  /**
   * 取得桌寵視窗目前位置
   */
  async getWindowPosition(): Promise<{ x: number; y: number }> {
    try {
      const window = getCurrentWindow();
      const pos = await window.outerPosition();
      return { x: pos.x, y: pos.y };
    } catch (e) {
      console.warn('[TauriIPC] getWindowPosition failed:', e);
      return { x: 0, y: 0 };
    }
  }

  /**
   * 取得桌寵視窗大小
   */
  async getWindowSize(): Promise<{ width: number; height: number }> {
    try {
      const window = getCurrentWindow();
      const size = await window.outerSize();
      return { width: size.width, height: size.height };
    } catch (e) {
      console.warn('[TauriIPC] getWindowSize failed:', e);
      return { width: 400, height: 600 };
    }
  }

  /**
   * 設定桌寵視窗大小（物理像素）
   */
  async setWindowSize(width: number, height: number): Promise<void> {
    try {
      const window = getCurrentWindow();
      await window.setSize(new PhysicalSize(Math.round(width), Math.round(height)));
    } catch (e) {
      console.warn('[TauriIPC] setWindowSize failed:', e);
    }
  }

  /**
   * 設定滑鼠穿透（透明區域不攔截滑鼠事件）
   */
  async setIgnoreCursorEvents(ignore: boolean): Promise<void> {
    try {
      const window = getCurrentWindow();
      await window.setIgnoreCursorEvents(ignore);
    } catch (e) {
      console.warn('[TauriIPC] setIgnoreCursorEvents failed:', e);
    }
  }

  /**
   * 關閉應用程式
   */
  async closeWindow(): Promise<void> {
    try {
      const window = getCurrentWindow();
      await window.close();
    } catch (e) {
      console.warn('[TauriIPC] closeWindow failed:', e);
    }
  }

  /**
   * 監聽系統托盤選單動作
   *
   * 托盤選單項目點擊時觸發，payload 為動作 ID 字串。
   */
  async onTrayAction(callback: (actionId: string) => void): Promise<UnlistenFn> {
    return listen<string>('tray_action', (event) => {
      callback(event.payload);
    });
  }

  /**
   * 將本機檔案路徑轉換為 Tauri asset URL
   *
   * Three.js 等前端 loader 無法直接讀取本機路徑（如 C:\...），
   * 必須透過 Tauri 的 asset protocol 轉換為可存取的 URL。
   */
  convertToAssetUrl(filePath: string): string {
    return convertFileSrc(filePath);
  }
}

/** 全域 TauriIPC 實例 */
export const ipc = new TauriIPC();
