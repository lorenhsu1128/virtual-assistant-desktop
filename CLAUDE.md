# virtual-assistant-desktop

## 專案概述

桌面虛擬陪伴軟體（Desktop Mascot），Electron + TypeScript + Three.js。
目標平台：Windows 10 (1903+) / Windows 11。

## 技術棧

- 後端：Node.js (Electron main process) — 視窗感知、檔案系統、系統托盤
- 前端：TypeScript (Vanilla) — Three.js + @pixiv/three-vrm (Electron renderer)
- Windows API：koffi (FFI) — SetWindowRgn 視窗裁切 + GetWindow 視窗列舉
- 視窗列舉：koffi GetWindow 遍歷（無 callback，直接 FFI）
- 設定視窗：Svelte（獨立 BrowserWindow，尚未實作）
- 建置：Vite + pnpm (Corepack) + electron-builder
- 測試：Vitest
- Lint：ESLint + Prettier

## 架構三層原則（絕對遵守）

1. **Node.js 主程序層**（electron/）：只做系統權限操作，不碰 3D 渲染
2. **TypeScript 渲染層**（src/）：只做視覺與互動，不直接呼叫系統 API
3. **IPC 橋接層**（ElectronIPC）：兩層唯一溝通管道

違反此原則的程式碼不得合併。

## 目前開發狀態

| 版本 | 狀態 | 說明 |
|------|------|------|
| v0.1 | ✅ 完成 | 透明視窗 + VRM 模型載入渲染 + .vrma 動畫系統 |
| v0.2 | ✅ 完成 | 自主移動狀態機 + 拖曳 + 軌道攝影機 + 視窗碰撞/吸附/遮擋 |
| v0.3 | ✅ 完成 | 表情系統（自動+手動）+ 系統托盤 + Debug overlay |
| v0.4+ | 未開始 | — |

### 系統托盤選單功能（左鍵點擊）
顯示桌寵 | 動畫 ▸ | 表情 ▸ | 縮放 ▸ | 動畫速率 ▸ | 暫停/恢復自主移動 | 暫停/恢復自動表情 | 暫停/恢復動畫循環 | 重置鏡頭角度 | 重置回桌面正中央 | 更換 VRM 模型 | 更換動畫資料夾 | Debug 模式 | 設定(TODO) | 結束

### Debug overlay 功能
- 骨骼座標面板（3D 世界座標 + 2D 螢幕座標）
- 骨骼末端彩色圓點（頭/手/臀/腳）
- 桌面視窗清單面板（title, x, y, w, h, zOrder）
- 視窗 Z-order 視覺化邊框（紅=最上層，藍=最下層）
- 骨骼與視窗邊緣接觸偵測（綠色虛線，10px 閾值）
- Z-order 遮擋感知（被上層視窗蓋住的邊緣不觸發）
- 工作列偵測（從 workArea 推算位置）
- 腳底不超過 workArea 下緣（groundY 約束）

### Electron 遷移（從 Tauri）
- 遷移原因：Tauri/Rust 的 EnumWindows 持續 crash，無法實現視窗感知功能
- 視窗列舉改用 koffi GetWindow 遍歷（無 callback，直接 FFI）
- 視窗遮擋改用 3D depth-only mesh（取代 SetWindowRgn）
- DwmGetWindowAttribute(DWMWA_CLOAKED) 過濾 Windows 11 系統 UI
- src-tauri/ 保留作參考，不再編譯

## 關鍵目錄結構

