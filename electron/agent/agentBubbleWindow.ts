/**
 * Agent 對話氣泡 BrowserWindow。
 *
 * 沿用 vrmPickerWindow 模板：獨立視窗、單實例、parent = 主視窗。
 * 與 picker 的差異：透明 + 無邊框 + 由 HTML/CSS 自繪 chrome。
 */

import { BrowserWindow, app, screen } from 'electron';
import * as path from 'node:path';
import * as url from 'node:url';
import { getAgentBubbleOptions } from '../platform/index.js';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));

let bubbleWindow: BrowserWindow | null = null;

const isDev = process.env.NODE_ENV !== 'production' && !app.isPackaged;

/**
 * 開啟（或聚焦）Agent 對話氣泡視窗。
 *
 * 預設位置：主視窗右側、垂直置中於螢幕。
 */
export function openAgentBubbleWindow(parent: BrowserWindow): void {
  if (bubbleWindow && !bubbleWindow.isDestroyed()) {
    if (bubbleWindow.isMinimized()) bubbleWindow.restore();
    bubbleWindow.show();
    bubbleWindow.focus();
    return;
  }

  const options = getAgentBubbleOptions(parent);
  const win = new BrowserWindow({
    ...options,
    ...computeInitialPosition(parent, options.width ?? 380, options.height ?? 520),
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload.js'),
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
    win.loadURL('http://localhost:1420/agent-bubble.html');
  } else {
    win.loadFile(path.join(__dirname, '..', '..', 'dist', 'agent-bubble.html'));
  }

  win.once('ready-to-show', () => {
    if (!win.isDestroyed()) win.show();
  });

  win.on('closed', () => {
    if (bubbleWindow === win) bubbleWindow = null;
  });

  bubbleWindow = win;
}

/** 切換顯示 / 隱藏 */
export function toggleAgentBubbleWindow(parent: BrowserWindow): void {
  if (bubbleWindow && !bubbleWindow.isDestroyed()) {
    if (bubbleWindow.isVisible()) {
      bubbleWindow.hide();
    } else {
      bubbleWindow.show();
      bubbleWindow.focus();
    }
    return;
  }
  openAgentBubbleWindow(parent);
}

export function getAgentBubbleWindow(): BrowserWindow | null {
  return bubbleWindow && !bubbleWindow.isDestroyed() ? bubbleWindow : null;
}

export function closeAgentBubbleWindow(): void {
  if (bubbleWindow && !bubbleWindow.isDestroyed()) {
    bubbleWindow.close();
  }
  bubbleWindow = null;
}

function computeInitialPosition(
  parent: BrowserWindow,
  width: number,
  height: number,
): { x: number; y: number } {
  const parentBounds = parent.getBounds();
  const display = screen.getDisplayMatching(parentBounds);
  const margin = 16;

  // 預設：主視窗（透明全螢幕）所在 display 的右側中段
  let x = display.workArea.x + display.workArea.width - width - margin;
  let y = display.workArea.y + Math.round((display.workArea.height - height) / 2);

  // 邊界保護
  x = Math.max(display.workArea.x + margin, x);
  y = Math.max(display.workArea.y + margin, y);
  return { x, y };
}
