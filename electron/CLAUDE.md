# Electron 主程序開發規則

## 模組職責

| 模組 | 職責 | 狀態 |
|------|------|------|
| main.ts | 應用程式入口、BrowserWindow 建立、local-file protocol 註冊 | ✅ 正常 |
| preload.ts | contextBridge 暴露 IPC API 到 renderer | ✅ 正常 |
| ipcHandlers.ts | 所有 ipcMain.handle() 註冊（含 workArea） | ✅ 正常 |
| fileManager.ts | config.json / animations.json 管理 | ✅ 正常 |
| windowMonitor.ts | koffi GetWindow 遍歷視窗列舉 + DWM cloaked 過濾 | ✅ 正常 |
| windowRegion.ts | koffi FFI 視窗裁切（SetWindowRgn） | ⚠️ struct 建構有問題，待修正 |
| systemTray.ts | 系統托盤選單（含重置回正中央） | ✅ 正常 |

## IPC Handler 模板

```typescript
// 在 ipcHandlers.ts 中註冊
ipcMain.handle('command_name', async (_event, arg1: Type1) => {
  // 實作邏輯
  return result;
});

// 在 preload.ts 中暴露
commandName: (arg1: Type1) => ipcRenderer.invoke('command_name', arg1),

// 在 ElectronIPC.ts 中包裝
async commandName(arg1: Type1): Promise<ResultType> {
  try {
    return await window.electronAPI.commandName(arg1);
  } catch (e) {
    console.warn('[ElectronIPC] commandName failed:', e);
    return fallbackValue;
  }
}
```

新增 IPC 呼叫必須同時更新三個檔案。

## Windows API 使用（koffi FFI）

- 使用 koffi FFI 呼叫 user32.dll / gdi32.dll / dwmapi.dll
- 所有 koffi 呼叫必須用 try/catch 包裝
- HWND 用 `intptr_t` 宣告（回傳 plain number，避免 opaque pointer）
- struct 用 plain JS object `{ left: 0, top: 0, ... }`（不用 `new StructType()`）
- ESM 模組中用 `createRequire(import.meta.url)` 載入 koffi
- 視窗列舉：GetDesktopWindow + GetWindow(GW_CHILD/GW_HWNDNEXT) 遍歷
- 視窗過濾：IsWindowVisible + IsIconic + WS_EX_TOOLWINDOW + DwmGetWindowAttribute(DWMWA_CLOAKED)
- SetWindowRgn 做視窗裁切（遮擋效果）

## 檔案管理

- 設定目錄：~/.virtual-assistant-desktop/
- config.json 損毀 → 備份為 .bak → 預設值重建 → 記錄 WARN
- animations.json 同步 → 掃描結果與現有設定合併

## 禁止清單

- ❌ 任何 3D 渲染相關邏輯（Three.js 只在 renderer process）
- ❌ 阻塞主執行緒的同步操作（檔案 I/O 除外，因為小檔案）
- ❌ 在 renderer process 中使用 Node.js API（必須透過 preload）
- ❌ koffi callback（EnumWindows callback 不穩定，改用 GetWindow 遍歷）
- ❌ `void *` 作為 HWND 型別（改用 `intptr_t`）
