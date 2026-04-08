/**
 * 影片動作轉換器 BrowserWindow 管理
 *
 * 提供獨立的非透明視窗，與主透明桌寵視窗完全隔離。
 * 單實例：若已開啟則 focus 既有視窗。
 *
 * 跨平台：BrowserWindow 參數透過 platform/windowConfig.getVideoConverterWindowOptions 取得。
 *
 * 對應計畫：video-converter-plan.md Phase 1（視窗骨架）。
 */

import { BrowserWindow, app } from 'electron';
import * as path from 'node:path';
import * as url from 'node:url';
import { getVideoConverterWindowOptions } from './platform/index.js';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));

let videoConverterWindow: BrowserWindow | null = null;

const isDev = process.env.NODE_ENV !== 'production' && !app.isPackaged;

/**
 * 開啟（或聚焦）影片動作轉換器視窗
 *
 * @param parent 主視窗，作為對話框 parent
 */
export function openVideoConverterWindow(parent: BrowserWindow): void {
  if (videoConverterWindow && !videoConverterWindow.isDestroyed()) {
    if (videoConverterWindow.isMinimized()) videoConverterWindow.restore();
    videoConverterWindow.focus();
    return;
  }

  const win = new BrowserWindow({
    ...getVideoConverterWindowOptions(parent),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      webSecurity: false,
    },
  });

  // DevTools: dev 模式自動開啟
  if (isDev) {
    win.webContents.openDevTools({ mode: 'detach' });
  }
  win.webContents.on('before-input-event', (_event, input) => {
    if (input.key === 'F12' && input.type === 'keyDown') {
      if (win.webContents.isDevToolsOpened()) {
        win.webContents.closeDevTools();
      } else {
        win.webContents.openDevTools({ mode: 'detach' });
      }
    }
  });

  // 載入入口頁
  if (isDev) {
    win.loadURL('http://localhost:1420/video-converter.html');
  } else {
    win.loadFile(path.join(__dirname, '..', 'dist', 'video-converter.html'));
  }

  // 內容載入完成後再顯示，避免閃白底
  win.once('ready-to-show', () => {
    if (!win.isDestroyed()) {
      win.show();
    }
  });

  win.on('closed', () => {
    if (videoConverterWindow === win) {
      videoConverterWindow = null;
    }
  });

  videoConverterWindow = win;
}

/** 取得目前的影片轉換器視窗（未開啟則回傳 null） */
export function getVideoConverterWindow(): BrowserWindow | null {
  return videoConverterWindow && !videoConverterWindow.isDestroyed()
    ? videoConverterWindow
    : null;
}

/** 關閉並釋放影片轉換器視窗 */
export function closeVideoConverterWindow(): void {
  if (videoConverterWindow && !videoConverterWindow.isDestroyed()) {
    videoConverterWindow.close();
  }
  videoConverterWindow = null;
}
