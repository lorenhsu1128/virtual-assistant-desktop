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

## Rust 後端（已棄用 — 遷移至 Electron） `[Windows-only]`

### [2026-04-03] `[Windows]` — EnumWindows 在 Tauri/Rust 中持續 crash

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

### [2026-04-03] `[Windows]` — DPI 座標不匹配（Electron + koffi）

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

### [2026-04-03] `[Windows]` — Tauri → Electron 遷移原因

- **錯誤**：在 Tauri/Rust 中使用 EnumWindows、GetWindow 等 Windows API 列舉桌面視窗，多次嘗試皆 crash
- **正確做法**：改用 Electron + koffi FFI。GetWindow 遍歷（無 callback）成功運作。SetWindowRgn 也用 koffi
- **受影響檔案**：整個 src-tauri/ → electron/
- **根因**：Rust FFI + Tauri WebView2 + Windows API 在特定環境下不穩定

### [2026-04-03] `[Windows]` — koffi FFI 注意事項

- **錯誤**：koffi 的 `void *` 指標回傳 opaque 物件，無法用 `Number()` 轉換；`struct()` 回傳值不能用 `new` 建構；ESM 模組中 `require` 不存在
- **正確做法**：HWND 用 `intptr_t` 宣告（回傳 plain number）；struct 用 plain object `{ left: 0, ... }`；用 `createRequire(import.meta.url)` 載入 koffi
- **受影響檔案**：`electron/windowMonitor.ts`, `electron/windowRegion.ts`
- **根因**：koffi 的型別系統與 JavaScript 原生型別不完全對應

### [2026-04-03] `[Windows]` — 自主移動被視窗碰撞阻擋

- **錯誤**：Electron 遷移後 WindowMonitor 正常運作，但桌寵是 always-on-top 透明視窗，自然與下方視窗重疊。碰撞系統誤判為「撞到視窗」，walk 狀態立即被取消
- **正確做法**：進入 walk 時記錄已重疊的視窗 HWND，只對「新進入」的碰撞反應
- **受影響檔案**：`src/behavior/StateMachine.ts`
- **根因**：always-on-top 視窗必然與下方視窗重疊，不能把重疊當碰撞

### [2026-04-03] `[Windows]` — Windows 11 系統 UI 被誤列為桌面視窗

- **錯誤**：IsWindowVisible 對 Windows 11 的「搜尋」「開始」「Windows 輸入體驗」等系統 UI 回傳 true，但它們不是真正的桌面視窗
- **正確做法**：用 `DwmGetWindowAttribute(DWMWA_CLOAKED)` 過濾隱藏的 UWP 系統 UI + WS_EX_TOOLWINDOW/NOACTIVATE 樣式過濾
- **受影響檔案**：`electron/windowMonitor.ts`
- **根因**：Windows 11 的系統 UI 元素技術上 visible 但被 DWM cloaked

### [2026-04-03] `[跨平台]` — Electron IPC 三層同步

- **錯誤**：新增 IPC 方法時只更新部分檔案，導致 runtime error
- **正確做法**：新增 IPC 呼叫必須同時更新三個檔案：(1) electron/ipcHandlers.ts — ipcMain.handle() (2) electron/preload.ts — contextBridge (3) src/bridge/ElectronIPC.ts — 前端包裝
- **受影響檔案**：electron/ipcHandlers.ts, electron/preload.ts, src/bridge/ElectronIPC.ts
- **根因**：Electron 的 context isolation 設計需要三層接口保持同步

### [2026-04-07] `[跨平台]` — VRM hip 動畫 Z 位移可能把模型推出 camera near plane

