# Electron 主程序開發規則

## 模組職責

| 模組 | 職責 | 狀態 |
|------|------|------|
| main.ts | 應用程式入口、BrowserWindow 建立、protocol 註冊 | ✅ 正常 |
| preload.ts | contextBridge 暴露 IPC API 到 renderer | ✅ 正常 |
| ipcHandlers.ts | 所有 ipcMain.handle() 註冊 | ✅ 正常 |
| fileManager.ts | config.json / animations.json 管理 | ✅ 正常 |
| windowMonitor.ts | PowerShell 子程序視窗列舉 | ✅ 正常 |
| windowRegion.ts | koffi FFI 視窗裁切（SetWindowRgn） | ✅ 正常 |
| systemTray.ts | 系統托盤選單 | ✅ 正常 |

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

## Windows API 使用

- 使用 koffi FFI 呼叫 user32.dll / gdi32.dll
- 所有 koffi 呼叫必須用 try/catch 包裝
- SetWindowRgn 做視窗裁切（遮擋效果）
- 視窗列舉透過 PowerShell 子程序（完全隔離 crash 風險）

## 檔案管理

- 設定目錄：~/.virtual-assistant-desktop/
- config.json 損毀 → 備份為 .bak → 預設值重建 → 記錄 WARN
- animations.json 同步 → 掃描結果與現有設定合併

## 禁止清單

- ❌ 任何 3D 渲染相關邏輯（Three.js 只在 renderer process）
- ❌ 阻塞主執行緒的同步操作（檔案 I/O 除外，因為小檔案）
- ❌ 在 renderer process 中使用 Node.js API（必須透過 preload）
