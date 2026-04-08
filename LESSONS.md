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
- **正確做法**：原本 SceneManager 只用 `getHipOffsetY` 補償 Y 軸，擴展為 `getHipsRelativeOffset` 補償 X/Y/Z 三軸，sit 狀態下 finalZ -= hipOffset.z，把 hips 強制錨到 currentCharacterZ
- **受影響檔案**：`src/core/VRMController.ts`, `src/core/SceneManager.ts`
- **根因記憶**：動畫的 hip translation 是相對於模型 origin 的 LOCAL 座標，會被 vrm.scene.rotation 轉換為 world 偏移。任何使用 `setWorldPosition + 動畫含 hip translation` 的場景都要做三軸補償，不能只做 Y。若被動畫的 hip 偏移方向打到 camera 近平面就會被切掉

### [2026-04-07] `[跨平台]` — 動畫切換造成 SpringBone 彈跳

- **錯誤**：動畫切換（特別是 idle → sit）時，頭髮 / 衣物等 SpringBone 出現過度擺動
- **根因**：SpringBone 用 verlet integration，hip 的瞬間位移被當成物理外力。即使有 hip 平滑（階段 B 把跳變分散到多幀），每幀仍有 ~12% 的位移觸發物理反應
- **正確做法**：在 hip 跨幀距離 > 30cm 時呼叫 `vrm.springBoneManager?.reset()`，把所有 spring tail 快照到當前 bind pose 並清零 verlet 速度。下一幀從穩定狀態繼續，不會受先前跳變慣性影響
- **受影響檔案**：`src/core/VRMController.ts` (`applyHipSmoothing`)
- **根因記憶**：teleport / 大幅位移後一定要 reset SpringBone，這是 three-vrm 官方建議的做法。reset() 不影響正常物理，只清除「跨幀大位移造成的虛假慣性」

### [2026-04-07] `[跨平台]` — Render loop cache 不可在 loop 外的同步呼叫立刻使用

- **錯誤**：使用者把角色放大到 200% 再縮回 100% 後，sit / 柱子 anchor 仍停留在 200% 大小的位置
- **根因**：`updateCharacterSize()` 從 `cachedModelSize` 讀取，但 cache 只在 render loop 開頭（line 687）每幀更新一次。`setScale()` 從托盤 IPC handler 觸發（render loop 之外），呼叫 `setModelScale(新)` 後立刻 `updateCharacterSize()`，但 cachedModelSize 還是上一幀（舊 scale）的值。鏈式縮放下 anchor 永遠落後一拍
- **正確做法**：`updateCharacterSize()` 改為直接呼叫 `vrmController.getModelWorldSize()`（內部用 `Box3.setFromObject` 反映當前 vrm.scene.scale），不依賴 cache。順手把新值寫回 cachedModelSize 保持一致性
- **受影響檔案**：`src/core/SceneManager.ts:1444-1456`
- **根因記憶**：render loop 內快取的資料只在「下一幀 render loop 開頭」會被刷新。任何從 IPC handler / 事件 / 同步呼叫進入 SceneManager 並讀取這類快取的程式碼都有風險。寫入後若立刻要讀，必須直接呼叫 source-of-truth getter，不能信任 cache

### [2026-04-07] `[跨平台]` — electron 主程序變更需完全重啟（非 HMR）

- **錯誤**：新增 IPC handler 並 commit 後，dev 中的 picker 仍出現 `Error: No handler registered for 'scan_vrma_files'`，因為 vite HMR 重新載入了 renderer 但 electron 主程序仍使用啟動時載入的舊 `dist-electron/ipcHandlers.js`，導致前端呼叫新 IPC 找不到 handler；錯誤被 ElectronIPC wrapper catch 後回傳 `[]`，PreviewScene 走 fallback，使用者看到「T-pose」（FallbackAnimation 振幅僅 0.015 弧度，肉眼幾乎無感）
- **正確做法**：每次修改 `electron/` 下任何檔案後，必須執行「完全重啟」流程：(1) `pnpm build:electron`（編譯到 dist-electron）(2) `Stop-Process electron -Force` 結束所有 electron 進程 (3) `pnpm dev` 重啟。Vite HMR 只覆蓋 renderer，不會觸發 electron 重啟。
- **受影響檔案**：electron/ipcHandlers.ts, electron/preload.ts, electron/main.ts, electron/vrmPickerWindow.ts 等所有 electron/ 下的檔案
- **根因**：Electron 主程序與 preload script 在進程啟動時載入一次，無 HMR 機制；vite dev server 只負責 renderer (chromium) 的程式碼，主程序的 dist-electron 是 tsc 預編譯的

---

## 跨平台

> 標記說明：`[Windows]` = 僅 Windows 適用；`[macOS]` = 僅 macOS 適用；`[跨平台]` = 兩平台都需注意。

（暫無教訓 — 未來累積跨平台開發經驗時記錄於此）

---

## 影片動作轉換器（v0.4）

### [2026-04-08] `[跨平台]` — Electron renderer 不支援 window.prompt() / confirm() / alert()

- **錯誤**：在 video-converter renderer 用 `window.prompt('輸入名稱')` 取得使用者輸入動畫名稱，觸發 `Error: prompt() is not supported.`
- **正確做法**：Electron renderer 預設禁用這三個原生對話框 API。改用 inline HTML input 元素（toolbar 旁邊）、HTML modal 或 IPC 呼叫 main process 的 dialog API
- **受影響檔案**：`src/video-converter/main.ts`、`video-converter.html`
- **根因**：Electron 安全考量，避免阻塞 main thread；nodeIntegration 關閉後這些 BrowserWindow 級別的 dialog 都不可用

