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

### [2026-04-09] `[跨平台]` — VRMA 匯出對 VRM 0.x 模型需要 x/z 座標系反補償

- **錯誤**：Phase 3 VrmaExporter 匯出的 `.vrma` 載入 VRM 0.x 模型後播放，手肘反向彎曲（朝上彎，人體做不到）；同一份 MocapFrame[] 在 mocap studio 預覽卻是正確方向（朝下彎）
- **根因**：`@pixiv/three-vrm-animation` 的 `createVRMAnimationHumanoidTracks` 第 1694 行有這段：
  ```js
  origTrack.values.map((v, i) => metaVersion === "0" && i % 2 === 0 ? -v : v)
  ```
  **載入 .vrma 到 VRM 0.x 時**，loader 會自動對每個 quaternion 的 **x 和 z 分量取負**（等價於繞 Y 軸 180° 反轉），補償 VRM 0.x vs 1.0 的座標系差異。VRMA 規範期待檔案內容是「VRM 1.0 canonical frame」。mocap studio 預覽直接 `setBoneRotations` 把 quat 套到 VRM 0.x 的 normalized bone 看起來正確（因為 quat 和 bone 都在 0.x frame）；但這份 quat 不是 VRMA canonical frame，匯出後 loader 又 flip 一次 → 雙重補償 → 反向
- **正確做法**：VrmaExporter 新增 `sourceMetaVersion` 選項；當 source 為 `'0'` 時，寫入每個 quat 時預先對 x/z 取負，讓 loader 的 flip 剛好抵消。MocapStudioApp 透過 `PreviewPanel.getVrmMetaVersion()` 取得當前 VRM 版本傳給 exporter
- **受影響檔案**：`src/mocap/exporter/VrmaExporter.ts`、`src/mocap-studio/PreviewPanel.ts`、`src/mocap-studio/MocapStudioApp.ts`、`tests/unit/VrmaExporter.test.ts`
- **根因記憶**：VRMA 是 **model-agnostic** 格式，檔案內容必須在「canonical frame」（VRM 1.0 axis convention）。寫入端若用來源模型的「normalized bone 原生 frame」直接輸出，對 1.0 模型巧合正確，對 0.x 模型會被 loader 二次補償而反向。任何「VRMA 匯出器」都要考慮 source 和 target 的 metaVersion 組合；最安全的做法是**永遠輸出 1.0 canonical**，由 loader 處理目標相容性

### [2026-04-09] `[跨平台]` — VRMA 匯出「全零 hips translation」會讓主視窗角色消失

- **錯誤**：Phase 3 VrmaExporter 對左手舉起 fixture 產生的 `.vrma` 匯出後，主視窗切換播放該動畫時角色瞬間消失、Debug panel `pos(NaN, NaN)`
- **根因**：`generateLeftArmRaiseFixture` 填 `SmplTrack.trans = [[0,0,0], ...]` 作為「無 hip 運動」的佔位符；pipeline `buildMocapFrames` 把 `[0,0,0]` 原樣轉成 `hipsWorldPosition = {x:0,y:0,z:0}`（非 null）；VrmaExporter 的 `hasHipsTranslation` 判定只看 `!== null`，於是發出一條全零的 hips translation channel。主視窗載入播放時，mixer 把 `vrm.humanoid.hips.node.position` 強制設成 `(0,0,0)`，覆寫了 VRM rest pose 的 hips 位置，導致 `VRMController.applyHipSmoothing` 偵測到 hip 世界座標大幅跳變並觸發 NaN 邊界條件 → 角色 screen position 變 NaN → 從畫面消失
- **正確做法**：VrmaExporter 的 `hasHipsTranslation` 檢查必須**同時**要求至少有一個分量 `|v| > 1e-6`。全零等同於「無運動」，應跳過 translation channel
- **受影響檔案**：`src/mocap/exporter/VrmaExporter.ts`、`tests/unit/VrmaExporter.test.ts`
- **根因記憶**：動捕 pipeline 中「缺資料」與「值為零」是不同語意但容易混淆：`null` / `undefined` / `[0,0,0]` / `{x:0,y:0,z:0}` 都可能被下游當成「有效的零值」並寫入檔案。匯出層必須用**語意等價於 identity 的檢查**（quat 近 identity、translation 近 zero、weight 近 0）來決定該 channel 是否值得保留，而不是只看「是否 defined」

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

