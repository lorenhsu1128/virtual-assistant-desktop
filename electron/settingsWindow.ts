/**
 * 桌寵設定 BrowserWindow（單實例，沿用 vrmPickerWindow 模板）。
 *
 * 內容由 React app（src-settings/）渲染，與主視窗及氣泡完全隔離。
 * P3 v1：僅 Agent 設定頁（其他項目未來補）。
 */

import { BrowserWindow, app } from 'electron';
import * as path from 'node:path';
import * as url from 'node:url';
import { getSettingsWindowOptions } from './platform/index.js';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));

let settingsWindow: BrowserWindow | null = null;

const isDev = process.env.NODE_ENV !== 'production' && !app.isPackaged;

export function openSettingsWindow(parent: BrowserWindow): void {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    if (settingsWindow.isMinimized()) settingsWindow.restore();
    settingsWindow.focus();
    return;
  }

  const win = new BrowserWindow({
    ...getSettingsWindowOptions(parent),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      webSecurity: false,
    },
  });

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

  if (isDev) {
    win.loadURL('http://localhost:1420/settings.html');
  } else {
    win.loadFile(path.join(__dirname, '..', 'dist', 'settings.html'));
  }

  win.once('ready-to-show', () => {
    if (!win.isDestroyed()) win.show();
  });

  win.on('closed', () => {
    if (settingsWindow === win) settingsWindow = null;
  });

  settingsWindow = win;
}

export function closeSettingsWindow(): void {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.close();
  }
  settingsWindow = null;
}

export function getSettingsWindow(): BrowserWindow | null {
  return settingsWindow && !settingsWindow.isDestroyed() ? settingsWindow : null;
}