- **錯誤**：使用者拖曳角色到視窗頂部坐下時，sit_01 / sit_02 動畫播放後角色「只剩下半身」或完全消失
- **根因**：解析 .vrma 二進位發現 SYS_SIT_01/02 的 hip translation 軌道含 +1.25m / +1.32m 的 Z 位移（其他 sit_03~07 的 Z ~0）。當使用者拖曳「往上」時 `updateModelFacingDirection` 用 `Math.atan2(dx, dy)` 計算，dy<0 導致 theta=π，加上 vrm 預設 rotation Math.PI 抵消為 0（不旋轉），hip 局部 +Z 直接套到世界 +Z。hips world z = DEFAULT_Z(8.5) + 1.25 = 9.75，靠近 camera near plane (9.9)，身體前方部位（胸/頭/手）被切掉
- **正確做法**：`VRMController.loadVRMAnimation()` 載入後呼叫 `stripHipsPositionZ()`，遍歷 clip.tracks 找到 hips `.position` track，歸零所有 keyframe 的 Z 值。從源頭消除 hip Z 位移，不需 runtime 補償。sit 的 Y 軸對齊由 `applySitHipAnchor()` 在每幀 VRM update 後處理
- **受影響檔案**：`src/core/VRMController.ts`（stripHipsPositionZ）, `src/core/SceneManager.ts`（applySitHipAnchor）
- **根因記憶**：動畫的 hip translation Z 分量會把模型推向 camera near plane。最可靠的解法是在載入時直接歸零 Z，而非 runtime 每幀補償（runtime 補償有反饋迴圈和時序問題）

### [2026-04-07] `[跨平台]` — 動畫切換造成 SpringBone 彈跳

- **錯誤**：動畫切換（特別是 idle → sit）時，頭髮 / 衣物等 SpringBone 出現過度擺動
- **根因**：SpringBone 用 verlet integration，hip 的瞬間位移被當成物理外力。即使有 hip 平滑（階段 B 把跳變分散到多幀），每幀仍有 ~12% 的位移觸發物理反應
- **正確做法**：在 hip 跨幀距離 > 30cm 時呼叫 `vrm.springBoneManager?.reset()`，把所有 spring tail 快照到當前 bind pose 並清零 verlet 速度。下一幀從穩定狀態繼續，不會受先前跳變慣性影響
- **受影響檔案**：`src/core/VRMController.ts` (`applyHipSmoothing`)
- **根因記憶**：teleport / 大幅位移後一定要 reset SpringBone，這是 three-vrm 官方建議的做法。reset() 不影響正常物理，只清除「跨幀大位移造成的虛假慣性」

### [2026-04-07] `[跨平台]` — Render loop cache 不可在 loop 外的同步呼叫立刻使用

- **錯誤**：使用者把角色放大到 200% 再縮回 100% 後，sit / 柱子 anchor 仍停留在 200% 大小的位置
- **根因**：`updateCharacterSize()` 從 `cachedModelSize` 讀取，但 cache 只在 render loop 開頭（line 687）每幀更新一次。`setScale()` 從托盤 IPC handler 觸發（render loop 之外），呼叫 `setModelScale(新)` 後立刻 `updateCharacterSize()`，但 cachedModelSize 還是上一幀（舊 scale）的值。鏈式縮放下 anchor 永遠落後一拍
- **正確做法**：`updateCharacterSize()` 改為直接呼叫 source-of-truth getter，不依賴 cache。（後續重構已移除 cachedModelSize，改用 `getCoreWorldSize()` — humanoid 骨骼核心尺寸）
- **受影響檔案**：`src/core/SceneManager.ts`
- **根因記憶**：render loop 內快取的資料只在「下一幀 render loop 開頭」會被刷新。任何從 IPC handler / 事件 / 同步呼叫進入 SceneManager 並讀取這類快取的程式碼都有風險。寫入後若立刻要讀，必須直接呼叫 source-of-truth getter，不能信任 cache

### [2026-04-07] `[跨平台]` — electron 主程序變更需完全重啟（非 HMR）

