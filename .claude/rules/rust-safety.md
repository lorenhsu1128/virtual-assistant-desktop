Rule: Electron 主程序安全規則

When editing any file in electron/:
- NEVER include any 3D rendering logic (Three.js runs in renderer only)
- NEVER block the main thread with synchronous operations
- Windows API calls via koffi must be wrapped in try/catch
- All IPC handlers must be registered in ipcHandlers.ts
- Check LESSONS.md for past mistakes
