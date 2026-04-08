/**
 * Spike 視窗管理（dev-only）
 *
 * 給 Phase 0 spike 頁面用的獨立 BrowserWindow：
 *  - 有邊框、可關閉、無滑鼠穿透、不透明
 *  - 與主透明桌寵視窗完全隔離
 *  - 同一個 spike 名稱重複呼叫會聚焦既有視窗（單實例）
 *
 * 只在 dev 模式有意義：spike-*.html 不在 vite build input，
 * production build 不會打包，因此 prod 模式呼叫時等同 no-op。
 *
 * 跨平台：BrowserWindow 參數透過 platform/windowConfig.getSpikeWindowOptions 取得。
 */

import { BrowserWindow, app } from 'electron';
import * as path from 'node:path';
import * as url from 'node:url';
import { getSpikeWindowOptions } from './platform/index.js';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));

const isDev = process.env.NODE_ENV !== 'production' && !app.isPackaged;

/** 已知的 spike 名稱 → 對應 HTML 入口 */
const SPIKE_PAGES = {
  mediapipe: 'spike-mediapipe.html',
  'vrma-export': 'spike-vrma-export.html',
} as const;

export type SpikeName = keyof typeof SPIKE_PAGES;

const openWindows = new Map<SpikeName, BrowserWindow>();

/**
 * 開啟（或聚焦）指定的 spike 視窗。
 *
 * @param parent 主視窗，作為對話框 parent
 * @param name spike 名稱（mediapipe / vrma-export）
 */
export function openSpikeWindow(parent: BrowserWindow, name: SpikeName): void {
  if (!isDev) {
    console.warn('[SpikeWindow] spike windows are dev-only; ignored in production');
    return;
  }

  const existing = openWindows.get(name);
  if (existing && !existing.isDestroyed()) {
    if (existing.isMinimized()) existing.restore();
    existing.focus();
    return;
  }

  const win = new BrowserWindow({
    ...getSpikeWindowOptions(parent, name),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      webSecurity: false,
    },
  });

  win.webContents.openDevTools({ mode: 'detach' });
  win.webContents.on('before-input-event', (_event, input) => {
    if (input.key === 'F12' && input.type === 'keyDown') {
      if (win.webContents.isDevToolsOpened()) {
        win.webContents.closeDevTools();
      } else {
        win.webContents.openDevTools({ mode: 'detach' });
      }
    }
  });

  const pageName = SPIKE_PAGES[name];
  win.loadURL(`http://localhost:1420/${pageName}`);

  win.once('ready-to-show', () => {
    if (!win.isDestroyed()) win.show();
  });

  win.on('closed', () => {
    if (openWindows.get(name) === win) {
      openWindows.delete(name);
    }
  });

  openWindows.set(name, win);
}

/** 關閉所有 spike 視窗 */
export function closeAllSpikeWindows(): void {
  for (const win of openWindows.values()) {
    if (!win.isDestroyed()) win.close();
  }
  openWindows.clear();
}
