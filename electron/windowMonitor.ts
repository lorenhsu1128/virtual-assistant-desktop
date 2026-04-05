import { BrowserWindow } from 'electron';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

/** Window rectangle data (matches TypeScript WindowRect interface) */
export interface WindowRect {
  hwnd: number;
  title: string;
  x: number;
  y: number;
  width: number;
  height: number;
  zOrder: number;
  isForeground: boolean;
  isMaximized: boolean;
}

/** Polling interval (300ms) */
const POLL_INTERVAL = 300;

/** GetWindow constants */
const GW_CHILD = 5;
const GW_HWNDNEXT = 2;
const GW_OWNER = 4;

/** GetWindowLongW / Extended style constants */
const GWL_EXSTYLE = -20;
const WS_EX_TOOLWINDOW = 0x00000080;
const WS_EX_APPWINDOW = 0x00040000;
const WS_EX_NOACTIVATE = 0x08000000;

/** DWM cloaked attribute — filters hidden Windows 11 system UI */
const DWMWA_CLOAKED = 14;

// koffi bindings (loaded lazily)
let koffiLoaded = false;
// WINRECT struct type registered in koffi (used by name in func signatures)

// All functions use intptr_t for HWND — koffi returns plain numbers, no pointer conversion needed
let GetDesktopWindow: (() => number) | null = null;
let GetWindowFn: ((hWnd: number, uCmd: number) => number) | null = null;
let IsWindowVisible: ((hWnd: number) => number) | null = null;
let IsIconic: ((hWnd: number) => number) | null = null;
let GetWindowTextLengthW: ((hWnd: number) => number) | null = null;
let GetWindowTextW: ((hWnd: number, lpString: Buffer, nMaxCount: number) => number) | null = null;
let GetWindowRectFn: ((hWnd: number, lpRect: unknown) => number) | null = null;
let GetWindowLongW: ((hWnd: number, nIndex: number) => number) | null = null;
let DwmGetWindowAttribute: ((hWnd: number, dwAttribute: number, pvAttribute: Buffer, cbAttribute: number) => number) | null = null;
let GetForegroundWindow: (() => number) | null = null;
let IsZoomed: ((hWnd: number) => number) | null = null;

/**
 * Load koffi and bind Windows API functions.
 * Uses intptr_t for HWND so koffi returns plain numbers (no opaque pointers).
 */
function ensureKoffi(): boolean {
  if (koffiLoaded) return true;

  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const koffi = require('koffi');

    const user32 = koffi.load('user32.dll');

    // Define RECT struct (registered by name, used in func signatures)
    koffi.struct('WINRECT2', {
      left: 'int',
      top: 'int',
      right: 'int',
      bottom: 'int',
    });

    // Use intptr_t for HWND — returns plain JS numbers, no pointer objects
    GetDesktopWindow = user32.func('intptr_t GetDesktopWindow()');
    GetWindowFn = user32.func('intptr_t GetWindow(intptr_t hWnd, uint uCmd)');
    IsWindowVisible = user32.func('int IsWindowVisible(intptr_t hWnd)');
    IsIconic = user32.func('int IsIconic(intptr_t hWnd)');
    GetWindowTextLengthW = user32.func('int GetWindowTextLengthW(intptr_t hWnd)');
    GetWindowTextW = user32.func('int GetWindowTextW(intptr_t hWnd, _Out_ uint16_t *lpString, int nMaxCount)');
    GetWindowRectFn = user32.func('int GetWindowRect(intptr_t hWnd, _Out_ WINRECT2 *lpRect)');
    GetWindowLongW = user32.func('long GetWindowLongW(intptr_t hWnd, int nIndex)');

    // DWM API for cloaked window detection (Windows 10/11 system UI)
    const dwmapi = koffi.load('dwmapi.dll');
    DwmGetWindowAttribute = dwmapi.func('long DwmGetWindowAttribute(intptr_t hwnd, uint dwAttribute, _Out_ uint8_t *pvAttribute, uint cbAttribute)');
    GetForegroundWindow = user32.func('intptr_t GetForegroundWindow()');
    IsZoomed = user32.func('int IsZoomed(intptr_t hWnd)');

    koffiLoaded = true;
    console.log('[WindowMonitor] koffi loaded OK');
    return true;
  } catch (e) {
    console.error('[WindowMonitor] Failed to load koffi:', e);
    return false;
  }
}

/**
 * Enumerate visible windows using GetWindow traversal (no callbacks).
 *
 * Walks the window chain: GetDesktopWindow → GW_CHILD → GW_HWNDNEXT loop.
 */