### [2026-04-09] `[跨平台]` — ⚠️ ERRATA：HybrIK-TS 座標慣例修正是基於推理而非實測，**被證偽**

> 此條目標記為 **ERRATA**。原本記錄「MP world z 與 image z 方向相反」的結論是**基於推理**（第一次觀察後仰，第二次觀察 arms-up），但兩次 transform 嘗試 `(x,-y,-z)` → `(x,-y,z)` 都沒有真正解決問題。更正確的做法是**用實測數據驗證**，不是用文件 + 推理。

- **原始錯誤歷程**：
  1. Phase 5b 首版：`(lm.x, -lm.y, -lm.z)` — 依 image-z 慣例推理，實測顯示人物前傾被解成後仰 + arms-up
  2. Phase 5d 第一次修正：改為 `(lm.x, -lm.y, lm.z)` — 反推後解 z 方向，實測仍錯
  3. 發現單純翻 z 解決不了：**可能 x 軸方向、rest pose、或更深層問題**
- **正確做法**：**診斷優先、修正在後**。不要繼續用肉眼 + 推理猜 MediaPipe GHUM world 座標慣例：
  1. 在 HybrikTsEngine 加第一幀 console.log，dump raw MP 世界座標（head / shoulder / hip / wrist / ankle 的 x y z）
  2. 用已知姿勢影片（站立面對鏡頭）跑一次，肉眼觀察 `head y` vs `foot y` 判斷 y 軸方向；`hand z` vs `hip z` 判斷 z 軸方向
  3. 根據**實測值**寫 transform，不要根據文件或推理
- **受影響檔案**：`src/mocap/engines/HybrikTsEngine.ts`（`logFirstFrameDiagnostics`）、`src/mocap/hybrik/LandmarkToSmplJoint.ts`、`tests/unit/hybrikSolver.test.ts`
- **根因記憶**：**任何第三方座標慣例，在沒有實測數據前不要猜**。MediaPipe Pose Landmarker GHUM 輸出的 world 座標慣例，官方文件沒寫清楚，社群討論也不一致。用 console.log 實測值再寫 transform。犯過兩次相反方向的錯誤才學到這個教訓 — 若早知道「先加診斷」能省兩次 iteration。

  另外：除了座標慣例，還要檢查「VRM bind pose 是否透過 `getNormalizedBoneNode` 存取」（已確認）；「SMPL primary target 映射是否正確」；「rest pose T-pose 與 VRM 1.0 canonical 是否一致」（已確認）。多層可能的 bug，只從症狀很難定位，需要**逐層打 log**。

### [2026-04-09] `[跨平台]` — HybrIK-TS swing-only IK 無法決定 bone twist

- **錯誤**：Phase 5b 移植 HybrIK 論文的 analytical IK 時，對每個 joint 用 `swingFromTo(restDir, targetDir)` 單軸 swing 求解，對位置足夠但手掌朝向 / 前臂扭轉會與真實動作有差異（單軸 swing 無法決定繞 bone 軸的旋轉分量）
- **根因**：完整 HybrIK 需要神經網路預測每段骨骼的 twist 角度；純 TS port 沒有神經網路，退化為 zero-twist — 對「位置」足夠，對「朝向細節」不足
- **正確做法**：
  1. 對「多子節點」joint（pelvis, spine3）用 `rotationFromTwoAxes(restA, restB, targetA, targetB)`，從兩組方向對擬合完整 3x3 rotation。pelvis 用 (spine1, leftHip)，spine3 用 (neck, leftCollar) — 這樣軀幹面向正確
  2. 對「單子節點」joint 維持 swing-only，文件明記 zero-twist 限制
  3. 單元測試用 FK 位置 round-trip 比對（θ → FK → IK → FK → 位置），**不比對 axis-angle**，因為 zero-twist 下多組 θ 可產生相同位置
- **受影響檔案**：`src/mocap/hybrik/SolverCore.ts`、`src/mocap/hybrik/TwistSwing.ts`、`src/mocap/hybrik/SmplRestPose.ts`、`tests/unit/hybrikSolver.test.ts`
- **根因記憶**：任何 IK 演算法，input 若只是「目標位置」而非「目標位置 + 目標朝向」，就有 twist 不定性。要嘛加第二個約束（two-axis fit），要嘛接受細節失真並文件化

