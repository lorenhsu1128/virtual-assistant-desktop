# Electron 主程序開發規則

> 目標平台：Windows 10/11 + macOS 11+。所有平台分支必須集中於 `electron/platform/`。

## 模組職責

| 模組 | 職責 | 狀態 |
|------|------|------|
| main.ts | 應用程式入口、BrowserWindow 建立、local-file protocol 註冊 | ✅ 正常 |
| preload.ts | contextBridge 暴露 IPC API 到 renderer | ✅ 正常 |
| ipcHandlers.ts | 所有 ipcMain.handle() 註冊（含 workArea） | ✅ 正常 |
| fileManager.ts | config.json / animations.json 管理 | ✅ 正常 |
| windowMonitor.ts | koffi GetWindow 遍歷視窗列舉 + DWM cloaked 過濾（**Windows-only**） | ✅ 正常 |
| systemTray.ts | 系統托盤選單（含重置回正中央） | ✅ 正常 |
| vrmPickerWindow.ts | VRM 模型瀏覽對話框 BrowserWindow 管理 | ✅ 正常 |
| settingsWindow.ts | 桌寵設定 BrowserWindow（沿用 picker 模板） | ✅ 正常 |
| agent/AgentRuntime.ts | M-MASCOT-EMBED：in-process AgentEmbedded lifecycle + state machine（disabled / preloading / standby / active / unloading / error）+ G7 三 opt-in 服務 handle（daemonHandle / discordHandle / webUiHandle）+ autoStartServices / stopAllServices + 'servicesChanged' event 廣播 | ✅ 正常（v0.4 + G7） |
| agent/mascotTools.ts | 4 mascot tool 定義（my-agent Tool 格式注入 extraTools） | ✅ 正常（v0.4） |
| agent/MascotMcpServer.ts | HTTP MCP server — 給 opt-in daemon 模式用（外部 my-agent CLI 連入時走此） | 🟡 條件啟用（Phase 5c+） |
| agent/mcpRegistration.ts | `cli mcp add --scope user` 把 MascotMcpServer 註冊到 my-agent — opt-in daemon 才需要 | 🟡 條件啟用（Phase 5c+） |
| agent/agentBubbleWindow.ts | 對話氣泡 BrowserWindow（透明，沿用 picker 模板） | ✅ 正常 |
| agent/agentIpcHandlers.ts | agent_* IPC commands + frame 廣播 + llm_status_changed 事件 | ✅ 正常 |
| ~~agent/AgentDaemonManager.ts~~ | _（v0.4 已刪除：被 AgentRuntime 取代；commits 230ea42→15edaf8）_ | ❌ 已刪 |
| ~~agent/AgentSessionClient.ts~~ | _（v0.4 已刪除：in-process EventEmitter 取代 ws client）_ | ❌ 已刪 |
| platform/index.ts | `isWindows` / `isMac` 旗標 + 統一匯出 | ✅ 正常 |
| platform/windowConfig.ts | 各平台 BrowserWindow 參數與建立後設定（主視窗 / picker / agent bubble） | ✅ 正常 |
| platform/protocolHelper.ts | local-file 協定路徑解析（兩平台行為不同） | ✅ 正常 |
| platform/agentPaths.ts | workspace 路徑 + （opt-in daemon 模式才用）my-agent CLI 路徑 | 🟡 部分使用（embedded 模式僅用 ensureAgentWorkspace） |

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

## Windows API 使用（koffi FFI，**僅 Windows 啟用**）

> macOS 上不可載入 koffi。所有 koffi 呼叫必須先檢查 `isWindows`，否則整個模組或函式須早走 return。

- 使用 koffi FFI 呼叫 user32.dll / gdi32.dll / dwmapi.dll
- 所有 koffi 呼叫必須用 try/catch 包裝
- HWND 用 `intptr_t` 宣告（回傳 plain number，避免 opaque pointer）
- struct 用 plain JS object `{ left: 0, top: 0, ... }`（不用 `new StructType()`）
- ESM 模組中用 `createRequire(import.meta.url)` 載入 koffi
- 視窗列舉：GetDesktopWindow + GetWindow(GW_CHILD/GW_HWNDNEXT) 遍歷
- 視窗過濾：IsWindowVisible + IsIconic + WS_EX_TOOLWINDOW + DwmGetWindowAttribute(DWMWA_CLOAKED)
- 視窗遮擋改用 3D depth-only mesh（前端 WindowMeshManager），不再使用 SetWindowRgn

## 跨平台守則

1. **統一旗標**：需要平台判斷時 `import { isWindows, isMac } from './platform/index.js'`，禁止散落 `process.platform === ...` 字串比對。
2. **BrowserWindow 建立**：透過 `getWindowOptions(bounds)` + `applyPostCreateSetup(win, bounds)` 取得參數，main.ts 不寫平台分支。
3. **IPC handler 平台早走**：handler 內若呼叫平台 API，必須有 `if (!isWindows) return defaultValue;`，回傳的型別在兩平台必須一致。
4. **系統 API 不可 throw**：koffi、AppleScript 等若不支援，回傳 `null` / `[]` / `false` 並 log warning。renderer 端透過 ElectronIPC 已有 try/catch 與快取 fallback，須維持。
5. **新增模組命名**：若是 Windows-only（如 windowMonitor），檔名加註 / JSDoc 標明；macOS-only 同理。理想狀態是模組本身跨平台、差異透過 platform/ 注入。
6. **新功能 commit 須註明**：commit 訊息加上「測試於 Windows / macOS」說明，未測試的平台須註記預期行為。

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
