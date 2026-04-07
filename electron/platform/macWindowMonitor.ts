/**
 * macOS 視窗列舉模組
 *
 * 使用 koffi FFI 載入 CoreGraphics + CoreFoundation 框架，
 * 呼叫 CGWindowListCopyWindowInfo 取得所有可見視窗的位置與大小。
 * 輸出與 Windows 版本相同格式的 WindowRect[]。
 *
 * 座標處理：CGWindow 回傳 points（邏輯像素），但 renderer 端預期物理像素
 * （因為 Windows 的 GetWindowRect 回傳物理像素）。
 * 為保持 renderer 端 `/ devicePixelRatio` 的一致性，
 * 此模組將座標乘以 scaleFactor 再回傳。
 *
 * **僅 macOS 使用**，Windows / Linux 上不載入。
 */

import { createRequire } from 'node:module';
import { screen } from 'electron';
import type { WindowRect } from '../windowMonitor.js';

const require = createRequire(import.meta.url);

// ── 狀態 ──

let cgLoaded = false;

// ── CoreGraphics 函式 ──

let CGWindowListCopyWindowInfo: ((option: number, relativeToWindow: number) => unknown) | null = null;
let CGRectMakeWithDictionaryRepresentation: ((dict: unknown, rect: { x: number; y: number; width: number; height: number }) => boolean) | null = null;

// ── CoreFoundation 函式 ──

let CFArrayGetCount: ((arr: unknown) => number) | null = null;
let CFArrayGetValueAtIndex: ((arr: unknown, idx: number) => unknown) | null = null;
let CFDictionaryGetValue: ((dict: unknown, key: unknown) => unknown) | null = null;
let CFNumberGetValue: ((num: unknown, type: number, valuePtr: Buffer) => boolean) | null = null;
let CFStringCreateWithCString: ((alloc: unknown, str: string, encoding: number) => unknown) | null = null;
let CFStringGetLength: ((str: unknown) => number) | null = null;
let CFStringGetCString: ((str: unknown, buf: Buffer, size: number, encoding: number) => boolean) | null = null;
let CFRelease: ((cf: unknown) => void) | null = null;

// ── 預建 CFString key（模組級保存，避免每次 poll 重建） ──

let keyWindowNumber: unknown = null;
let keyWindowName: unknown = null;
let keyOwnerName: unknown = null;
let keyOwnerPID: unknown = null;
let keyWindowBounds: unknown = null;
let keyWindowLayer: unknown = null;

// ── 常數 ──

/** CFStringEncoding: UTF-8 */
const kCFStringEncodingUTF8 = 0x08000100;
/** CFNumberType: SInt32（適用於 windowNumber, layer, PID） */
const kCFNumberSInt32Type = 3;
/** 只列出螢幕上可見的視窗 */
const kCGWindowListOptionOnScreenOnly = 1;
/** 排除桌面背景、Dock、Menu Bar 等系統元素 */
const kCGWindowListExcludeDesktopElements = 16;

/** 預配置 Buffer（避免每次 poll 重新配置） */
const reusableNumBuf = Buffer.alloc(4);
const reusableTitleBuf = Buffer.alloc(1024);

/**
 * 載入 CoreGraphics 和 CoreFoundation 框架，綁定所需的 C 函式。
 * 僅在 macOS 上執行，其他平台回傳 false。
 */