```
src/                → TypeScript 前端（renderer process）
  core/             → 渲染核心（SceneManager, VRMController）
  animation/        → 動畫系統（AnimationManager, FallbackAnimation）
  behavior/         → 行為邏輯（StateMachine, CollisionSystem, BehaviorAnimationBridge）
  expression/       → 表情系統（ExpressionManager）
  occlusion/        → 3D 深度遮擋（WindowMeshManager）
  interaction/      → 使用者互動（DragHandler）
  bridge/           → IPC 封裝（ElectronIPC）
  debug/            → Debug overlay（DebugOverlay）
  types/            → 共用型別（config.ts, animation.ts, window.ts, behavior.ts, collision.ts, tray.ts）
electron/           → Electron 主程序（main process）
  main.ts           → 應用程式入口、BrowserWindow 建立
  preload.ts        → contextBridge 暴露 IPC API
  ipcHandlers.ts    → 所有 ipcMain.handle() 註冊
  fileManager.ts    → config.json / animations.json 管理
  windowMonitor.ts  → koffi GetWindow 遍歷視窗列舉
  windowRegion.ts   → [已棄用] koffi FFI 視窗裁切（改用 3D depth occlusion）
  systemTray.ts     → 系統托盤選單
src-tauri/          → [已棄用] 舊 Rust 後端（保留作參考）
src-settings/       → Svelte 設定視窗（尚未實作）
tests/              → Vitest 測試（unit/）
```

## 程式碼規範

- TypeScript 嚴格模式，不允許 `any`（electron/windowRegion.ts 因 koffi FFI 除外）
- 所有公開介面必須有 JSDoc 註解
- 模組間通訊只透過定義好的介面，禁止直接存取內部結構
- VRM 操作只能透過 VRMController
- IPC 呼叫只能透過 bridge/ElectronIPC.ts，禁止直接使用 window.electronAPI

## 命名慣例

| 領域 | 慣例 | 範例 |
|------|------|------|
| TS 類別/介面 | PascalCase | `AnimationManager`, `WindowRect` |
| TS 函式/變數 | camelCase | `playByCategory`, `targetFps` |
| TS 檔案名 | PascalCase.ts (前端) / camelCase.ts (Electron) | `SceneManager.ts` / `fileManager.ts` |
| IPC Channel | snake_case | `scan_animations`, `window_layout_changed` |

## 效能預算

| 指標 | 目標值 |
|------|--------|
| CPU 待機 | < 3% |
| 記憶體 | < 350 MB（含 Chromium） |
| 執行檔體積 | < 150 MB（Electron 打包） |
| 前景 fps | 30 (可調) |
| 失焦 fps | 10 |
| 省電 fps | 15 |

幀率控制使用 `requestAnimationFrame` + deltaTime 跳幀，禁止 `setInterval`。
（WindowMonitor 的 setInterval 是唯一例外，因為它在 main process）

## Git 規範

- 分支命名：`feature/模組名`、`fix/問題描述`、`release/版本號`
- Commit 格式：Conventional Commits
  - `feat(animation): 新增 crossfade 過渡`
  - `fix(collision): 修正多螢幕 DPI 碰撞偏移`
  - `refactor(ipc): 統一錯誤處理策略`
  - `test(state-machine): 補充邊界條件測試`

## 版本規劃

| 版本 | 範圍 |
|------|------|
| v0.1 | 透明視窗 + VRM 模型載入渲染 + .vrma 動畫系統 |
| v0.2 | 視窗互動（碰撞/吸附/遮擋）+ 自主移動狀態機 + 拖曳 |
| v0.3 | 表情系統（自動+手動）+ 系統托盤 + Debug overlay |
| v0.4 | 麥克風唇形同步 + SpringBone 物理運算 |
| v0.5 | 攝影機臉部追蹤 + 進階設定介面 + 自動更新 |

## 重要參考文件

- @SPEC.md — 軟體規格書（功能定義、技術需求）
- @ARCHITECTURE.md — 程式架構建議書（模組設計、依賴關係）
- @LESSONS.md — ⚠️ 已知錯誤與教訓（必讀，避免重複犯錯）

## 開發紀律

- **犯錯後記錄**：修正 AI 錯誤後，執行 `/log-mistake` 記錄到 LESSONS.md
- **定期同步文件**：開發告一段落後，執行 `/doc-sync` 讓文件與程式碼保持一致
- **開發前先讀 LESSONS.md**：每次開始新任務前，先確認是否有相關教訓
