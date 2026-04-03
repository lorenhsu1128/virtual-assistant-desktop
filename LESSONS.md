# 已知問題與教訓 (Lessons Learned)

> **此檔案是 AI 的「錯誤記憶」。**
> 每當 Claude Code 犯錯並被修正後，將錯誤記錄在此。
> 此檔案被 CLAUDE.md 引用（@LESSONS.md），因此每次對話都會載入。
> 
> 格式：日期 + 錯誤描述 + 正確做法 + 受影響的檔案

---

## 架構違規

### [範例] 2026-04-03 — StateMachine 中誤用 Three.js

- **錯誤**：在 `StateMachine.ts` 中 `import { Vector3 } from 'three'` 來計算移動方向
- **正確做法**：StateMachine 是純邏輯模組，不得 import Three.js。使用 `{ x: number, y: number }` 的純資料型別代替 Vector3
- **受影響檔案**：`src/behavior/StateMachine.ts`
- **根因**：Vector3 看起來方便，但引入 Three.js 依賴會破壞純邏輯模組的可測試性

---

## IPC 通訊

### [範例] 2026-04-03 — 直接使用 invoke() 繞過 TauriIPC

- **錯誤**：在 `DragHandler.ts` 中直接 `import { invoke } from '@tauri-apps/api/core'`
- **正確做法**：所有 IPC 呼叫必須透過 `bridge/TauriIPC.ts`，由 TauriIPC 統一處理錯誤和 fallback
- **受影響檔案**：`src/interaction/DragHandler.ts`
- **根因**：直接 invoke 會繞過統一的錯誤處理策略，IPC 失敗時可能中斷 render loop

---

## Rust 後端

### [2026-04-03] — EnumWindows callback 導致 access violation crash

- **錯誤**：使用 `EnumWindows` + `unsafe extern "system" fn` callback 列舉視窗，在背景執行緒中運行。程式啟動後立即 crash（exit code -1 / 4294967295），`catch_unwind` 無法捕捉（不是 Rust panic）
- **正確做法**：避免 `EnumWindows` callback。改用 `GetDesktopWindow()` + `GetWindow(GW_CHILD)` + `GetWindow(GW_HWNDNEXT)` 逐一遍歷視窗鏈（safe API，無 callback）
- **受影響檔案**：`src-tauri/src/window_monitor.rs`
- **根因**：`EnumWindows` 的 callback 在某些系統/視窗組合下會觸發 access violation。raw pointer 傳遞 context 可能在特定條件下失效

### [2026-04-03] — WindowMonitor 背景執行緒導致啟動 crash

- **錯誤**：在 Tauri `setup` 中啟動 `WindowMonitor::start()` 背景執行緒，即使改用 safe GetWindow API，程式仍然 crash（exit code 1）
- **正確做法**：⚠️ **尚未解決**。目前使用 `new_inactive()` 停用視窗監控。可能的替代方案：前端定時 IPC 呼叫 `get_window_list`，Rust 側同步列舉（不用背景執行緒）——但此方案也曾導致 crash，需進一步調查
- **受影響檔案**：`src-tauri/src/lib.rs`, `src-tauri/src/window_monitor.rs`
- **根因**：不確定。可能是執行緒與 Tauri 事件系統的交互問題，或 Windows API 在特定時機呼叫不安全

### [2026-04-03] — windows-rs 0.61 API 回傳 Result 而非裸值

- **錯誤**：假設 `GetWindow()` 回傳 `HWND`，但 windows-rs 0.61 改為回傳 `Result<HWND>`。`SetWindowRgn` 從 `WindowsAndMessaging` 移到 `Graphics::Gdi`。`BOOL` 從 `Win32::Foundation` 移到 `windows::core::BOOL`
- **正確做法**：所有 windows-rs API 呼叫都要檢查回傳型別，使用 `match` 或 `?` 處理 Result
- **受影響檔案**：`src-tauri/src/commands/window_commands.rs`, `src-tauri/src/window_monitor.rs`
- **根因**：windows-rs 版本升級時 API signature 會變動，不能假設跟文件範例一致