function ensureCoreGraphics(): boolean {
  if (cgLoaded) return true;

  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const koffi = require('koffi');

    const cg = koffi.load('/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics');
    const cf = koffi.load('/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation');

    // CGRect 結構（記憶體佈局等同 CGPoint + CGSize，4 個 double）
    koffi.struct('CGRect2', {
      x: 'double',
      y: 'double',
      width: 'double',
      height: 'double',
    });

    // ── CoreGraphics 綁定 ──
    CGWindowListCopyWindowInfo = cg.func(
      'void* CGWindowListCopyWindowInfo(uint32 option, uint32 relativeToWindow)'
    );
    CGRectMakeWithDictionaryRepresentation = cg.func(
      'bool CGRectMakeWithDictionaryRepresentation(void* dict, _Out_ CGRect2* rect)'
    );

    // ── CoreFoundation 綁定 ──
    CFArrayGetCount = cf.func('long CFArrayGetCount(void* theArray)');
    CFArrayGetValueAtIndex = cf.func('void* CFArrayGetValueAtIndex(void* theArray, long idx)');
    CFDictionaryGetValue = cf.func('void* CFDictionaryGetValue(void* theDict, void* key)');
    CFNumberGetValue = cf.func(
      'bool CFNumberGetValue(void* number, long theType, _Out_ uint8_t* valuePtr)'
    );
    CFStringCreateWithCString = cf.func(
      'void* CFStringCreateWithCString(void* alloc, str cStr, uint32 encoding)'
    );
    CFStringGetLength = cf.func('long CFStringGetLength(void* theString)');
    CFStringGetCString = cf.func(
      'bool CFStringGetCString(void* theString, _Out_ uint8_t* buffer, long bufferSize, uint32 encoding)'
    );
    CFRelease = cf.func('void CFRelease(void* cf)');

    // ── 預建 dictionary key 字串 ──
    // CFStringCreateWithCString 在上方已綁定，此處一定非 null
    const createStr = CFStringCreateWithCString!;
    keyWindowNumber = createStr(null, 'kCGWindowNumber', kCFStringEncodingUTF8);
    keyWindowName = createStr(null, 'kCGWindowName', kCFStringEncodingUTF8);
    keyOwnerName = createStr(null, 'kCGWindowOwnerName', kCFStringEncodingUTF8);
    keyOwnerPID = createStr(null, 'kCGWindowOwnerPID', kCFStringEncodingUTF8);
    keyWindowBounds = createStr(null, 'kCGWindowBounds', kCFStringEncodingUTF8);
    keyWindowLayer = createStr(null, 'kCGWindowLayer', kCFStringEncodingUTF8);

    cgLoaded = true;
    console.log('[macWindowMonitor] CoreGraphics + CoreFoundation loaded OK');
    return true;
  } catch (e) {
    console.error('[macWindowMonitor] Failed to load CoreGraphics:', e);
    return false;
  }
}

// ── CF 型別 helper ──

/** 從 CFDictionary 取得 CFNumber 的 int32 值 */
function getCFNumber(dict: unknown, key: unknown): number {
  const val = CFDictionaryGetValue!(dict, key);
  if (!val) return 0;
  reusableNumBuf.fill(0);
  const ok = CFNumberGetValue!(val, kCFNumberSInt32Type, reusableNumBuf);
  return ok ? reusableNumBuf.readInt32LE(0) : 0;
}

/** 從 CFDictionary 取得 CFString 值，回傳 null 表示不存在或為空 */
function getCFString(dict: unknown, key: unknown): string | null {
  const val = CFDictionaryGetValue!(dict, key);
  if (!val) return null;
  const len = CFStringGetLength!(val);
  if (len <= 0) return null;

  // UTF-8 最多 4 bytes/char，確保 buffer 足夠
  const bufSize = Math.min(len * 4 + 1, reusableTitleBuf.length);
  reusableTitleBuf.fill(0, 0, bufSize);
  const ok = CFStringGetCString!(val, reusableTitleBuf, bufSize, kCFStringEncodingUTF8);
  if (!ok) return null;

  // 找到 null terminator 位置
  const nullPos = reusableTitleBuf.indexOf(0);
  return reusableTitleBuf.toString('utf8', 0, nullPos > 0 ? nullPos : bufSize - 1);
}

/** 根據視窗左上角座標查找對應螢幕的 scaleFactor（多螢幕支援） */
function getScaleForPoint(
  x: number,
  y: number,
  displays: Electron.Display[],
  fallback: number
): number {
  for (const d of displays) {
    if (
      x >= d.bounds.x &&
      x < d.bounds.x + d.bounds.width &&
      y >= d.bounds.y &&
      y < d.bounds.y + d.bounds.height
    ) {
      return d.scaleFactor;
    }
  }
  return fallback;
}

