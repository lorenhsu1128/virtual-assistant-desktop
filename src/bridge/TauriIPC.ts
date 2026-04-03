import { invoke, convertFileSrc } from '@tauri-apps/api/core';
import type { AppConfig } from '../types/config';
import type { AnimationMeta } from '../types/animation';

/**
 * Tauri IPC 橋接層
 *
 * 所有前端對 Rust 側的呼叫都必須經過此類別。
 * 其他模組禁止直接呼叫 invoke() 或 listen()。
 */
class TauriIPC {
  /** 上一次讀取的設定快取（IPC 失敗時的 fallback） */
  private configCache: AppConfig | null = null;

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