- **錯誤**：新增 IPC handler 並 commit 後，dev 中的 picker 仍出現 `Error: No handler registered for 'scan_vrma_files'`，因為 vite HMR 重新載入了 renderer 但 electron 主程序仍使用啟動時載入的舊 `dist-electron/ipcHandlers.js`，導致前端呼叫新 IPC 找不到 handler；錯誤被 ElectronIPC wrapper catch 後回傳 `[]`，PreviewScene 走 fallback，使用者看到「T-pose」（FallbackAnimation 振幅僅 0.015 弧度，肉眼幾乎無感）
- **正確做法**：每次修改 `electron/` 下任何檔案後，必須執行「完全重啟」流程：(1) `bun run build:electron`（編譯到 dist-electron）(2) `Stop-Process electron -Force` 結束所有 electron 進程 (3) `bun run dev` 重啟。Vite HMR 只覆蓋 renderer，不會觸發 electron 重啟。
- **受影響檔案**：electron/ipcHandlers.ts, electron/preload.ts, electron/main.ts, electron/vrmPickerWindow.ts 等所有 electron/ 下的檔案
- **根因**：Electron 主程序與 preload script 在進程啟動時載入一次，無 HMR 機制；vite dev server 只負責 renderer (chromium) 的程式碼，主程序的 dist-electron 是 tsc 預編譯的

---

## 跨平台

> 標記說明：`[Windows]` = 僅 Windows 適用；`[macOS]` = 僅 macOS 適用；`[跨平台]` = 兩平台都需注意。

### [2026-04-09] `[跨平台]` — three.js AnimationAction instance reuse 陷阱導致 A→B→A→B 切換後 T-pose

- **錯誤**：角色 state=hide（debug panel 確認）、AnimationManager.currentDisplayName 顯示 `SYS:hide:SYS_HIDE_01.vrma`、transition 的 `setEffectiveWeight` 持續爬到 ~1，但角色視覺呈 T-pose。診斷 log 顯示 `isRunning=false, time=0.000`，代表 action 不在 mixer active list 中卻被設 weight
- **根因**：`mixer.clipAction(clip)` 對同一個 clip 永遠回傳同一個 AnimationAction instance。AnimationManager.startTransition 清理「上一個 transition 的 lingering oldAction」時只檢查 `lingering !== oldAction`，沒檢查 `lingering !== newAction`。在 A→B→A→B 場景下第二次 B 進入時：
  - 上一個 transition 的 oldAction = B_action（A→B 的 old 是 A，B→A 的 old 是 B）
  - 本次 newAction = B_action（同一 instance）
  - 清理邏輯 `lingering.stop()` 把剛剛 `play()` 過的 newAction 又 stop 掉
  - 之後 updateTransition 每幀 `setEffectiveWeight` 爬升，但 action 已從 mixer 移除，time 不推進 → 骨骼停在 bind pose
- **正確做法**：`startTransition` 的 lingering cleanup 必須同時排除 `lingering === newAction` 的情況。最小修正是在 if 條件加一個 `&& lingering !== newAction`
- **受影響檔案**：`src/animation/AnimationManager.ts` (`startTransition`)
- **根因記憶**：只要模組用 `mixer.clipAction(clip)` 並且會在 A/B 之間頻繁切換，就要假設「previous action」和「new action」可能是同一個 JS instance。任何「stop previous」、「fade out previous」類型的邏輯都要先檢查是否會誤傷 new action。特別是三連（或多連）轉換時，前一個 transition 的 oldAction 可能就是本次的 newAction

### [2026-04-09] `[跨平台]` — 正交相機下 MToon outline screenCoordinates 模式會暴粗