### [2026-04-08] `[跨平台]` — MediaPipe detectForVideo 內部 timestamp 嚴格單調，resetTimestamp 無法清除

- **錯誤**：Stage 1 用 `video.currentTime * 1000` 餵 detectForVideo，Stage 2 又從 t=0 開始呼叫，觸發 `INVALID_ARGUMENT: Packet timestamp mismatch on a calculator receiving from stream "input_frames_image"`。MediaPipeRunner.resetTimestamp() 只清本地 lastDetectTimestampMs guard，**無法清除 MediaPipe calculator graph 內部的時間戳狀態**
- **正確做法**：Stage 1 / Stage 2 / 任何時候都用 `performance.now()` 作為 detectForVideo 的 timestamp（全域單調遞增）。CaptureBuffer 仍然存 video time（用於 sampleAt 與 timeline scrub）。MediaPipe 只關心單調性，buffer 關心實際時間，兩個角色分離
- **受影響檔案**：`src/video-converter/main.ts`（detectLoop / runStage2）
- **根因**：MediaPipe 的 InputStreamHandler 預設為嚴格 monotonic，packet 時間戳必須大於前一個。Reset 需要重建 landmarker（5-15 秒）或永遠用單調遞增源

### [2026-04-08] `[跨平台]` — UTF-8 中文檔案禁用 PowerShell `Set-Content` 寫回

- **錯誤**：用 `powershell -Command "(Get-Content x.ts -Raw) -replace ... | Set-Content x.ts"` 對含中文註解的 TS 檔做批次替換，PowerShell 預設用 CP950 (Big5) 寫檔，整個檔的 UTF-8 中文註解全部變亂碼
- **正確做法**：批次字串替換用 Edit tool 的 `replace_all: true` 而非 PowerShell pipe；或在 PowerShell 中明確指定 `-Encoding UTF8`
- **受影響檔案**：當時是 `src/video-converter/solver/BodySolver.ts`，已 git checkout 還原
- **根因**：Windows PowerShell 5.x 預設輸出編碼跟系統 ANSI codepage 走（zh-TW 為 CP950），Get-Content -Raw 讀取雖正確解 UTF-8，但 Set-Content 寫回會用 ANSI

### [2026-04-08] `[跨平台]` — VRM bind pose 反推 REF_DIR 是 solver 校正最關鍵步驟

- **錯誤**：BodySolver 的 A_POSE_REFERENCE_DIR 用「rest pose 垂直向下」假設，但實際 VRM 1.0 normalized bind 是 T-pose / A-pose，findRotation 的基線不對，視覺上姿勢被放大 1.5–2 倍
- **正確做法**：載入 VRM 後動態計算每根骨骼的 child position 作為該骨骼的 REF_DIR（在 bone 自身的 local frame），用 `vrmController.getBoneNode(child).position` 即可。透過 BodySolver.setRefDirs() 注入。對於沒有 child 的 bone（head）不在校正範圍，要嘛跳過、要嘛用 rigid-body 三點基底重做
- **受影響檔案**：`src/video-converter/solver/BodySolver.ts`、`src/video-converter/preview/PreviewCharacterScene.ts`
- **根因**：VRM 1.0 normalized humanoid 每根骨骼的 rest 軸方向是 model-specific，寫死的常數只能涵蓋少數 case。動態校正才是 plan Open Question 2 的正解

### [2026-04-08] `[跨平台]` — VRMController 在 vrm.scene 套 rotation.y = π，hips bone local 需補償

- **錯誤**：BodySolver 算出 hipsWorldQ 後直接呼叫 setBoneRotation('hips', q)，但 vrm.scene 已被 VRMController 套了 180° Y 反轉（讓模型面相機），結果 hips 世界旋轉 = sceneRot × hips_local 多了一層 Y180，模型方向錯亂
- **正確做法**：對 hips bone 特殊處理：`hips_local = quatMul(Y180, hipsWorldQ)`（Y180 自我反向，inverse 仍是 Y180）。其他 bone 不受影響，因為它們是相對父骨骼的 local rotation，與 scene rotation 解耦
- **受影響檔案**：`src/video-converter/preview/PreviewCharacterScene.ts` (applyPose)
- **根因**：scene root 的旋轉會疊加到 root bone 的 world rotation，但其他 bone 已經透過 hierarchy 被覆蓋

### [2026-04-08] `[跨平台]` — MediaPipe poseWorldLandmarks 用 image-down convention，需翻 Y 與 Z

- **錯誤**：BodySolver 直接吃 MediaPipe poseWorldLandmarks 的座標，模型整個倒立（hips 繞 X 軸 180°）
- **正確做法**：在 MediaPipeRunner.detect() 出口處對 poseWorldLandmarks 做 `y = -y, z = -z` 轉換（image down → world up，camera-toward → forward-away）。**不影響 poseLandmarks**（normalized 2D image coords，給 SkeletonOverlay 在 2D canvas 用，必須維持 image down）
- **受影響檔案**：`src/video-converter/tracking/MediaPipeRunner.ts`
- **根因**：MediaPipe Tasks Vision 的 worldLandmarks 沿用 image space convention（X right, Y down, Z toward camera），與標準 3D 右手系（Y up Z forward）相反

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