---

## 效能問題

### [2026-04-03] — 透明視窗穩定性脆弱

- **錯誤**：在 `initializeApp` 中加入過多 async IPC 呼叫後，透明視窗變得完全不可見
- **正確做法**：`sceneManager.start()` 必須在行為系統初始化之前呼叫（確保角色先渲染）。行為系統初始化用 try/catch 包裝，失敗不影響基本渲染
- **受影響檔案**：`src/main.ts`
- **根因**：Tauri WebView2 透明視窗對初始化順序敏感。Vite dependency optimization 也會觸發 page reload

### [2026-04-03] — DragHandler 拖曳閃爍

- **錯誤**：StateMachine 在 drag 狀態下回傳 `input.currentPosition` 作為 targetPosition，與 DragHandler 的 `setWindowPosition` 互相衝突導致角色閃爍
- **正確做法**：StateMachine 在 drag/paused 狀態下回傳 `null` targetPosition，SceneManager 不套用位置更新
- **受影響檔案**：`src/behavior/StateMachine.ts`, `src/core/SceneManager.ts`
- **根因**：兩個系統同時控制視窗位置

### [2026-04-03] — DPI 座標不匹配

- **錯誤**：`outerPosition()` 回傳物理像素，但 `setPosition(LogicalPosition)` 期望邏輯座標
- **正確做法**：使用 `PhysicalPosition` 設定視窗位置
- **受影響檔案**：`src/bridge/TauriIPC.ts`
- **根因**：Tauri 的座標 API 混合使用物理/邏輯座標

---

## 型別問題

### [2026-04-03] — 縮放值累積（compounding）

- **錯誤**：同時調整視窗大小和模型 scale，導致 50% → 75% 實際變成 50% 的 75% = 37.5%
- **正確做法**：只調整 model scale（`vrmController.setModelScale()`），不改視窗大小
- **受影響檔案**：`src/core/SceneManager.ts`
- **根因**：兩種縮放機制疊加

---

## Electron 遷移

### [2026-04-03] — Tauri → Electron 遷移原因

- **錯誤**：在 Tauri/Rust 中使用 EnumWindows、GetWindow 等 Windows API 列舉桌面視窗，多次嘗試皆 crash（access violation 或 exit code 1）
- **正確做法**：改用 Electron + PowerShell 子程序。EnumWindows 在獨立 PowerShell 程序中執行，crash 不影響主程序。koffi FFI 用於 SetWindowRgn
- **受影響檔案**：整個 src-tauri/ → electron/
- **根因**：Rust FFI + Tauri WebView2 + Windows API callback 在特定環境下不穩定。分離程序是最可靠的隔離方式

### [2026-04-03] — Electron IPC 三層同步

- **錯誤**：新增 IPC 方法時只更新部分檔案，導致 runtime error
- **正確做法**：新增 IPC 呼叫必須同時更新三個檔案：(1) electron/ipcHandlers.ts — ipcMain.handle() (2) electron/preload.ts — contextBridge (3) src/bridge/ElectronIPC.ts — 前端包裝
- **受影響檔案**：electron/ipcHandlers.ts, electron/preload.ts, src/bridge/ElectronIPC.ts
- **根因**：Electron 的 context isolation 設計需要三層接口保持同步

---

## 如何新增教訓

當你修正了 Claude Code 的錯誤後，請執行：

```
/log-mistake
```

或手動在對應分類下加入：

```markdown
### [日期] — 一句話描述錯誤

- **錯誤**：Claude Code 做了什麼
- **正確做法**：應該怎麼做
- **受影響檔案**：哪些檔案
- **根因**：為什麼會犯這個錯（幫助 AI 理解「為什麼不能這樣做」）
```