- **錯誤**：某些 VRM 載入到主視窗後出現粗黑邊緣（例如 Wolf_ver1.00），但同一隻模型在 VRM Picker 預覽卻正常。初次誤判為透明 framebuffer 的暗邊 halo，改了 `premultipliedAlpha: true` 無效
- **根因**：主視窗用 `OrthographicCamera`、Picker 用 `PerspectiveCamera`。MToon 的 `outlineWidthMode: screenCoordinates` shader 在計算 clip-space → screen-space 時假設透視投影，正交投影下 projection matrix 的 `[5]` 分量行為不同，outline 寬度計算失真 → 輪廓變粗黑邊
- **正確做法**：在 VRMController 新增 `setMToonOutlineEnabled(enabled)`，對所有 MToon material 的 `outlineWidthFactor` 設 0（用 WeakMap cache 原值以便還原）；預設關閉，透過系統托盤 checkbox 允許切換。偵測 MToon 用 duck-typing 檢查 `outlineWidthFactor` 屬性，避免 import `@pixiv/three-vrm` 的 `MToonMaterial` 型別造成強相依
- **受影響檔案**：`src/core/VRMController.ts`, `src/types/config.ts`, `src/types/tray.ts`, `src/main.ts`, `electron/systemTray.ts`
- **根因記憶**：MToon outline 是「依賴 camera projection 數學」的 shader feature，跟 camera 類型強耦合。新增類似「shader-level 視覺差異」功能前，先檢查是否依賴透視投影。此外，「兩個 scene 同一隻模型不同表現」排除模型作者設計，線索應該優先查 camera / projection / framebuffer 差異

---

### [2026-05-09] `[跨平台]` — 套件管理員從 pnpm 遷移到 bun

- **背景**：原使用 pnpm（透過 Corepack）+ `pnpm.onlyBuiltDependencies` 控制 native module rebuild。改為 bun 1.3+ 作為唯一套件管理員與 script runner
- **必改之處**：
  1. `package.json`：移除 `"pnpm": { "onlyBuiltDependencies": [...] }`，改為頂層 `"trustedDependencies": ["electron", "electron-winstaller", "esbuild", "koffi", "uiohook-napi"]`（bun 用 `trustedDependencies` 控制 postinstall 白名單）
  2. `package.json` scripts：所有 `pnpm build`、`pnpm package*` 等內嵌 script 改為 `bun run build` 等
  3. 刪除 `pnpm-workspace.yaml`、`pnpm-lock.yaml`，產生 `bun.lock`
  4. `.claude/settings*.json`、文件全面更新指令前綴
- **驗證重點**：bun install 後 koffi/uiohook-napi/electron 三個 native 依賴在 dev mode 都能正常載入（`[WindowMonitor] koffi loaded OK` / `[KeyboardMonitor] uiohook-napi started`）
- **不影響**：Vite、Vitest、ESLint、TypeScript、electron-builder 與 IPC 三層架構
- **根因記憶**：bun 不認識 pnpm-only 的 `pnpm.onlyBuiltDependencies` 欄位；遷移時若忘了改 `trustedDependencies`，native module 的 postinstall（如 koffi rebuild）會被靜默跳過，runtime 才出錯

### [2026-05-09] `[Windows]` — electron-builder winCodeSign 解壓 symlink 失敗

- **錯誤**：`bun run package:win` 執行時，electron-builder 下載 `winCodeSign-2.6.0.7z` 後 `7za` 解壓 exit code 2，錯誤訊息 `Cannot create symbolic link`，指向 `darwin/10.12/lib/libcrypto.dylib` / `libssl.dylib`
- **根因**：winCodeSign 壓縮檔內含 macOS 共享函式庫的 symlink，在 Windows 沒開啟「開發人員模式」也沒以管理員權限執行時，`CreateSymbolicLinkW` 會被系統拒絕。雖然 `7za -snld` 旗標會把 symlink 改存為普通檔（電子builder 在 Windows 不需要這些 dylib），但 7za 本身仍以 exit 2 結束，electron-builder 視為失敗，不會把 temp 目錄重新命名為 `winCodeSign-2.6.0`
- **正確做法（任選一）**：
  1. 開啟 Windows 設定 → 「**開發人員模式**」（`ms-settings:developers`），讓非管理員可建立 symlink
  2. 以管理員身分執行 PowerShell 後跑 `bun run package:win`
  3. 手動修復快取：將 `%LOCALAPPDATA%\electron-builder\Cache\winCodeSign\<numericId>` 重新命名為 `winCodeSign-2.6.0`，再清除其他殘留 temp 目錄與 `.7z`
