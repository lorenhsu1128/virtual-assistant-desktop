/**
 * 鍵盤偵測模組
 *
 * 使用 uiohook-napi 偵測全域鍵盤事件，判定使用者是否正在打字。
 * 狀態變化時透過 callback 通知（不推送每次按鍵，僅推送 typing 狀態切換）。
 *
 * 跨平台：uiohook-napi 原生支援 Windows + macOS + Linux。
 * 載入失敗時優雅降級（isTyping 永遠為 false）。
 */

import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

/** typing 狀態變化 callback */
export type TypingStateCallback = (isTyping: boolean) => void;

/** 判定為「正在打字」的閾值（ms）— 最後一次按鍵後超過此時間視為停止打字 */
const TYPING_TIMEOUT_MS = 5000;
/** 定期檢查 typing 超時的間隔（ms） */
const CHECK_INTERVAL_MS = 1000;

export class KeyboardMonitor {
  private lastKeyTime = 0;
  private isTyping = false;
  private checkTimer: ReturnType<typeof setInterval> | null = null;
  private onTypingStateChanged: TypingStateCallback | null = null;
  private started = false;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private uIOhook: any = null;

  /** 設定 typing 狀態變化 callback */
  setCallback(cb: TypingStateCallback | null): void {
    this.onTypingStateChanged = cb;
  }

  /** 啟動鍵盤偵測 */
  start(): void {
    if (this.started) return;
    this.started = true;

    try {
      // 動態載入 uiohook-napi（native addon，macOS/Windows 皆支援）
      const { uIOhook } = require('uiohook-napi');
      this.uIOhook = uIOhook;

      uIOhook.on('keydown', () => {
        this.lastKeyTime = Date.now();
        if (!this.isTyping) {
          this.isTyping = true;
          this.onTypingStateChanged?.(true);
        }
      });

      uIOhook.start();
      console.log('[KeyboardMonitor] uiohook-napi started');
    } catch (e) {
      console.warn('[KeyboardMonitor] uiohook-napi load failed, keyboard detection disabled:', e);
      return;
    }

    // 定期檢查 typing 超時
    this.checkTimer = setInterval(() => {
      if (this.isTyping && Date.now() - this.lastKeyTime > TYPING_TIMEOUT_MS) {
        this.isTyping = false;
        this.onTypingStateChanged?.(false);
      }
    }, CHECK_INTERVAL_MS);
  }

  /** 停止鍵盤偵測 */
  stop(): void {
    if (!this.started) return;
    this.started = false;

    if (this.checkTimer !== null) {
      clearInterval(this.checkTimer);
      this.checkTimer = null;
    }

    if (this.uIOhook) {
      try {
        this.uIOhook.stop();
      } catch {
        // 忽略停止錯誤
      }
      this.uIOhook = null;
    }

    if (this.isTyping) {
      this.isTyping = false;
      this.onTypingStateChanged?.(false);
    }
  }

  /** 取得當前 typing 狀態 */
  getIsTyping(): boolean {
    return this.isTyping;
  }
}
