import { BrowserWindow } from 'electron';

/** Window rectangle data (matches TypeScript WindowRect interface) */
export interface WindowRect {
  hwnd: number;
  title: string;
  x: number;
  y: number;
  width: number;
  height: number;
  zOrder: number;
}

/** Polling interval (300ms) */
const POLL_INTERVAL = 300;

// koffi bindings (loaded lazily)
let koffiLoaded = false;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let koffiModule: any = null;
let EnumWindows: ((callback: unknown, lParam: number) => number) | null = null;
let IsWindowVisible: ((hWnd: unknown) => number) | null = null;
let IsIconic: ((hWnd: unknown) => number) | null = null;
let GetWindowTextLengthW: ((hWnd: unknown) => number) | null = null;
let GetWindowTextW: ((hWnd: unknown, lpString: unknown, nMaxCount: number) => number) | null = null;
let GetWindowRect: ((hWnd: unknown, lpRect: unknown) => number) | null = null;

/**
 * Load koffi and bind Windows API functions for window enumeration.
 */
function ensureKoffi(): boolean {
  if (koffiLoaded) return true;

  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    koffiModule = require('koffi');

    const user32 = koffiModule.load('user32.dll');

    // Define RECT struct
    koffiModule.struct('ENUMRECT', {
      left: 'int',
      top: 'int',
      right: 'int',
      bottom: 'int',
    });

    // Define callback type for EnumWindows (registered by name in koffi)
    koffiModule.proto('bool EnumWindowsProc(void *hWnd, intptr_t lParam)');

    EnumWindows = user32.func('bool EnumWindows(EnumWindowsProc *lpEnumFunc, intptr_t lParam)');
    IsWindowVisible = user32.func('bool IsWindowVisible(void *hWnd)');
    IsIconic = user32.func('bool IsIconic(void *hWnd)');
    GetWindowTextLengthW = user32.func('int GetWindowTextLengthW(void *hWnd)');
    GetWindowTextW = user32.func('int GetWindowTextW(void *hWnd, _Out_ uint16_t *lpString, int nMaxCount)');
    GetWindowRect = user32.func('bool GetWindowRect(void *hWnd, _Out_ ENUMRECT *lpRect)');

    koffiLoaded = true;
    return true;
  } catch (e) {
    console.error('[WindowMonitor] Failed to load koffi:', e);
    return false;
  }
}

/**
 * Enumerate all visible windows using koffi FFI.
 *
 * Calls EnumWindows directly from the Electron main process.
 * Filters out: invisible, minimized, zero-size, oversized, untitled,
 * and the mascot's own window.
 */
function enumerateWindows(ownHwnd: number): WindowRect[] {
  if (!ensureKoffi()) return [];

  const results: WindowRect[] = [];
  let zOrder = 0;

  try {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
    const ENUMRECT = koffiModule.struct('ENUMRECT');

    const callback = koffiModule.register(
      (hWnd: unknown, _lParam: number) => {
        try {
          // Skip own window
          // koffi returns pointers as numbers or objects depending on version
          const hwndNum = typeof hWnd === 'number' ? hWnd : Number(hWnd);
          if (hwndNum === ownHwnd) return true;

          // Skip invisible windows
          if (!IsWindowVisible!(hWnd)) return true;

          // Skip minimized windows
          if (IsIconic!(hWnd)) return true;

          // Get window rect
          // eslint-disable-next-line @typescript-eslint/no-unsafe-call
          const rect = new ENUMRECT();
          if (!GetWindowRect!(hWnd, rect)) return true;

          const w = rect.right - rect.left;
          const h = rect.bottom - rect.top;

          // Skip zero-size or oversized windows
          if (w <= 0 || h <= 0) return true;
          if (w > 8000 || h > 8000) return true;

          // Get window title
          const titleLen = GetWindowTextLengthW!(hWnd);
          if (titleLen <= 0) return true;

          const bufSize = titleLen + 1;
          const titleBuf = Buffer.alloc(bufSize * 2); // UTF-16LE
          const actualLen = GetWindowTextW!(hWnd, titleBuf, bufSize);
          if (actualLen <= 0) return true;

          const title = titleBuf.toString('utf16le', 0, actualLen * 2);
          if (!title) return true;

          results.push({
            hwnd: hwndNum,
            title,
            x: rect.left,
            y: rect.top,
            width: w,
            height: h,
            zOrder: zOrder++,
          });
        } catch {
          // Skip this window on error
        }
        return true;
      },
      koffiModule.proto('bool EnumWindowsProc(void *hWnd, intptr_t lParam)'),
    );

    EnumWindows!(callback, 0);
  } catch (e) {
    console.error('[WindowMonitor] EnumWindows failed:', e);
  }

  return results;
}

/**
 * Window Monitor using koffi FFI.
 *
 * Directly calls Windows API (EnumWindows) from the Electron main process
 * via koffi, without PowerShell subprocess overhead.
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

    // Get our own HWND to exclude from enumeration
    const handle = mainWindow.getNativeWindowHandle();
    if (handle.length >= 8) {
      this.ownHwnd = Number(handle.readBigInt64LE(0));
    } else if (handle.length >= 4) {
      this.ownHwnd = handle.readInt32LE(0);
    }

    this.timer = setInterval(() => {
      this.poll();
    }, POLL_INTERVAL);

    // Initial poll
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

      // Notify renderer process
      if (this.mainWindow && !this.mainWindow.isDestroyed()) {
        this.mainWindow.webContents.send('window_layout_changed', rects);
      }
    }
  }

  /** Simple hash for change detection */
  private hashRects(rects: WindowRect[]): string {
    return rects
      .map((r) => `${r.hwnd}:${r.x},${r.y},${r.width},${r.height}`)
      .join('|');
  }
}
