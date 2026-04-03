import { execFile } from 'node:child_process';
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

/**
 * PowerShell script to enumerate visible windows.
 *
 * Runs EnumWindows in a completely separate process,
 * isolating any potential crash from the Electron main process.
 * Uses C# P/Invoke embedded in PowerShell.
 */
const PS_SCRIPT = `
Add-Type @"
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

public class WinEnum {
    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    static extern bool IsWindowVisible(IntPtr hWnd);

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    static extern bool IsIconic(IntPtr hWnd);

    [DllImport("user32.dll")]
    static extern int GetWindowTextLength(IntPtr hWnd);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    static extern int GetWindowText(IntPtr hWnd, StringBuilder lpString, int nMaxCount);

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);

    [StructLayout(LayoutKind.Sequential)]
    struct RECT { public int Left, Top, Right, Bottom; }

    delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

    public static string GetWindows(long excludeHwnd) {
        var sb = new StringBuilder();
        sb.Append("[");
        int order = 0;
        bool first = true;

        EnumWindows((hWnd, lParam) => {
            if (hWnd.ToInt64() == excludeHwnd) return true;
            if (!IsWindowVisible(hWnd)) return true;
            if (IsIconic(hWnd)) return true;

            RECT rect;
            if (!GetWindowRect(hWnd, out rect)) return true;

            int w = rect.Right - rect.Left;
            int h = rect.Bottom - rect.Top;
            if (w <= 0 || h <= 0) return true;
            if (w > 8000 || h > 8000) return true;

            int len = GetWindowTextLength(hWnd);
            if (len <= 0) return true;

            var buf = new StringBuilder(len + 1);
            GetWindowText(hWnd, buf, len + 1);
            string title = buf.ToString();
            if (string.IsNullOrEmpty(title)) return true;

            // Escape JSON special chars
            title = title.Replace("\\\\", "\\\\\\\\").Replace("\"", "\\\\\"")
                         .Replace("\\n", "\\\\n").Replace("\\r", "\\\\r")
                         .Replace("\\t", "\\\\t");

            if (!first) sb.Append(",");
            first = false;
            sb.AppendFormat(
                "{{\\"hwnd\\":{0},\\"title\\":\\"{1}\\",\\"x\\":{2},\\"y\\":{3},\\"width\\":{4},\\"height\\":{5},\\"zOrder\\":{6}}}",
                hWnd.ToInt64(), title, rect.Left, rect.Top, w, h, order
            );
            order++;
            return true;
        }, IntPtr.Zero);

        sb.Append("]");
        return sb.ToString();
    }
}
"@

[WinEnum]::GetWindows($args[0])
`;

/** Polling interval (300ms) */
const POLL_INTERVAL = 300;

/**
 * Window Monitor using PowerShell subprocess.
 *
 * Enumerates desktop windows in a separate process to avoid
 * the EnumWindows crash that occurred in the Tauri/Rust backend.
 */
export class WindowMonitor {
  private latestRects: WindowRect[] = [];
  private lastHash = '';
  private timer: ReturnType<typeof setInterval> | null = null;
  private mainWindow: BrowserWindow | null = null;
  private ownHwnd = 0;
  private polling = false;

  /** Start polling */
  start(mainWindow: BrowserWindow): void {
    this.mainWindow = mainWindow;

    // Get our own HWND to exclude from enumeration
    const handle = mainWindow.getNativeWindowHandle();
    // On Windows, getNativeWindowHandle() returns a Buffer containing the HWND pointer
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
    // Skip if previous poll is still running
    if (this.polling) return;
    this.polling = true;

    execFile(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy', 'Bypass',
        '-Command', PS_SCRIPT,
        String(this.ownHwnd),
      ],
      { timeout: 5000, maxBuffer: 1024 * 1024 },
      (error, stdout) => {
        this.polling = false;

        if (error) {
          // Don't log every failure — just skip this cycle
          return;
        }

        try {
          const rects = JSON.parse(stdout.trim()) as WindowRect[];
          const hash = this.hashRects(rects);

          if (hash !== this.lastHash) {
            this.lastHash = hash;
            this.latestRects = rects;

            // Notify renderer process
            if (this.mainWindow && !this.mainWindow.isDestroyed()) {
              this.mainWindow.webContents.send('window_layout_changed', rects);
            }
          }
        } catch {
          // Parse error — skip this cycle
        }
      },
    );
  }

  /** Simple hash for change detection */
  private hashRects(rects: WindowRect[]): string {
    return rects
      .map((r) => `${r.hwnd}:${r.x},${r.y},${r.width},${r.height}`)
      .join('|');
  }
}
