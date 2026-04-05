import { BrowserWindow } from 'electron';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

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
let SetWindowRgn: ((hWnd: number, hRgn: number | null, bRedraw: number) => number) | null = null;
let CreateRectRgn: ((x1: number, y1: number, x2: number, y2: number) => number) | null = null;
let CreatePolygonRgn: ((lppt: Buffer, cCount: number, iPolyFillMode: number) => number) | null = null;
let CombineRgn: ((dest: number, src1: number, src2: number, mode: number) => number) | null = null;
let DeleteObject: ((hObject: number) => number) | null = null;
let GetWindowRectFn: ((hWnd: number, lpRect: unknown) => number) | null = null;

// GDI constants
const RGN_DIFF = 4;
const WINDING = 2;

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

    // Define RECT struct (plain JS object pattern, not new StructType())
    koffiModule.struct('WINRECT_RGN', {
      left: 'int',
      top: 'int',
      right: 'int',
      bottom: 'int',
    });

    // Use intptr_t for HWND and HRGN — returns plain numbers, no opaque pointers
    SetWindowRgn = user32.func('int SetWindowRgn(intptr_t hWnd, intptr_t hRgn, int bRedraw)');
    GetWindowRectFn = user32.func('int GetWindowRect(intptr_t hWnd, _Out_ WINRECT_RGN *lpRect)');
    CreateRectRgn = gdi32.func('intptr_t CreateRectRgn(int x1, int y1, int x2, int y2)');
    // CreatePolygonRgn: POINT 陣列用 Buffer 手動編碼（每點 8 bytes: int32 x + int32 y）
    CreatePolygonRgn = gdi32.func('intptr_t CreatePolygonRgn(_In_ const void *lppt, int cCount, int iPolyFillMode)');
    CombineRgn = gdi32.func('int CombineRgn(intptr_t hrgnDest, intptr_t hrgnSrc1, intptr_t hrgnSrc2, int iMode)');
    DeleteObject = gdi32.func('int DeleteObject(intptr_t hObject)');

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
  const hwnd = handle.length >= 8 ? Number(handle.readBigInt64LE(0)) : handle.readInt32LE(0);

  if (excludeRects.length === 0) {
    // Reset to full window (remove region restriction)
    SetWindowRgn!(hwnd, 0, 1);
    return;
  }

  // Get window size using plain JS object (not new StructType())
  const rect = { left: 0, top: 0, right: 0, bottom: 0 };
  GetWindowRectFn!(hwnd, rect);

  const w = rect.right - rect.left;
  const h = rect.bottom - rect.top;

  if (w <= 0 || h <= 0) return;

  // Create full window region
  const fullRegion = CreateRectRgn!(0, 0, w, h);

  // Subtract each exclude rect
  for (const r of excludeRects) {
    const excludeRegion = CreateRectRgn!(r.x, r.y, r.x + r.width, r.y + r.height);
    CombineRgn!(fullRegion, fullRegion, excludeRegion, RGN_DIFF);
    DeleteObject!(excludeRegion);
  }

  // Apply region (SetWindowRgn takes ownership, no need to delete)
  SetWindowRgn!(hwnd, fullRegion, 1);
}

/** Point for polygon region */
interface PolygonPoint {
  x: number;
  y: number;
}

/**
 * Set window region using polygon shape for precise silhouette occlusion.
 *
 * Uses Windows CreatePolygonRgn API via koffi FFI.
 * Pass empty array to reset to full window.
 *
 * POINT 陣列用 Buffer 手動編碼：每點 8 bytes（int32 x + int32 y），
 * 避免 koffi struct 陣列的不確定行為。
 */
export function setWindowPolygonRegion(mainWindow: BrowserWindow, points: PolygonPoint[]): void {
  if (!ensureKoffi()) return;

  const handle = mainWindow.getNativeWindowHandle();
  const hwnd = handle.length >= 8 ? Number(handle.readBigInt64LE(0)) : handle.readInt32LE(0);

  if (points.length === 0) {
    // Reset to full window (remove region restriction)
    SetWindowRgn!(hwnd, 0, 1);
    return;
  }

  if (points.length < 3 || points.length > 500) return;

  // Get window size
  const rect = { left: 0, top: 0, right: 0, bottom: 0 };
  GetWindowRectFn!(hwnd, rect);

  const w = rect.right - rect.left;
  const h = rect.bottom - rect.top;

  if (w <= 0 || h <= 0) return;

  try {
    // Encode POINT array as raw Buffer (int32 x, int32 y per point)
    const buf = Buffer.alloc(points.length * 8);
    for (let i = 0; i < points.length; i++) {
      buf.writeInt32LE(Math.round(points[i].x), i * 8);
      buf.writeInt32LE(Math.round(points[i].y), i * 8 + 4);
    }

    const polyRegion = CreatePolygonRgn!(buf, points.length, WINDING);
    if (!polyRegion) {
      // Fallback: reset to full window
      SetWindowRgn!(hwnd, 0, 1);
      return;
    }

    // Create full window region, then subtract polygon
    const fullRegion = CreateRectRgn!(0, 0, w, h);
    CombineRgn!(fullRegion, fullRegion, polyRegion, RGN_DIFF);
    DeleteObject!(polyRegion);

    SetWindowRgn!(hwnd, fullRegion, 1);
  } catch (e) {
    console.error('[WindowRegion] setWindowPolygonRegion failed:', e);
    // Fallback: reset to full window
    SetWindowRgn!(hwnd, 0, 1);
  }
}
