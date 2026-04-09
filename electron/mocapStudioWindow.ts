/**
 * 影片動捕工作站 BrowserWindow 管理
 *
 * 提供獨立的非透明子視窗，與主透明視窗完全隔離。
 * 單實例：若已開啟則 focus 既有視窗。
 *
 * 跨平台：BrowserWindow 參數透過 platform/windowConfig.getMocapStudioWindowOptions 取得。
 *
 * 設計參考 vrmPickerWindow.ts，結構一致。
 */

import { BrowserWindow, app } from 'electron';
import * as path from 'node:path';
import * as url from 'node:url';
import { getMocapStudioWindowOptions } from './platform/index.js';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));

let mocapWindow: BrowserWindow | null = null;

const isDev = process.env.NODE_ENV !== 'production' && !app.isPackaged;

/**
 * 開啟（或聚焦）影片動捕工作站子視窗
 *
 * @param parent 主視窗，作為子視窗的 parent
 */
export function openMocapStudioWindow(parent: BrowserWindow): void {
  if (mocapWindow && !mocapWindow.isDestroyed()) {
    if (mocapWindow.isMinimized()) mocapWindow.restore();
    mocapWindow.focus();
    return;
  }

  const win = new BrowserWindow({
    ...getMocapStudioWindowOptions(parent),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      webSecurity: false,
    },
  });

  // DevTools：dev 模式自動開啟
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
    win.loadURL('http://localhost:1420/mocap-studio.html');
  } else {
    win.loadFile(path.join(__dirname, '..', 'dist', 'mocap-studio.html'));
  }

  win.once('ready-to-show', () => {
    if (!win.isDestroyed()) {
      win.show();
    }
  });

  win.on('closed', () => {
    if (mocapWindow === win) {
      mocapWindow = null;
    }
  });

  mocapWindow = win;
}

/** 取得目前的 mocap studio 視窗（未開啟則回傳 null） */
export function getMocapStudioWindow(): BrowserWindow | null {
  return mocapWindow && !mocapWindow.isDestroyed() ? mocapWindow : null;
}

/** 關閉並釋放 mocap studio 視窗 */
export function closeMocapStudioWindow(): void {
  if (mocapWindow && !mocapWindow.isDestroyed()) {
    mocapWindow.close();
  }
  mocapWindow = null;
}