- **與 bun 無關**：此問題與套件管理員無關，pnpm 環境下若快取狀態相同也會發生。只是遷移後快取若被觸發重抓會重現
- **根因記憶**：electron-builder 把 `7za` 任何非零 exit 都當失敗，即使解壓檔案實際可用。Windows 的 symlink 預設權限是真正的瓶頸

## my-agent 整合

### [2026-05-09] `[跨平台]` — bun-compiled standalone binary 不可再透過 bun 執行

- **錯誤**：AgentDaemonManager 第一版用 `spawn(bunBinary, [cli, 'daemon', 'start', ...])` 啟動 my-agent CLI。實測 daemon 立刻 exit code=1，agent 日誌顯示 bun 嘗試把 PE 檔（`MZ` header）當 JS 解析：`error: Expected ";" but found " " at C:\...\cli.exe:1:4`
- **根因**：my-agent 的 `cli` / `cli.exe` 是 `bun build --compile` 產出的 standalone binary，**已內含 bun runtime**。再透過外部 bun 啟動 = bun 試著把可執行檔當原始碼解析
- **正確做法**：判定 CLI 路徑是 `.exe` 或 Unix 無副檔名 + 有執行權限 → 直接 spawn binary。只有 source script（.ts/.js）才需要透過 bun runtime。AgentDaemonManager 加 `isExecutable()` helper 做雙路徑分派
- **受影響檔案**：`electron/agent/AgentDaemonManager.ts`
- **根因記憶**：遇到「`bun build --compile` 產物」時，把它當作普通 binary 處理，不要再包 bun。同樣陷阱適用於 deno compile / node SEA / pkg 產物。判定方法：副檔名 `.exe` / 無副檔名 + 0o111 mode

### [2026-05-09] `[Windows]` — Node.js child.kill('SIGTERM') 在 Windows 是硬殺，daemon 來不及清 pid.json

- **錯誤**：AgentDaemonManager 第一版 stop() 用 `child.kill('SIGTERM')` 通知 my-agent daemon 結束。daemon 進程確實被殺掉，但 `~/.my-agent/daemon.pid.json` 沒被清理（留 orphan 檔案，下次啟動需要 stale heartbeat 偵測才能 recover）
- **根因**：Windows 沒有真正的 SIGTERM。Node.js 的 `child.kill(signal)` 不論傳什麼 signal，實際都呼叫 `TerminateProcess()` — 等同 SIGKILL。Daemon 註冊的 SIGINT/SIGTERM/SIGBREAK handler 完全不會觸發，自然沒機會 cleanup
- **正確做法**：改 spawn `cli daemon stop` 子命令通知 daemon 結束。my-agent 自家 stop 命令會 (1) 讀 pid.json 找 pid (2) TerminateProcess (3) **代為 cleanup pid.json**（標準輸出顯示 `force-killed daemon pid=N; cleaning orphan pid.json`）。本地 SIGKILL 留作 fallback timeout 之後才用
- **受影響檔案**：`electron/agent/AgentDaemonManager.ts` (`stop()` / `tryGracefulStop()`)
- **根因記憶**：在 Windows 上對外部進程做「graceful shutdown」不能依靠 Node.js child.kill — 必須走目標程式自己的 stop CLI 或 IPC 訊息。同樣思維適用其他原生 daemon（postgres、nginx、my-agent）— 找它們的 admin CLI

### [2026-05-09] `[跨平台]` — Electron mainWindow.on('closed') + before-quit 雙重 stop 競態

