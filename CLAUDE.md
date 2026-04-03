# virtual-assistant-desktop

## 專案概述

桌面虛擬陪伴軟體（Desktop Mascot），Tauri 2.x + TypeScript + Three.js。
目標平台：Windows 10 (1903+) / Windows 11。

## 技術棧

- 後端：Rust (Tauri 2.x) — 視窗感知、檔案系統、系統托盤
- 前端：TypeScript (Vanilla) — Three.js + @pixiv/three-vrm
- 設定視窗：Svelte（獨立 WebView）
- 建置：Vite + pnpm (Corepack)
- 測試：Vitest
- Lint：ESLint + Prettier

## 架構三層原則（絕對遵守）

1. **Rust 層**：只做系統權限操作，不碰 3D 渲染
2. **TypeScript 層**：只做視覺與互動，不直接呼叫系統 API
3. **IPC 橋接層**（TauriIPC）：兩層唯一溝通管道

違反此原則的程式碼不得合併。

## 關鍵目錄結構

```
src/                → TypeScript 前端（主視窗）
  core/             → 渲染核心（SceneManager, VRMController）
  animation/        → 動畫系統（AnimationManager, FallbackAnimation）
  expression/       → 表情系統（ExpressionManager）
  behavior/         → 行為邏輯（StateMachine, CollisionSystem, BehaviorAnimationBridge）
  interaction/      → 使用者互動（DragHandler, ContextMenu）
  bridge/           → IPC 封裝（TauriIPC）
  types/            → 共用型別（config.ts, animation.ts, window.ts, behavior.ts, collision.ts）
src-tauri/src/      → Rust 後端
  commands/         → Tauri command handlers（file_commands, window_commands）
  types.rs          → 共用 Rust 型別（WindowRect, Rect, DisplayInfo）
  window_monitor.rs → 視窗輪詢（獨立執行緒 4Hz EnumWindows）
  file_manager.rs   → 檔案讀寫
  system_tray.rs    → 系統托盤
  single_instance.rs→ 單實例鎖定
src-settings/       → Svelte 設定視窗
tests/              → Vitest 測試（unit/ + integration/）
```

## 程式碼規範

- TypeScript 嚴格模式，不允許 `any`
- Rust 使用 `clippy` 最嚴格等級，不允許 `unwrap()`
- 所有公開介面必須有 JSDoc / rustdoc 註解
- 模組間通訊只透過定義好的介面，禁止直接存取內部結構
- VRM 操作只能透過 VRMController
- IPC 呼叫只能透過 bridge/TauriIPC.ts，禁止直接呼叫 `invoke()` 或 `listen()`

## 命名慣例

| 領域 | 慣例 | 範例 |
|------|------|------|
| TS 類別/介面 | PascalCase | `AnimationManager`, `WindowRect` |
| TS 函式/變數 | camelCase | `playByCategory`, `targetFps` |
| TS 檔案名 | PascalCase.ts | `SceneManager.ts` |
| Rust 函式/變數 | snake_case | `get_window_list` |
| Rust 結構體/列舉 | PascalCase | `WindowRect`, `AnimationCategory` |
| Rust 檔案名 | snake_case.rs | `window_monitor.rs` |
| IPC Command | snake_case | `scan_animations` |
| IPC Event | snake_case | `window_layout_changed` |

## 效能預算

| 指標 | 目標值 |
|------|--------|
| CPU 待機 | < 2% |
| 記憶體 | < 200 MB |
| 執行檔體積 | < 30 MB |
| 前景 fps | 30 (可調) |
| 失焦 fps | 10 |
| 省電 fps | 15 |

幀率控制使用 `requestAnimationFrame` + deltaTime 跳幀，禁止 `setInterval`。

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
| v0.3 | 表情系統（自動+手動）+ 系統托盤 |
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
