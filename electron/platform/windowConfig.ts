/**
 * 各平台的 BrowserWindow 參數設定
 *
 * Windows：全螢幕透明覆蓋，focusable: false + setIgnoreMouseEvents
 * macOS：全螢幕透明覆蓋，focusable: false + setIgnoreMouseEvents(true, { forward: true })
 *        macOS 需要 forward 選項讓透明區域滑鼠穿透但模型區域仍可互動
 */

import { BrowserWindow } from 'electron';

const isMac = process.platform === 'darwin';

interface DisplayBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** 回傳平台專用的 BrowserWindow 建構參數（不含 webPreferences） */
export function getWindowOptions(
  bounds: DisplayBounds
): Electron.BrowserWindowConstructorOptions {
  if (isMac) {
    return {
      x: bounds.x,
      y: bounds.y,
      width: bounds.width,
      height: bounds.height,
      transparent: true,
      frame: false,
      focusable: false,
      alwaysOnTop: true,
      skipTaskbar: true,
      resizable: false,
      hasShadow: false,
    };
  }

  // Windows：全螢幕透明覆蓋
  return {
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height,
    transparent: true,
    frame: false,
    thickFrame: false,
    focusable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    hasShadow: false,
  };
}

/**
 * 回傳 VRM 模型瀏覽對話框的 BrowserWindow 建構參數
 *
 * 與主透明視窗相反：有邊框、可縮放、不透明、modal-like。
 * Windows / macOS 共用同一份參數（無系統 API 差異）。
 */
export function getPickerWindowOptions(
  parent: BrowserWindow
): Electron.BrowserWindowConstructorOptions {
  return {
    width: 1120,
    height: 560,
    minWidth: 900,
    minHeight: 480,
    parent,
    modal: false,
    title: '瀏覽 VRM 模型',
    transparent: false,
    frame: true,
    focusable: true,
    alwaysOnTop: false,
    skipTaskbar: false,
    resizable: true,
    hasShadow: true,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: '#1e1e2e',
  };
}

/**
 * 回傳設定視窗的 BrowserWindow 建構參數
 *
 * 與 picker 類似（有邊框、可縮放、不透明），但較小且帶 modal-like behavior。
 */
export function getSettingsWindowOptions(
  parent: BrowserWindow,
): Electron.BrowserWindowConstructorOptions {
  return {
    width: 720,
    height: 560,
    minWidth: 600,
    minHeight: 400,
    parent,
    modal: false,
    title: '桌寵設定',
    transparent: false,
    frame: true,
    focusable: true,
    alwaysOnTop: false,
    skipTaskbar: false,
    resizable: true,
    hasShadow: true,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: '#0e1018',
  };
}

/**
 * 回傳 Agent 對話氣泡視窗的 BrowserWindow 建構參數
 *
 * 設計：透明、無邊框、可聚焦（讓 textarea 能輸入）、置頂、不顯示在工作列。
 * 與 picker 不同處：不需要 frame / shadow，由 HTML/CSS 自繪 chrome。
 */
export function getAgentBubbleOptions(
  parent: BrowserWindow
): Electron.BrowserWindowConstructorOptions {
  return {
    width: 380,
    height: 520,
    minWidth: 320,
    minHeight: 400,
    parent,
    transparent: true,
    frame: false,
    focusable: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: true,
    hasShadow: false,
    show: false,
    title: 'Agent 對話',
    backgroundColor: '#00000000',
  };
}

/** 視窗建立後的平台專用設定 */
export function applyPostCreateSetup(
  win: BrowserWindow,
  bounds: DisplayBounds
): void {
  if (isMac) {
    // macOS：啟用滑鼠穿透 + forward，讓透明區域穿透但非透明區域仍可接收事件
    win.setIgnoreMouseEvents(true, { forward: true });
  } else {
    // Windows：強制覆蓋整個螢幕（含工作列），避免自動限制到 workArea
    win.setBounds({
      x: bounds.x,
      y: bounds.y,
      width: bounds.width,
      height: bounds.height,
    });
  }

  win.setAlwaysOnTop(true, 'screen-saver');
}