- **錯誤**：第一次 graceful shutdown 測試發現 `cli daemon stop` 訊息「sent」但 daemon 早就死了、pid.json 也沒清。日誌顯示 daemon exited 與 stop sent 只差幾百 ms — 兩個 stop() 在賽跑
- **根因**：使用者按 X 關視窗時：(1) `mainWindow.on('closed')` 觸發 `void agentDaemon?.stop()` 不等待 (2) 接著 `app.on('before-quit')` 觸發第二次 `await agentDaemon.stop()`。兩個 stop 各自 spawn `cli daemon stop` 子進程、各自有自己的 graceful timeout。先到的會把 daemon 殺掉，後到的找不到 daemon 自然 fail
- **正確做法**：在 `mainWindow.on('closed')` **不要**呼叫 daemon stop。只由 `app.on('before-quit')` 集中處理（preventDefault → await stop → app.quit() → 二次觸發 before-quit 時 agentDaemon 已 null skip）
- **受影響檔案**：`electron/main.ts`
- **根因記憶**：Electron 的 quit 流程有多個 cleanup hook（window-all-closed → before-quit → will-quit → quit）。每個資源只能由「一個」hook 負責清理，否則就是賽跑。判定原則：需要 await 的清理必走 before-quit + preventDefault；fire-and-forget 才能放 mainWindow.on('closed')

### [2026-05-09] `[跨平台]` — my-agent daemon 的 ws 是 NDJSON，frame 必須結尾換行

- **錯誤**：AgentSessionClient 第一版 `send()` 用 `ws.send(JSON.stringify(frame))` — 沒結尾 `\n`。手動 ws probe 看到 daemon 收到連線、回 hello，但送 input 後完全沒反應，60s timeout 才斷
- **根因**：my-agent 的 `directConnectServer.ts:195-235` 用 newline 切 frame：「accumulate 緩衝區直到看到 `\n` 才 JSON.parse」。沒換行就一直 buffer，daemon 沒拿到完整 frame 自然不處理
- **正確做法**：所有送出 frame 必須 `JSON.stringify(frame) + '\n'`。Probe 加上換行立刻收到 turnStart / runnerEvent stream
- **受影響檔案**：`electron/agent/AgentSessionClient.ts` (`send()`)
- **根因記憶**：與 NDJSON / line-delimited JSON 協定（jsonl、ndjson、JSON-RPC over stdio 等）通訊一定要附加終結符。WebSocket 雖然有 message frame 邊界但對端可能仍把 payload 當 stream 處理（my-agent 就是）。寫測試時也要驗 `endsWith('\n')` 防止迴歸

### [2026-05-09] `[跨平台]` — MCP HTTP server 必須走 per-request stateless，不可共用 transport

- **錯誤**：MascotMcpServer 第一版用單一 `McpServer` + 單一 `StreamableHTTPServerTransport`（stateful，sessionIdGenerator: randomUUID）服務所有 HTTP request。第一個 client（例如 cli mcp list 健康檢查）做完 `initialize` 後，第二個 client（例如 daemon MCP loader）連進來會收到 `Invalid Request: Server already initialized`，整個 mascot tool 對 LLM 不可用
- **同樣錯誤的另一面**：改 stateless（sessionIdGenerator: undefined）共用一個 transport 的話，`initialize` 之後的 `tools/list` 等 follow-up request 全 500（SDK 1.29 內部 state 不對）
- **正確做法**：per-request 模式 — 每個 HTTP request 起一份新的 `McpServer + StreamableHTTPServerTransport({sessionIdGenerator: undefined})`，response close 時 `transport.close() + mcp.close()`。tool 註冊放進 `buildServer()` helper 確保每份 server 都有同樣 tools。stateless 但 session 隔離
- **受影響檔案**：`electron/agent/MascotMcpServer.ts` (`start()` / `handleHttpRequest()` / `buildServer()`)
- **根因記憶**：MCP HTTP transport 的兩個模式（stateful vs stateless）都假設「ONE persistent client」。多 client 場景必須 per-request 隔離。Express 範例（`app.post('/mcp', (req, res) => {...})`）如果直接用就是 per-request 風格 — 那種 pattern 才對

### [2026-05-09] `[跨平台]` — `cli mcp add` 預設 scope=local 對 dotfile 路徑 normalize 失敗

