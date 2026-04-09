# virtual-assistant-desktop

## 專案概述

桌面虛擬陪伴軟體（Desktop Mascot），Electron + TypeScript + Three.js。
目標平台：Windows 10 (1903+) / Windows 11 / macOS。

## 技術棧

- 後端：Node.js (Electron main process) — 視窗感知、檔案系統、系統托盤
- 前端：TypeScript (Vanilla) — Three.js + @pixiv/three-vrm (Electron renderer)
- Windows API：koffi (FFI) — GetWindow 視窗列舉（**僅 Windows 啟用**，macOS 上不載入）
- 視窗列舉：koffi GetWindow 遍歷（無 callback，直接 FFI）
- 平台抽象：`electron/platform/` 集中所有 Windows / macOS 差異
- 設定視窗：Svelte（獨立 BrowserWindow，尚未實作）
- 建置：Vite + pnpm (Corepack) + electron-builder
- 打包：`pnpm package:win`（NSIS .exe）/ `pnpm package:mac`（.dmg + .zip）
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
| v0.2 | ✅ 完成 | 自主移動狀態機 + 拖曳 + 軌道攝影機 + 視窗碰撞/吸附/遮擋（Windows-only） |
| v0.3 | ✅ 完成 | 表情系統（自動+手動）+ 系統托盤 + Debug overlay |
| v0.3.x | ✅ 完成 | VRM Picker 預覽對話框 + 動作 / 表情過渡平順化（cubic transition + hip 平滑 + SpringBone 保護） |
| 平台支援 | 🟡 進行中 | Windows 完整 / macOS 渲染+動畫+表情+自主移動，視窗感知功能停用 |
| v0.4+ | 未開始 | — |

### 系統托盤選單功能（左鍵點擊）

顯示桌寵 | 動畫 ▸ | 表情 ▸ | 縮放 ▸ | 動畫速率 ▸ | 暫停/恢復自主移動 | 暫停/恢復自動表情 | 暫停/恢復動畫循環 | 重置鏡頭角度 | 重置回桌面正中央 | 更換 VRM 模型 | 瀏覽 VRM 模型...（自訂預覽對話框） | 更換動畫資料夾 | Debug 模式 | 設定(TODO) | 結束

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
assets/system/vrma/ → 系統內建 .vrma 動畫（SYS_{STATE}_NN.vrma）
                      啟動時掃描，按狀態分池（見 animation-guide.md）
src/                → TypeScript 前端（主視窗 renderer process）
  core/             → 渲染核心（SceneManager, VRMController）
  animation/        → 動畫系統（AnimationManager, FallbackAnimation,
                      systemAnimationMatcher, StepAnalyzer, AnimationMirror）
  behavior/         → 行為邏輯（StateMachine, CollisionSystem, BehaviorAnimationBridge）
  expression/       → 表情系統（ExpressionManager）
  occlusion/        → 3D 深度遮擋（WindowMeshManager）
  interaction/      → 使用者互動（DragHandler）
  bridge/           → IPC 封裝（ElectronIPC）
  debug/            → Debug overlay（DebugOverlay）
  types/            → 共用型別（config, animation, window, behavior, collision, tray, vrmPicker）
  vrm-picker/       → VRM 模型瀏覽對話框（獨立 BrowserWindow renderer）
                      main.ts / PreviewScene.ts / pickerLogic.ts / style.css
  mocap-studio/     → 影片動捕工作站（獨立 BrowserWindow renderer）
                      main.ts / MocapStudioApp.ts / PreviewPanel.ts /
                      VideoPanel.ts / Timeline.ts / TopBar.ts /
                      timelineLogic.ts / style.css
  mocap/            → 影片動捕純邏輯模組（不依賴 DOM / VRM runtime）
                      types.ts（MocapFrame / SmplTrack / VrmHumanBoneName）
                      pipeline.ts（buildMocapFrames 下游組裝）
                      smpl/（SmplSkeleton / smplToVrm / jointLimits / applyClamp）
                      filters/（OneEuroFilter）
                      exporter/（gltfWriter / VrmaExporter）
                      fixtures/（testFixtures dev-only 產生器）