function enumerateWindows(ownHwnd: number): WindowRect[] {
  if (!ensureKoffi()) return [];

  const results: WindowRect[] = [];
  let zOrder = 0;
  const foregroundHwnd = GetForegroundWindow ? GetForegroundWindow() : 0;

  try {
    const desktop = GetDesktopWindow!();
    let hwnd = GetWindowFn!(desktop, GW_CHILD);

    let iterations = 0;
    const MAX_ITERATIONS = 2000;

    while (hwnd !== 0 && iterations < MAX_ITERATIONS) {
      iterations++;

      if (hwnd !== ownHwnd) {
        try {
          const visible = IsWindowVisible!(hwnd) !== 0;
          const iconic = IsIconic!(hwnd) !== 0;

          if (visible && !iconic) {
            // Alt+Tab style filter: skip system UI, tool windows, non-activatable windows
            const exStyle = GetWindowLongW!(hwnd, GWL_EXSTYLE);
            const hasOwner = GetWindowFn!(hwnd, GW_OWNER) !== 0;

            const isToolWindow = (exStyle & WS_EX_TOOLWINDOW) !== 0;
            const isAppWindow = (exStyle & WS_EX_APPWINDOW) !== 0;
            const isNoActivate = (exStyle & WS_EX_NOACTIVATE) !== 0;

            // Check DWM cloaked state (hidden Windows 11 system UI like 搜尋, 開始, etc.)
            const cloakedBuf = Buffer.alloc(4);
            DwmGetWindowAttribute!(hwnd, DWMWA_CLOAKED, cloakedBuf, 4);
            const isCloaked = cloakedBuf.readUInt32LE(0) !== 0;

            // Skip: cloaked, tool windows (unless APPWINDOW), non-activatable, owned without APPWINDOW
            const skip = isCloaked || (isToolWindow && !isAppWindow) || isNoActivate || (hasOwner && !isAppWindow);
            if (!skip) {
              const rect = { left: 0, top: 0, right: 0, bottom: 0 };
              const grResult = GetWindowRectFn!(hwnd, rect);
              if (grResult !== 0) {
                const w = rect.right - rect.left;
                const h = rect.bottom - rect.top;

                if (w > 0 && h > 0 && w <= 8000 && h <= 8000) {
                  const titleLen = GetWindowTextLengthW!(hwnd);
                  if (titleLen > 0) {
                    const bufSize = titleLen + 1;
                    const titleBuf = Buffer.alloc(bufSize * 2);
                    const actualLen = GetWindowTextW!(hwnd, titleBuf, bufSize);
                    if (actualLen > 0) {
                      const title = titleBuf.toString('utf16le', 0, actualLen * 2);
                      if (title) {
                        results.push({
                          hwnd,
                          title,
                          x: rect.left,
                          y: rect.top,
                          width: w,
                          height: h,
                          zOrder: zOrder++,
                          isForeground: hwnd === foregroundHwnd,
                          isMaximized: IsZoomed ? IsZoomed(hwnd) !== 0 : false,
                        });
                      }
                    }
                  }
                }
              }
            }
          }
        } catch {
          // Skip individual window errors silently
        }
      }

      hwnd = GetWindowFn!(hwnd, GW_HWNDNEXT);
    }
  } catch (e) {
    console.error('[WindowMonitor] GetWindow traversal failed:', e);
  }

  return results;
}

/**
 * Window Monitor using koffi FFI with GetWindow traversal.
 *
 * Uses intptr_t for HWND (plain numbers) and GetWindow loop (no callbacks).
 */
export class WindowMonitor {
  private latestRects: WindowRect[] = [];
  private lastHash = '';
  private timer: ReturnType<typeof setInterval> | null = null;
  private mainWindow: BrowserWindow | null = null;
  private ownHwnd = 0;

  /** Start polling */
  start(mainWindow: BrowserWindow): void {
    this.mainWindow = mainWindow;

    const handle = mainWindow.getNativeWindowHandle();
    if (handle.length >= 8) {
      this.ownHwnd = Number(handle.readBigInt64LE(0));
    } else if (handle.length >= 4) {
      this.ownHwnd = handle.readInt32LE(0);
    }

    this.timer = setInterval(() => {
      this.poll();
    }, POLL_INTERVAL);

    this.poll();
  }

  /** Stop polling */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Get latest cached window rects */
  getLatest(): WindowRect[] {
    return this.latestRects;
  }

  private poll(): void {
    const rects = enumerateWindows(this.ownHwnd);
    const hash = this.hashRects(rects);

    if (hash !== this.lastHash) {
      this.lastHash = hash;
      this.latestRects = rects;

      if (this.mainWindow && !this.mainWindow.isDestroyed()) {
        this.mainWindow.webContents.send('window_layout_changed', rects);
      }
    }
  }

  private hashRects(rects: WindowRect[]): string {
    return rects
      .map((r) => `${r.hwnd}:${r.x},${r.y},${r.width},${r.height},${r.zOrder}`)
      .join('|');
  }
}
