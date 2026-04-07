/**
 * VRM 模型瀏覽對話框 BrowserWindow 管理
 *
 * 提供獨立的非透明視窗，與主透明視窗完全隔離。
 * 單實例：若已開啟則 focus 既有視窗。
 *
 * 跨平台：BrowserWindow 參數透過 platform/windowConfig.getPickerWindowOptions 取得。
 */

import { BrowserWindow, app } from 'electron';
import * as path from 'node:path';
import * as url from 'node:url';
import { getPickerWindowOptions } from './platform/index.js';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));

let pickerWindow: BrowserWindow | null = null;

const isDev = process.env.NODE_ENV !== 'production' && !app.isPackaged;

/**
 * 開啟（或聚焦）VRM 模型瀏覽對話框
 *
 * @param parent 主視窗，作為對話框的 parent
 */
export function openPickerWindow(parent: BrowserWindow): void {
  if (pickerWindow && !pickerWindow.isDestroyed()) {
    if (pickerWindow.isMinimized()) pickerWindow.restore();
    pickerWindow.focus();
    return;
  }

  const win = new BrowserWindow({
    ...getPickerWindowOptions(parent),
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

  // 載入 picker 入口頁
  if (isDev) {
    win.loadURL('http://localhost:1420/vrm-picker.html');
  } else {
    win.loadFile(path.join(__dirname, '..', 'dist', 'vrm-picker.html'));
  }

  // 內容載入完成後再顯示，避免閃白底
  win.once('ready-to-show', () => {
    if (!win.isDestroyed()) {
      win.show();
    }
  });

  win.on('closed', () => {
    if (pickerWindow === win) {
      pickerWindow = null;
    }
  });

  pickerWindow = win;
}

/** 取得目前的 picker 視窗（未開啟則回傳 null） */
export function getPickerWindow(): BrowserWindow | null {
  return pickerWindow && !pickerWindow.isDestroyed() ? pickerWindow : null;
}

/** 關閉並釋放 picker 視窗 */
export function closePickerWindow(): void {
  if (pickerWindow && !pickerWindow.isDestroyed()) {
    pickerWindow.close();
  }
  pickerWindow = null;
}