electron/           → Electron 主程序（main process）
  main.ts           → 應用程式入口、BrowserWindow 建立
  preload.ts        → contextBridge 暴露 IPC API（主視窗與 picker 共用）
  ipcHandlers.ts    → 所有 ipcMain.handle() 註冊
  fileManager.ts    → config.json / animations.json 管理
  windowMonitor.ts  → koffi GetWindow 遍歷視窗列舉（Windows-only）
  windowRegion.ts   → [已棄用] koffi FFI 視窗裁切（改用 3D depth occlusion）
  systemTray.ts     → 系統托盤選單
  vrmPickerWindow.ts → VRM 模型瀏覽對話框 BrowserWindow 管理
  mocapStudioWindow.ts → 影片動捕工作站 BrowserWindow 管理
  platform/         → 跨平台抽象層（Windows / macOS 差異集中於此）
    index.ts        → isWindows / isMac 旗標 + 統一匯出
    windowConfig.ts → 各平台 BrowserWindow 參數（含 picker / mocap studio 視窗）
    protocolHelper.ts → local-file 協定路徑解析
src-tauri/          → [已棄用] 舊 Rust 後端（保留作參考）
src-settings/       → Svelte 設定視窗（尚未實作）
index.html          → 主視窗 HTML 入口
vrm-picker.html     → VRM 模型瀏覽對話框 HTML 入口
mocap-studio.html   → 影片動捕工作站 HTML 入口
tests/              → Vitest 測試（unit/）
```

## 程式碼規範

- TypeScript 嚴格模式，不允許 `any`（electron/windowRegion.ts 因 koffi FFI 除外）
- 所有公開介面必須有 JSDoc 註解
- 模組間通訊只透過定義好的介面，禁止直接存取內部結構
- VRM 操作只能透過 VRMController
- IPC 呼叫只能透過 bridge/ElectronIPC.ts，禁止直接使用 window.electronAPI

## 跨平台開發守則

本專案目標平台為 **Windows 10/11 + macOS 11+**。新功能必須兩平台都能運作（或在不支援的平台優雅降級）。

1. **平台分支集中化**：所有 `process.platform === 'win32'` / `'darwin'` 判斷只允許出現在 `electron/platform/`。其他模組透過 `import { isWindows, isMac } from './platform/index.js'` 取用。
2. **系統 API 必須優雅降級**：koffi、AppleScript、原生模組等只在單一平台可用的 API，**不可 throw**。在不支援的平台必須回傳預設值（空陣列、`null`、no-op）並 log warning。
3. **BrowserWindow 參數差異**：透過 `getWindowOptions(bounds)` / `applyPostCreateSetup(win, bounds)` 取得，禁止直接在 main.ts 寫平台分支。
4. **IPC handler 跨平台一致**：對 renderer 而言，IPC API 簽名與回傳型別在兩平台必須一致。平台差異在 handler 內部處理。
5. **新功能 commit 描述須註明測試平台**：說明在哪個平台驗證過、預期在另一平台的行為。
6. **macOS 已知功能限制**：視窗碰撞 / 吸附 / 遮擋 / Peek 等 koffi 依賴功能在 macOS 停用，渲染、動畫、表情、自主移動正常運作。新增功能前先檢查是否屬於 koffi 依賴範圍。

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
- @animation-guide.md — 系統動畫命名與載入規範（新增 .vrma 檔案前必讀）

## 開發紀律

- **犯錯後記錄**：修正 AI 錯誤後，執行 `/log-mistake` 記錄到 LESSONS.md
- **定期同步文件**：開發告一段落後，執行 `/doc-sync` 讓文件與程式碼保持一致
- **開發前先讀 LESSONS.md**：每次開始新任務前，先確認是否有相關教訓