- **錯誤**：第一版 `mcpRegistration.ts` 用 `cli mcp add --transport http mascot <url>`（沒帶 --scope），預設 scope=local。我們的 cwd 是 `~/.virtual-assistant-desktop/agent-workspace`（含 dotfile 父層），結果 mascot 被寫到 `projects["C:/Users/LOREN"]`（home dir）的 mcpServers，不是 workspace。daemon 的 ProjectRuntime 載入時找不到設定，tools 列表是空
- **根因**：my-agent 的 local scope 用 cwd 找 project key，遇到 dotfile 父層（如 `.virtual-assistant-desktop`）會往上 walk，把 user home 當成 project root
- **正確做法**：用 `--scope user` 寫到全域 `~/.my-agent/.my-agent.jsonc` 的全域 mcpServers，跨 project 都看得到。桌寵 MCP server 是本機 loopback、自家進程，視為信任來源，user scope 合理
- **受影響檔案**：`electron/agent/mcpRegistration.ts`
- **根因記憶**：使用其他工具的「scope/profile/preset」時，要明確指定 scope 不要靠預設。預設值常常與 cwd 解析行為耦合，dotfile 路徑或非標準 project layout 會踩到。idempotent 模式：先 `remove --scope X` 再 `add --scope X`

### [2026-05-09] `[跨平台]` — Electron renderer console.log 不會自動 pipe 到 dev shell

- **錯誤**：P2 端到端 debug 時，加在 MascotActionDispatcher 的 `console.log` 在 dev shell 看不見。誤以為 dispatcher 沒收到 IPC，實際是 log 只去 Chromium DevTools console
- **正確做法**：dev mode 下用 `webContents.on('console-message', (event) => { ... })` 把指定 prefix 的訊息 forward 到 main process stdout。建議只 forward 自家 prefix（如 `[MascotAction]`）避免被 third-party noise 淹沒
- **受影響檔案**：`electron/main.ts` (createMainWindow)
- **根因記憶**：Electron renderer process 的 console output 與 main process stdout 是兩個獨立 stream。dev shell 跑 `bun run dev` 看到的是 main process stdout（含 `[1] [WindowMonitor]` 等），renderer 的 log 要嘛開 DevTools 看，要嘛主動 forward。寫整合測試或 debug script 時要意識到這層分界

### [2026-05-09] `[跨平台]` — settings 視窗複用 src-bubble React 環境，不要 Svelte

