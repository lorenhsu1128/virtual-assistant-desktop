Rule: Electron 主程序安全規則 + 跨平台守則

When editing any file in electron/:
- NEVER include any 3D rendering logic (Three.js runs in renderer only)
- NEVER block the main thread with synchronous operations
- Windows API calls via koffi MUST be wrapped in try/catch
- Windows API calls via koffi MUST be guarded by `isWindows` check from `electron/platform/`
- All IPC handlers must be registered in ipcHandlers.ts
- Check LESSONS.md for past mistakes

Cross-platform rules (Windows + macOS):
- NEVER use `process.platform === 'win32'` / `'darwin'` outside `electron/platform/` — import `isWindows` / `isMac` instead
- Platform-specific BrowserWindow params MUST go through `getWindowOptions(bounds)` and `applyPostCreateSetup(win, bounds)`
- System API failures (koffi, AppleScript, native modules) MUST degrade gracefully — return default value (null / [] / false) and log warning, NEVER throw
- IPC handler signatures and return types MUST be identical on both platforms (handle differences inside the handler)
- New features MUST be testable on both Windows and macOS — commit message should note which platform was tested
- macOS does NOT support koffi window enumeration / SetWindowRgn — features depending on these must early-return on macOS
