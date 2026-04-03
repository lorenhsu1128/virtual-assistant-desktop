import { BrowserWindow } from 'electron';

/** Rectangle for window region clipping */
export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

// koffi is loaded lazily to avoid startup cost if not needed
let koffiLoaded = false;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let koffiModule: any = null;
let SetWindowRgn: ((hWnd: unknown, hRgn: unknown, bRedraw: number) => number) | null = null;
let CreateRectRgn: ((x1: number, y1: number, x2: number, y2: number) => unknown) | null = null;
let CombineRgn: ((dest: unknown, src1: unknown, src2: unknown, mode: number) => number) | null = null;
let DeleteObject: ((hObject: unknown) => number) | null = null;
let GetWindowRect: ((hWnd: unknown, lpRect: unknown) => number) | null = null;

// RGN_DIFF constant
const RGN_DIFF = 4;

/**
 * Load koffi and bind Windows API functions.
 * Called lazily on first use.
 */
function ensureKoffi(): boolean {
  if (koffiLoaded) return true;

  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    koffiModule = require('koffi');

    const user32 = koffiModule.load('user32.dll');
    const gdi32 = koffiModule.load('gdi32.dll');

    // Define RECT struct for GetWindowRect (used by koffi via type name 'RECT')
    koffiModule.struct('RECT', {
      left: 'int',
      top: 'int',
      right: 'int',
      bottom: 'int',
    });

    SetWindowRgn = user32.func('int SetWindowRgn(void *hWnd, void *hRgn, int bRedraw)');
    GetWindowRect = user32.func('int GetWindowRect(void *hWnd, _Out_ RECT *lpRect)');
    CreateRectRgn = gdi32.func('void *CreateRectRgn(int x1, int y1, int x2, int y2)');
    CombineRgn = gdi32.func('int CombineRgn(void *hrgnDest, void *hrgnSrc1, void *hrgnSrc2, int iMode)');
    DeleteObject = gdi32.func('int DeleteObject(void *hObject)');

    koffiLoaded = true;
    return true;
  } catch (e) {
    console.error('[WindowRegion] Failed to load koffi:', e);
    return false;
  }
}

/**
 * Set window region to clip (occlude) specified rectangles.
 *
 * Uses Windows SetWindowRgn API via koffi FFI.
 * Pass empty array to reset to full window.
 */
export function setWindowRegion(mainWindow: BrowserWindow, excludeRects: Rect[]): void {
  if (!ensureKoffi()) return;

  const handle = mainWindow.getNativeWindowHandle();
  // Convert Buffer to pointer value for koffi
  let hwndPtr: unknown;
  if (handle.length >= 8) {
    hwndPtr = Number(handle.readBigInt64LE(0));
  } else {
    hwndPtr = handle.readInt32LE(0);
  }

  if (excludeRects.length === 0) {
    // Reset to full window (remove region restriction)
    SetWindowRgn!(hwndPtr, null, 1);
    return;
  }

  // Get window size to create full region
  // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
  const rect = new (koffiModule.struct('RECT'))();
  GetWindowRect!(hwndPtr, rect);

  const w = rect.right - rect.left;
  const h = rect.bottom - rect.top;

  // Create full window region
  const fullRegion = CreateRectRgn!(0, 0, w, h);

  // Subtract each exclude rect
  for (const r of excludeRects) {
    const excludeRegion = CreateRectRgn!(r.x, r.y, r.x + r.width, r.y + r.height);
    CombineRgn!(fullRegion, fullRegion, excludeRegion, RGN_DIFF);
    DeleteObject!(excludeRegion);
  }

  // Apply region (SetWindowRgn takes ownership, no need to delete)
  SetWindowRgn!(hwndPtr, fullRegion, 1);
}