/**
 * 列舉 macOS 上所有可見視窗，回傳與 Windows 版本相同格式的 WindowRect[]。
 *
 * @param ownPid - 自身程序的 PID，用於排除桌寵視窗
 * @returns WindowRect[] — 座標已乘以 scaleFactor（讓 renderer 的 /dpr 正確）
 */
export function enumerateWindowsMac(ownPid: number): WindowRect[] {
  if (!ensureCoreGraphics()) return [];

  const windowList = CGWindowListCopyWindowInfo!(
    kCGWindowListOptionOnScreenOnly | kCGWindowListExcludeDesktopElements,
    0 // kCGNullWindowID
  );
  if (!windowList) return [];

  const results: WindowRect[] = [];

  // 取得所有螢幕資訊，用於多螢幕場景下根據視窗位置查找對應的 scaleFactor
  // macOS CGWindow 回傳 points（邏輯像素），renderer 預期物理像素
  // 乘以 scaleFactor 後，renderer 的 `/ devicePixelRatio` 會還原回正確的 points
  const allDisplays = screen.getAllDisplays();
  const primaryScaleFactor = screen.getPrimaryDisplay().scaleFactor;

  try {
    const count = CFArrayGetCount!(windowList);
    let zOrder = 0;
    let firstNormalWindow = true;

    const MAX_WINDOWS = 200;

    for (let i = 0; i < count && zOrder < MAX_WINDOWS; i++) {
      try {
        const dict = CFArrayGetValueAtIndex!(windowList, i);
        if (!dict) continue;

        // 只保留 layer == 0 的普通視窗（排除 Dock、Menu Bar、Spotlight 等）
        const layer = getCFNumber(dict, keyWindowLayer);
        if (layer !== 0) continue;

        // 排除自身程序的視窗
        const pid = getCFNumber(dict, keyOwnerPID);
        if (pid === ownPid) continue;

        // 取得視窗邊界
        const boundsDict = CFDictionaryGetValue!(dict, keyWindowBounds);
        if (!boundsDict) continue;

        const rect = { x: 0, y: 0, width: 0, height: 0 };
        const ok = CGRectMakeWithDictionaryRepresentation!(boundsDict, rect);
        if (!ok) continue;

        // 排除零尺寸或異常尺寸視窗
        if (rect.width <= 0 || rect.height <= 0) continue;
        if (rect.width > 8000 || rect.height > 8000) continue;

        // 取得視窗 ID
        const windowId = getCFNumber(dict, keyWindowNumber);
        if (windowId <= 0) continue;

        // 取得標題（需 Screen Recording 權限，否則為空）
        // fallback 到程序名稱（永遠可用）
        const windowName = getCFString(dict, keyWindowName);
        const ownerName = getCFString(dict, keyOwnerName);
        const title = windowName || ownerName || 'Unknown';

        // 判定 isForeground：第一個通過過濾的 layer-0 視窗即為最前面的
        const isForeground = firstNormalWindow;
        firstNormalWindow = false;

        // 多螢幕：根據視窗中心點查找對應螢幕的 scaleFactor
        const sf = getScaleForPoint(rect.x, rect.y, allDisplays, primaryScaleFactor);

        results.push({
          hwnd: windowId,
          title,
          // 座標乘以 scaleFactor（points → 假物理像素），讓 renderer 的 /dpr 正確
          x: Math.round(rect.x * sf),
          y: Math.round(rect.y * sf),
          width: Math.round(rect.width * sf),
          height: Math.round(rect.height * sf),
          zOrder: zOrder++,
          isForeground,
          isMaximized: false, // macOS 無法從外部查詢其他視窗的最大化狀態
        });
      } catch {
        // 跳過個別視窗的錯誤
      }
    }
  } finally {
    // CGWindowListCopyWindowInfo 名稱含 "Copy"，必須 CFRelease
    if (CFRelease) CFRelease(windowList);
  }

  return results;
}
