import { BrowserWindow, screen } from 'electron';

/**
 * 全螢幕游標追蹤器
 *
 * 透明視窗只在游標進入視窗時才會收到 mousemove 事件，無法用於
 * 跨整個桌面追蹤游標。改用 main process 60Hz 輪詢
 * `electron.screen.getCursorScreenPoint()`（跨平台），diff > 1px
 * 時才透過 IPC event `cursor_position` 廣播到所有 BrowserWindow，
 * 給 renderer 端的 HeadTrackingController 使用。
 */

const POLL_INTERVAL_MS = 16; // ~60Hz
const MIN_DIFF_PX = 1;

let intervalId: NodeJS.Timeout | null = null;
let lastX = Number.NaN;
let lastY = Number.NaN;
let getTargets: (() => BrowserWindow[]) | null = null;

/**
 * 啟動游標追蹤輪詢。
 *
 * @param getTargetWindows 回傳目前要接收事件的視窗清單（通常是 BrowserWindow.getAllWindows()）。
 *   每幀呼叫，閉包讓 main.ts 不用持有引用。
 */
export function startCursorTracker(getTargetWindows: () => BrowserWindow[]): void {
  if (intervalId !== null) return;
  getTargets = getTargetWindows;
  lastX = Number.NaN;
  lastY = Number.NaN;

  intervalId = setInterval(() => {
    let point: { x: number; y: number };
    try {
      point = screen.getCursorScreenPoint();
    } catch (e) {
      // 桌面被鎖定 / 螢幕睡眠時呼叫可能失敗，靜默略過
      console.warn('[cursorTracker] getCursorScreenPoint failed:', e);
      return;
    }

    // diff 過濾，避免靜止時也持續廣播
    if (
      Number.isFinite(lastX) &&
      Number.isFinite(lastY) &&
      Math.abs(point.x - lastX) < MIN_DIFF_PX &&
      Math.abs(point.y - lastY) < MIN_DIFF_PX
    ) {
      return;
    }
    lastX = point.x;
    lastY = point.y;

    const targets = getTargets?.() ?? [];
    for (const win of targets) {
      if (win.isDestroyed()) continue;
      win.webContents.send('cursor_position', point);
    }
  }, POLL_INTERVAL_MS);

  console.log('[cursorTracker] started');
}

/** 停止游標輪詢（app quit 前呼叫） */
export function stopCursorTracker(): void {
  if (intervalId !== null) {
    clearInterval(intervalId);
    intervalId = null;
    getTargets = null;
    console.log('[cursorTracker] stopped');
  }
}