### [2026-04-09] `[跨平台]` — MediaPipe VIDEO 模式批次處理用 media 絕對時間戳，scrub 模式用 wall clock

- **錯誤**：Phase 5a「持續偵測」用 `Math.round(performance.now())` 當 MediaPipe 時間戳（scrub 回跳會讓 video.currentTime 倒退，MediaPipe VIDEO mode 拒絕非單調時間戳）。Phase 5d HybrikTsEngine 批次 seek+detect 若沿用同樣策略，會有問題：(1) 批次速度快，`performance.now()` 幀間距可能 < 1ms，MediaPipe 內部濾波假設失效；(2) 與影片 media 時間脫鉤，邏輯上不對應真實內容時間
- **正確做法**：批次處理改用 `Math.round(timeSec * 1000)`（media 絕對時間）。按 `index * (1000/sampleFps)` 逐幀前進 → 時間戳天然單調遞增且與影片同步。持續偵測模式（scrub 觸發）保留 `performance.now()` 策略因為它需要容忍使用者任意跳轉
- **受影響檔案**：`src/mocap/engines/HybrikTsEngine.ts`、`src/mocap-studio/MocapStudioApp.ts`（持續偵測路徑不變）
- **根因記憶**：MediaPipe VIDEO 需單調遞增時間戳，「單調」有兩種實作：(a) wall clock 保單調但與 media 脫鉤；(b) media 絕對時間，只在「批次順序遍歷」時天然單調。選擇取決於使用情境是「隨機 scrub」還是「線性遍歷」

### [2026-04-09] `[跨平台]` — vitest fake timer 下必須先建立 rejection assertion 再推進時間

- **錯誤**：Phase 5d videoFrameSeeker.test.ts 寫 timeout 測試時，先 `await vi.advanceTimersByTimeAsync(...)` 再 `await expect(p).rejects.toThrow()`。vitest 執行通過（343/343）但終端出現 unhandled rejection warning — fake timer 推進時 promise rejection 已發生，但 `.rejects` chain 還沒訂閱該 promise
- **正確做法**：先 `const assertion = expect(p).rejects.toThrow()`（立即訂閱 rejection），再 `await vi.advanceTimersByTimeAsync(...)`，最後 `await assertion`
- **受影響檔案**：`tests/unit/videoFrameSeeker.test.ts`
- **根因記憶**：任何「fake timer 下測試 promise rejection」場景，rejection handler 必須在 rejection 實際發生**之前**訂閱，否則 Node 會標記為 unhandled。`expect(p).rejects.X` 會延遲訂閱到 `.rejects` 被 evaluate 時，所以要提前建立 chain

### [2026-04-09] `[跨平台]` — 正交相機下 MToon outline screenCoordinates 模式會暴粗

- **錯誤**：某些 VRM 載入到主視窗後出現粗黑邊緣（例如 Wolf_ver1.00），但同一隻模型在 VRM Picker 預覽卻正常。初次誤判為透明 framebuffer 的暗邊 halo，改了 `premultipliedAlpha: true` 無效
- **根因**：主視窗用 `OrthographicCamera`、Picker 用 `PerspectiveCamera`。MToon 的 `outlineWidthMode: screenCoordinates` shader 在計算 clip-space → screen-space 時假設透視投影，正交投影下 projection matrix 的 `[5]` 分量行為不同，outline 寬度計算失真 → 輪廓變粗黑邊
- **正確做法**：在 VRMController 新增 `setMToonOutlineEnabled(enabled)`，對所有 MToon material 的 `outlineWidthFactor` 設 0（用 WeakMap cache 原值以便還原）；預設關閉，透過系統托盤 checkbox 允許切換。偵測 MToon 用 duck-typing 檢查 `outlineWidthFactor` 屬性，避免 import `@pixiv/three-vrm` 的 `MToonMaterial` 型別造成強相依
- **受影響檔案**：`src/core/VRMController.ts`, `src/types/config.ts`, `src/types/tray.ts`, `src/main.ts`, `electron/systemTray.ts`
- **根因記憶**：MToon outline 是「依賴 camera projection 數學」的 shader feature，跟 camera 類型強耦合。新增類似「shader-level 視覺差異」功能前，先檢查是否依賴透視投影。此外，「兩個 scene 同一隻模型不同表現」排除模型作者設計，線索應該優先查 camera / projection / framebuffer 差異

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
