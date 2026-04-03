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

### [2026-04-03] — 直接使用 IPC API 繞過橋接層

- **錯誤**：直接使用 `window.electronAPI`（或舊版的 `invoke()`）繞過 ElectronIPC
- **正確做法**：所有 IPC 呼叫必須透過 `bridge/ElectronIPC.ts`，統一處理錯誤和 fallback
- **受影響檔案**：所有 `src/` 下的檔案
- **根因**：直接呼叫會繞過統一的錯誤處理策略，IPC 失敗時可能中斷 render loop

---

## Rust 後端（已棄用 — 遷移至 Electron）

### [2026-04-03] — EnumWindows 在 Tauri/Rust 中持續 crash

- **錯誤**：多次嘗試在 Tauri/Rust 中使用 EnumWindows（callback 方式和 GetWindow 遍歷方式）列舉桌面視窗，全部 crash
- **最終解決**：遷移至 Electron，用 koffi FFI 的 GetWindow 遍歷（無 callback）成功運作
- **受影響檔案**：整個 src-tauri/ → electron/
- **根因**：Rust FFI + Tauri WebView2 + Windows API 在特定環境下不穩定

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

### [2026-04-03] — DPI 座標不匹配（Electron + koffi）

- **錯誤**：`GetWindowRect`（koffi FFI）回傳物理像素，但 Electron `getPosition()`/bone screen 座標使用邏輯像素，骨骼接觸偵測座標不匹配
- **正確做法**：視窗座標除以 `window.devicePixelRatio` 轉為邏輯像素後再比較
- **受影響檔案**：`src/core/SceneManager.ts`（骨骼接觸偵測 + Z-order 視覺化）
- **根因**：Windows API 回傳物理像素，Electron 使用 DIP（device-independent pixels）

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

- **錯誤**：在 Tauri/Rust 中使用 EnumWindows、GetWindow 等 Windows API 列舉桌面視窗，多次嘗試皆 crash
- **正確做法**：改用 Electron + koffi FFI。GetWindow 遍歷（無 callback）成功運作。SetWindowRgn 也用 koffi
- **受影響檔案**：整個 src-tauri/ → electron/
- **根因**：Rust FFI + Tauri WebView2 + Windows API 在特定環境下不穩定

### [2026-04-03] — koffi FFI 注意事項

- **錯誤**：koffi 的 `void *` 指標回傳 opaque 物件，無法用 `Number()` 轉換；`struct()` 回傳值不能用 `new` 建構；ESM 模組中 `require` 不存在
- **正確做法**：HWND 用 `intptr_t` 宣告（回傳 plain number）；struct 用 plain object `{ left: 0, ... }`；用 `createRequire(import.meta.url)` 載入 koffi
- **受影響檔案**：`electron/windowMonitor.ts`, `electron/windowRegion.ts`
- **根因**：koffi 的型別系統與 JavaScript 原生型別不完全對應

### [2026-04-03] — 自主移動被視窗碰撞阻擋

- **錯誤**：Electron 遷移後 WindowMonitor 正常運作，但桌寵是 always-on-top 透明視窗，自然與下方視窗重疊。碰撞系統誤判為「撞到視窗」，walk 狀態立即被取消
- **正確做法**：進入 walk 時記錄已重疊的視窗 HWND，只對「新進入」的碰撞反應
- **受影響檔案**：`src/behavior/StateMachine.ts`
- **根因**：always-on-top 視窗必然與下方視窗重疊，不能把重疊當碰撞

### [2026-04-03] — Windows 11 系統 UI 被誤列為桌面視窗

- **錯誤**：IsWindowVisible 對 Windows 11 的「搜尋」「開始」「Windows 輸入體驗」等系統 UI 回傳 true，但它們不是真正的桌面視窗
- **正確做法**：用 `DwmGetWindowAttribute(DWMWA_CLOAKED)` 過濾隱藏的 UWP 系統 UI + WS_EX_TOOLWINDOW/NOACTIVATE 樣式過濾
- **受影響檔案**：`electron/windowMonitor.ts`
- **根因**：Windows 11 的系統 UI 元素技術上 visible 但被 DWM cloaked

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