- **背景**：原 ARCHITECTURE.md 規劃 `src-settings/` 用 Svelte。P3 實際做時發現 src-bubble 已經跑 React + Tailwind + shadcn 一整套基礎設施
- **正確做法**：直接複用 React stack — 新增 src-settings/ 但 import 同樣依賴（react / tailwindcss / @radix-ui/* / class-variance-authority）。Vite config 把 `react()` plugin include scope 從 `src-bubble/**` 擴成同時包含 `src-settings/**`；tsconfig include / tailwind.config content 同步加 `src-settings/`。新增 entry：`settings.html` + `vite.config.ts rollupOptions.input.settings`。最後做的事是 4 個 shadcn primitives（switch / label / input / button）+ AgentPage.tsx
- **受影響檔案**：`vite.config.ts`、`tsconfig.json`、`tailwind.config.ts`、`settings.html`、整個 `src-settings/`
- **沒有踩到的雷**：分屬不同 React app（src-bubble 主要是訊息流 + zustand store；src-settings 是表單）但能共用基礎設施。每個 BrowserWindow 各自跑 React StrictMode 不互相干擾
- **根因記憶**：規劃文件寫的 stack（如 Svelte）若先有更熟悉的 React 環境（如為了其他 BrowserWindow 引入），就直接複用 React。多個 entry point 共用同一份 React 編譯設定 + 共用 shadcn 元件，比維護兩套 framework 簡單很多。新增獨立 BrowserWindow 的 React app 模板：`<新名>.html` + `src-<名>/main.tsx` + `electron/<名>Window.ts` + tray action / ipc handler

### [2026-05-09] `[跨平台]` — daemon orphan 進程 + .daemon.lock 卡死重啟

- **錯誤**：dev 重啟測試時發現桌寵 spawn 新 daemon 失敗：`Daemon session lock held by live pid=N at .daemon.lock`。實際 pid N 是上次 dev session 的 daemon，沒被 `kill-dev.ps1` 殺到（只殺 electron / vite / node，沒殺 cli）
- **根因**：my-agent daemon 是 standalone bun-compiled binary（process name = `cli.exe`），跟 vite/electron 名字不同。我們的 kill 腳本沒涵蓋。即使 daemon process 被殺掉，`.daemon.lock` 不會自動清理，下次啟動會被卡住
- **正確做法**：
  1. `kill-dev.ps1` 加入 `Get-Process cli | Where-Object Path like '*my-agent*' | Stop-Process`
  2. 完整重啟流程：kill cli → 刪 `~/.my-agent/daemon.pid.json` → 刪 `~/.my-agent/projects/<projectKey>/.daemon.lock` → 清 mcp.json 殘留 entry → 然後才 `bun run dev`
- **受影響檔案**：`C:\Users\LOREN\AppData\Local\Temp\kill-dev.ps1`（dev 工具腳本，不在 repo）
- **根因記憶**：spawn 第三方 daemon 的整合，重啟流程必須涵蓋對方的所有「鎖」與 stale state（pid 檔、lock 檔、socket 檔）。建議在 AgentDaemonManager 啟動時主動清理已知的 stale lock — 已驗證安全前可以就先在 dev 工具腳本層級處理

### [2026-05-09] `[跨平台]` — 別用 vanilla TS 重寫 my-agent 已有的 chat UI

- **錯誤**：P1 用 vanilla TS + 自寫 CSS 做對話氣泡，只解析 Anthropic 標準 `content_block_delta` text。實測發現 my-agent daemon 的 `runnerEvent` 包了一層 `output` wrapper，且 SDK message 的 content 陣列含 `text` / `thinking` / `tool_use` / `tool_result` 多種 block — 我的 parser 全部不認得，氣泡顯示 `(no content, reason=done)` 或原始 `<tool_call>` XML
- **根因**：my-agent 已經有完整的 `web/src/components/chat/`（React + Tailwind + zustand + shadcn/ui），含 MessageItem / ToolCallCard / ThinkingBlock 與 SDK message → UI block 的解析邏輯（`useTurnEvents.ts`）。重寫一份等於放棄現成的測試與長期會跟 my-agent upstream drift
- **正確做法**：直接移植 my-agent web 的 chat 元件 + parser 到 src-bubble。daemon 線上協定（直連 `/sessions` 的 `runnerEvent`）與 web 內部協定（`turn.event` 包同樣的 RunnerEvent）的 SDK payload 完全相同，只需要寫一個薄 adapter（`daemonFrameAdapter.ts`）把 daemon frame mapping 到同樣的 messageStore actions。React + Tailwind + zustand + radix collapsible + lucide-react 這些依賴都加進來，PostCSS / Vite plugin-react 設定齊全
- **受影響檔案**：整個 `src-bubble/`（vanilla TS 全刪重寫）、`tailwind.config.ts`、`postcss.config.js`、`vite.config.ts`（加 react plugin）、`tsconfig.json`（加 jsx）
- **依賴版本提醒**：`@vitejs/plugin-react@5+` 需要 vite 7；專案 vite 6 必須裝 `^4`
- **根因記憶**：要與其他工具達到「協定一致 + UI 一致」時，永遠先看上游有沒有現成元件可以 fork。my-agent 上下游關係夠近、type 與訊息格式一致，移植成本遠低於重寫成本。預估前先跑 Explore agent 盤點 components / hooks / store / shadcn primitives，逐項列出「複製 / 改編 / 丟棄」清單再動工

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
