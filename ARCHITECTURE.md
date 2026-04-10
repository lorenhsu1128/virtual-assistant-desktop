# virtual-assistant-desktop — 程式架構建議書

> **對應規格書版本：** v0.1 Draft  
> **目標平台：** Windows 10/11 + macOS 11+  
> **更新日期：** 2026-04-07

---

## 1. 整體分層架構

系統分為三層，各層職責明確、邊界清晰：

```
┌─────────────────────────────────────────────┐
│           TypeScript 渲染層 (renderer)        │
│  Three.js 渲染、VRM 控制、動畫狀態機、        │
│  表情系統、碰撞判定、自主移動、UI             │
├─────────────────────────────────────────────┤
│           IPC 橋接層 (ElectronIPC)            │
│  Commands（renderer→main）/ Events（main→renderer）│
├─────────────────────────────────────────────┤
│           Electron 主程序層 (main)            │
│  視窗感知、檔案系統、系統托盤、               │
│  單實例鎖定、麥克風擷取                       │
│  ┌─────────────────────────────────────┐     │
│  │  平台抽象層 electron/platform/        │     │
│  │  Windows / macOS 行為差異集中於此     │     │
│  └─────────────────────────────────────┘     │
└─────────────────────────────────────────────┘
```

**設計原則：**

- Electron 主程序層負責所有需要系統權限的操作，不碰任何 3D 渲染邏輯。
- TypeScript 渲染層負責所有視覺與互動邏輯，不直接呼叫系統 API。
- IPC 橋接層是兩邊的唯一溝通管道。
- **跨平台分支集中於 `electron/platform/`**：主程式碼禁止散落 `process.platform` 判斷。

---

## 2. TypeScript 前端模組

### 2.1 模組總覽

```
src/
├── core/            # 渲染核心
├── animation/       # 動畫系統
├── expression/      # 表情系統
├── behavior/        # 行為與碰撞
├── interaction/     # 使用者互動
├── bridge/          # IPC 封裝
└── types/           # 共用型別
```

### 2.2 各模組職責

#### core/SceneManager.ts

Three.js 場景的生命週期管理，是整個前端的心臟。

**職責：**

- 建立並管理 Scene、Camera、WebGLRenderer（透明背景）。
- 擁有 `requestAnimationFrame` 主迴圈（render loop）。
- 幀率控制：依據前景/失焦/省電模式動態調整目標 fps。
- WebGL context lost 監聽與自動復原（重建 renderer、重新載入場景）。
- 角色縮放控制（50%–200%）。

**主迴圈執行順序（每一幀）：**

```
1. StateMachine.tick(deltaTime)      → 計算行為狀態與目標位置
2. CollisionSystem.check()           → 碰撞檢測與回饋
3. AnimationManager.update(deltaTime)→ 動畫混合與播放推進
4. ExpressionManager.resolve()       → 表情優先級仲裁
5. VRMController.applyState()        → 將結果套用到 VRM 模型
6. renderer.render(scene, camera)    → 渲染輸出
```

此順序至關重要，後面的步驟依賴前面的結果。

#### core/VRMController.ts

封裝 `@pixiv/three-vrm` 的所有操作，其他模組不直接碰 VRM 內部結構。

**職責：**

- VRM 模型載入、骨骼存取、表情控制、動畫 mixer 管理
- **Hip 跨幀平滑（階段 B）**：吸收動畫切換造成的 hip 瞬間跳變
  - 維護 `smoothedHipsWorld`，每幀以 lerp 追上 mixer 套用後的實際 hip 世界座標
  - 距離自適應速率：< 5cm 用 RATE_NEAR 緊密追蹤，≥ 5cm 用 RATE_FAR 緩慢追上
  - 補償 `vrm.scene.position` 讓 hip 視覺位置在世界座標連續
- **SpringBone 過渡保護（Layer 6）**：hip 跨幀距離 > 30cm 時呼叫 `vrm.springBoneManager.reset()` 避免頭髮 / 衣物彈跳

**update 順序（每幀）：**

1. `vrm.update(dt)` — SpringBone 物理（沿用既有順序）
2. `mixer.update(dt)` — 套用本幀動畫到骨骼 local
3. `applyHipSmoothing(dt)` — 平滑 + 必要時 SpringBone reset

**對外介面：**

- `loadModel(url: string): Promise<void>` — 載入 VRM 模型。
- `getBlendShapes(): string[]` — 取得模型支援的表情清單。
- `setBlendShape(name: string, value: number): void` — 設定表情權重。
- `setBoneRotation(boneName: string, rotation: Quaternion): void` — 設定骨骼旋轉。
- `getAnimationMixer(): AnimationMixer` — 提供 mixer 給 AnimationManager 使用。
- `getHipsRelativeOffset(): { x, y, z } | null` — 取得 hips 骨骼世界座標相對於 vrm.scene 原點的 3D 偏移量（sit 狀態下三軸補償用）。
- `update(deltaTime: number): void` — 更新 VRM SpringBone + mixer + hip 平滑。

#### animation/AnimationManager.ts

管理所有 .vrma 動畫的載入、索引、播放控制與**平順過渡**。

**職責：**

- 透過 `VRMAnimationLoaderPlugin` 載入 .vrma 並轉換為 `AnimationClip`。
- 維護按分類（idle/action/sit/fall/collide/peek）索引的動畫清單。
- idle 動畫的加權隨機選取與自動輪播（每 5–12 秒）。
- 系統動畫（walk/sit/drag/peek/hide_show 等）的優先級播放與恢復。

**動作平順化機制（v0.3 強化）：**

1. **分類化 crossfade 時長**（`getCrossfadeDurationFor(category)`）：
   - idle: 0.7s, action: 1.0s, sit: 1.5s, fall/collide: 0.3s, peek: 0.6s
   - 不同類別動作的姿態差異不同，使用差異化時長
2. **偽 inertialization（cubic 權重曲線）**：取代 Three.js 預設的線性 crossfade
   - 用 ease-out cubic 衰減舊動作 weight：`(1 - t)^3`
   - 舊動作前期保留較久（t=0.1 仍 73% 影響），後期快速釋放
   - 視覺效果類似真正 inertialization 的「捕捉當前動量」
   - 透過 `setEffectiveWeight` 手動推進，記錄 `transitionState`
3. **return-to-idle 緩衝**：action 結束後 fade 進 idle 用 1.0s（取代預設 0.7s）
   - 掩蓋 action 結尾 clamped pose 與 idle 起始 pose 的差異

**對外介面：**

- `loadAnimations(entries: AnimationEntry[]): Promise<void>`
- `playByCategory(category: AnimationCategory): void`
- `playByName(name: string): void`
- `playSystemAnimation(name: string, loop?, fadeDuration?): boolean`
- `stopSystemAnimation(): void`
- `stopCurrent(): void`
- `getCurrentClip(): AnimationClip | null`
- `hasCategory(category: AnimationCategory): boolean`
- `update(deltaTime: number): void` — 推進 transition + idle 輪播

#### animation/FallbackAnimation.ts

內建的 fallback 動畫模組，純程式碼驅動。

**職責：**

- 以程式碼驅動 bone rotation 實作呼吸動畫（胸部骨骼微幅正弦波上下）。
- 以程式碼驅動 BlendShape 實作眨眼動畫（週期性觸發）。
- 當 AnimationManager 無可用 idle 動畫時由 SceneManager 切換到此模組。

**對外介面：**

- `start(): void`
- `stop(): void`
- `update(deltaTime: number): void`

#### expression/ExpressionManager.ts

管理 BlendShape 表情的自動輪播、手動切換、優先級仲裁與**平滑過渡**。

**職責：**

- 自動模式：維護隨機間隔計時器（15–45 秒），從允許自動播放的表情中選取。
- 手動模式：接收使用者指定的表情。
- 優先級仲裁：根據以下優先級決定套用哪個來源：
  1. .vrma 動畫內的表情軌道（最高，由 SceneManager 在動畫播放時跳過 ExpressionManager 實現）
  2. 手動指定的表情
  3. 自動隨機表情（最低）
- **過渡管理（階段 A：通用線性過渡）**：
  - 切換表情時，舊表情進入 `previous` slot 從當前 value → 0 fade out
  - 新表情進入 `current` slot 從 0 → 1 fade in
  - 過渡時長 0.5 秒，線性插值（每幀 deltaTime / 0.5）
  - `update()` 由 SceneManager 每幀呼叫推進過渡與自動計時器
  - 解決瞬間切換問題，視覺接近 .vrma 內建 BlendShape 軌道效果

**對外介面：**

- `setManualExpression(name: string | null): void` — 設定手動表情，觸發 fade
- `setAutoEnabled(enabled: boolean): void`
- `setAllowedAutoExpressions(names: string[]): void`
- `setAvailableExpressions(names: string[]): void`
- `update(deltaTime: number): void` — 每幀呼叫推進過渡與自動計時
- `resolve(): ExpressionState` — 回傳 `{ current, previous }`，呼叫端須同時套用兩者

**未來擴充（階段 B）**：每表情對應 .vrma 動畫檔（`EXPR_*.vrma`），由獨立的 ExpressionAnimationManager 透過 mixer 播放。SceneManager 會在表情動畫播放中跳過 ExpressionManager（與 actionPlaying 跳過機制一致）。

#### behavior/StateMachine.ts

自主移動的行為狀態機。純邏輯模組，不直接操作 3D 物件或視窗。

**狀態定義：**

```
idle ──(60%)──→ walk
     ──(20%)──→ sit
     ──(10%)──→ peek
     ──(10%)──→ idle（繼續待機）

walk ──(碰撞)──→ idle / sit
     ──(到達目標)──→ idle

sit  ──(超時/視窗關閉)──→ fall → idle

peek ──(超時)──→ walk / idle
```

**對外介面：**

- `tick(deltaTime: number): BehaviorOutput` — 輸出目標位置、方向、當前狀態名稱。
- `pause(): void` / `resume(): void` — 暫停/恢復自主移動。
- `forceState(state: BehaviorState): void` — 強制切換狀態（如拖曳結束時）。

**設計要點：**

- `BehaviorOutput` 包含 `targetPosition`、`currentState`、`stateChanged` 等欄位。
- 不直接呼叫動畫播放，由 BehaviorAnimationBridge 監聽狀態變化後對應到動畫分類。
- 純邏輯使得單元測試不需要 mock Three.js。

#### behavior/CollisionSystem.ts

碰撞判定模組。

**職責：**

- 輸入：角色 bounding box + 視窗碰撞體清單（從 Electron 主程序透過 IPC 取得）+ 螢幕邊界。
- 輸出：碰撞事件（碰到哪個邊、可吸附的視窗頂部列表、被遮擋的區域）。
- AABB 矩形碰撞檢測。

**對外介面：**

- `updateWindowRects(rects: WindowRect[]): void`
- `check(characterBounds: Rect): CollisionResult`
- `getSnappableWindows(characterBounds: Rect, threshold: number): WindowRect[]`
- `getOcclusionRegion(characterBounds: Rect): Region | null`

#### behavior/BehaviorAnimationBridge.ts

狀態機與動畫系統之間的橋接模組。

**職責：**

- 監聽 StateMachine 的狀態變化。
- 將行為狀態對應到動畫分類：`idle→idle`、`walk→idle`（邊走邊播 idle）、`sit→sit`、`peek→peek`、`collide→collide`、`fall→fall`。
- 呼叫 AnimationManager 播放對應動畫。
- 處理無對應動畫的 fallback 邏輯。

#### interaction/DragHandler.ts

拖曳互動模組。

**職責：**

- 監聽滑鼠事件，計算拖曳偏移量。
- 拖曳開始時暫停 StateMachine。
- 拖曳過程中透過 Electron BrowserWindow `setPosition()` 移動視窗。
- 拖曳結束時判定吸附（距離視窗頂部 ≤ 20px）並決定進入 sit 或 idle。
- 邊緣碰撞檢測（至少保留 20% 在螢幕內）。
- 滾輪縮放事件處理。

#### interaction/ContextMenu.ts

右鍵選單模組。

**職責：**

- 從 AnimationManager 取得 action 動畫清單。
- 從 ExpressionManager 取得可用表情清單。
- 建構選單樹狀結構（動畫子選單、表情子選單、縮放、暫停自主移動、設定）。
- 超過 15 項時啟用捲動/分頁。
- 處理選單項目點擊事件並分發到對應模組。

#### bridge/ElectronIPC.ts

封裝所有 Electron IPC 呼叫，前端其他模組不直接呼叫 `window.electronAPI` 或 `ipcRenderer`。

**職責：**

- 將所有 IPC Commands 包裝為 typed async 函式（對應 `electron/ipcHandlers.ts` 中的 `ipcMain.handle()`）。
- 將所有 Events 包裝為 typed callback 註冊介面（對應 `webContents.send()` 推送的事件）。
- 統一的錯誤處理（IPC 失敗時的 retry、fallback、日誌記錄）。

**範例：**

```typescript
// 其他模組使用方式
import { ElectronIPC } from '../bridge/ElectronIPC';

const ipc = new ElectronIPC();
const windows = await ipc.getWindowList();
ipc.onWindowLayoutChanged((rects) => {
  collisionSystem.updateWindowRects(rects);
});
```

#### types/

共用型別定義，確保 Electron 主程序和 TypeScript 渲染層兩側的資料結構一致。

```typescript
// types/window.ts
interface WindowRect {
  hwnd: number;
  title: string;
  x: number;
  y: number;
  width: number;
  height: number;
  zOrder: number;
}

// types/animation.ts
type AnimationCategory = 'idle' | 'action' | 'sit' | 'fall' | 'collide' | 'peek';

interface AnimationEntry {
  fileName: string;
  displayName: string;
  category: AnimationCategory;
  loop: boolean;
  weight: number;
}

// types/config.ts
interface AppConfig {
  vrmModelPath: string | null;
  animationFolderPath: string | null;
  windowPosition: { x: number; y: number };
  windowSize: { width: number; height: number };
  scale: number;
  micEnabled: boolean;
  cameraEnabled: boolean;
  targetFps: number;
  powerSaveMode: boolean;
  autonomousMovementPaused: boolean;
}
```

---

## 3. Electron 主程序模組

> **歷史備註：** 本專案最初為 Tauri (Rust)，由於 Windows API 經 Rust FFI 持續 crash 而遷移至 Electron。`src-tauri/` 保留作為參考，不再編譯（詳見 LESSONS.md）。

### 3.1 模組總覽

```
electron/
├── main.ts                  # 進入點、BrowserWindow 建立、protocol 註冊
├── preload.ts               # contextBridge 暴露 IPC API
├── ipcHandlers.ts           # 所有 ipcMain.handle() 註冊
├── fileManager.ts           # config.json / animations.json 管理
├── windowMonitor.ts         # koffi GetWindow 視窗列舉（Windows-only）
├── windowRegion.ts          # [已棄用] koffi SetWindowRgn
├── systemTray.ts            # 系統托盤選單
└── platform/                # 跨平台抽象層
    ├── index.ts             # isWindows / isMac 旗標 + 統一匯出
    ├── windowConfig.ts      # 各平台 BrowserWindow 參數與建立後設定
    └── protocolHelper.ts    # local-file 協定路徑解析（兩平台行為不同）
```

### 3.2 各模組職責

#### windowMonitor.ts（**Windows-only**）

- 以 `setInterval` 每 ~300ms 呼叫 koffi `GetWindow` 遍歷桌面視窗。
- 過濾不可見、最小化、桌寵自身、UWP cloaked、TOOLWINDOW 樣式視窗。
- 與上一次結果做差異比對，僅在佈局變化時透過 `webContents.send('window_layout_changed', rects)` 推送。
- macOS 上不啟動此模組（早走 return），所有視窗感知功能優雅降級為「無視窗清單」。

#### fileManager.ts

- 掃描指定資料夾的 .vrma 檔案，回傳檔案清單。
- 讀寫 `~/.virtual-assistant-desktop/config.json` 和 `animations.json`。
- config.json 損毀偵測：解析失敗時自動備份為 `.bak` 並以預設值重建。
- animations.json 同步：掃描結果與現有設定合併。

#### systemTray.ts

- 建立系統托盤圖示與選單（Windows 通知區 / macOS 選單列）。
- 動態選單資料由 renderer process 推送，主程序快取後重建。
- 選單項目點擊透過 `tray_action` IPC event 通知前端。

#### platform/

- `index.ts` — 匯出 `isWindows`、`isMac` 旗標。其他模組需要平台判斷時透過此處取用，禁止散落 `process.platform` 判斷。
- `windowConfig.ts` — `getWindowOptions(bounds)` 與 `applyPostCreateSetup(win, bounds)`，封裝兩平台 BrowserWindow 的差異（macOS 需要 `setIgnoreMouseEvents(true, { forward: true })`）。
- `protocolHelper.ts` — `resolveLocalFilePath(url)`，處理 local-file 協定在兩平台不同的根目錄格式。

---

## 4. 關鍵設計決策

### 4.1 視窗位置同步策略

角色在螢幕上的移動是透過 Electron BrowserWindow `setPosition()` 移動整個透明視窗實現的，不是在 canvas 內移動 3D 模型。3D 模型永遠位於 canvas 中央。

**理由：**

- 滑鼠穿透的 hit-test 依賴視窗位置，如果模型在 canvas 內偏移，穿透區域的計算會非常複雜。
- OS 層級的視窗移動效能遠優於在大 canvas 內移動渲染區域。
- `SetWindowRgn` 的遮擋裁切也是以視窗座標為基準。

### 4.2 設定視窗用獨立 WebView

設定視窗是透過 Electron 的 BrowserWindow 開啟的獨立視窗，而非在主透明視窗上蓋一層 UI。

**理由：**

- 主視窗是透明無邊框的，在上面做複雜表單 UI 會有渲染和互動問題。
- 獨立視窗可以有正常的標題列、邊框、可縮放行為。
- 設定視窗和主視窗的生命週期獨立，關閉設定不影響桌寵。

### 4.3 狀態機與動畫的解耦

StateMachine 只輸出「目標位置」和「當前行為狀態名稱」，不直接呼叫動畫播放。中間由 BehaviorAnimationBridge 負責將狀態對應到動畫分類。

**理由：**

- StateMachine 的邏輯可以在不依賴 Three.js 的環境下進行單元測試。
- 動畫分類的對應規則可以獨立修改，不影響狀態機邏輯。
- 未來新增行為狀態時，只需在 Bridge 中加入對應規則。

### 4.4 IPC 通訊的錯誤邊界

ElectronIPC 模組應實作以下錯誤處理策略：

- **視窗列表取得失敗：** 使用上一次的快取資料，不中斷渲染迴圈。
- **設定讀取失敗：** 使用預設值，記錄警告日誌。
- **設定寫入失敗：** 在記憶體中保留變更，下次 tick 重試，最多重試 3 次後放棄並通知使用者。
- **檔案選擇器取消：** 視為正常操作，不報錯。

### 4.5 render loop 的幀率控制

不使用 `setInterval` 控制幀率，而是在 `requestAnimationFrame` 回呼中用 deltaTime 判斷是否需要跳過此幀：

```typescript
// 概念示意
const targetInterval = 1000 / targetFps;
let lastFrameTime = 0;

function loop(now: number) {
  requestAnimationFrame(loop);
  const delta = now - lastFrameTime;
  if (delta < targetInterval) return; // 跳過此幀
  lastFrameTime = now - (delta % targetInterval);
  // 執行 update 和 render
}
```

**理由：** `requestAnimationFrame` 自帶 vsync 且在頁面不可見時自動暫停，比 `setInterval` 更省電且更穩定。

### 4.6 跨平台開發原則

本專案目標平台為 **Windows 10/11 + macOS 11+**。開發新功能時必須遵守：

1. **平台分支集中化**：所有 `process.platform === 'win32'` / `'darwin'` 判斷必須只出現在 `electron/platform/`。其他模組透過匯入 `isWindows` / `isMac` 旗標使用。
2. **系統 API 必須優雅降級**：若使用 koffi、AppleScript、原生模組等只在單一平台可用的 API，**不可 throw**。在不支援的平台必須回傳預設值（空陣列、`null`、或 no-op）並 log warning。
3. **BrowserWindow 參數差異**：透過 `getWindowOptions(bounds)` 與 `applyPostCreateSetup(win, bounds)` 取得，禁止在 main.ts 直接用 `if (process.platform...)`。
4. **IPC handler 跨平台一致**：對前端而言，IPC API 簽名與回傳型別在兩平台必須一致。平台差異在 handler 內部處理，不外漏到型別。
5. **新功能 PR 須註明測試平台**：commit 訊息或 PR 描述須說明在哪個平台驗證過、預期在另一平台的行為。
6. **macOS 已知功能限制**：視窗碰撞 / 吸附 / 遮擋 / Peek 等 koffi 依賴功能在 macOS 停用，渲染、動畫、表情、自主移動正常運作。

---

## 5. 專案目錄結構

```
virtual-assistant-desktop/
├── vrmodels/                     # VRM 模型
├── vrma/                         # VRM 動畫
├── src-tauri/                    # [已棄用] 舊 Rust 後端（保留作參考，不再編譯）
│
├── src/                          # TypeScript 前端（主視窗）
│   ├── core/
│   │   ├── SceneManager.ts
│   │   └── VRMController.ts
│   ├── animation/
│   │   ├── AnimationManager.ts
│   │   └── FallbackAnimation.ts
│   ├── expression/
│   │   └── ExpressionManager.ts
│   ├── behavior/
│   │   ├── StateMachine.ts
│   │   ├── CollisionSystem.ts
│   │   └── BehaviorAnimationBridge.ts
│   ├── interaction/
│   │   ├── DragHandler.ts
│   │   └── ContextMenu.ts
│   ├── bridge/
│   │   └── ElectronIPC.ts
│   ├── types/
│   │   ├── config.ts
│   │   ├── animation.ts
│   │   └── window.ts
│   ├── main.ts
│   └── index.html
│
├── src-settings/                 # 設定視窗（獨立 Svelte app）
│   ├── App.svelte
│   ├── pages/
│   │   ├── ModelPage.svelte
│   │   ├── AnimationPage.svelte
│   │   ├── ExpressionPage.svelte
│   │   ├── DisplayPage.svelte
│   │   ├── PerformancePage.svelte
│   │   ├── DevicePage.svelte
│   │   └── AboutPage.svelte
│   └── main.ts
│
├── tests/                        # Vitest 測試
│   ├── unit/
│   │   ├── StateMachine.test.ts
│   │   ├── CollisionSystem.test.ts
│   │   ├── ExpressionManager.test.ts
│   │   └── AnimationManager.test.ts
│   └── integration/
│       └── ElectronIPC.test.ts
│
├── package.json
├── tsconfig.json
├── vite.config.ts
├── pnpm-lock.yaml
├── .eslintrc.json
├── .prettierrc
└── README.md
```

---

## 6. 模組依賴關係圖

```
                    ┌──────────────┐
                    │  main.ts     │
                    │  (進入點)     │
                    └──────┬───────┘
                           │
                    ┌──────▼───────┐
                    │ SceneManager │◄──────────────────────┐
                    │  (主迴圈)    │                        │
                    └──┬───┬───┬──┘                        │
                       │   │   │                           │
          ┌────────────┘   │   └────────────┐              │
          ▼                ▼                ▼              │
   ┌─────────────┐ ┌─────────────┐ ┌──────────────┐       │
   │ StateMachine │ │ Animation   │ │ Expression   │       │
   │             │ │ Manager     │ │ Manager      │       │
   └──────┬──────┘ └──────▲──────┘ └──────────────┘       │
          │               │                                │
          ▼               │                                │
   ┌─────────────┐ ┌──────┴───────┐                        │
   │ Collision   │ │ Behavior     │                        │
   │ System      │ │ Animation    │                        │
   └──────┬──────┘ │ Bridge       │                        │
          │        └──────────────┘                        │
          │                                                │
          ▼                                                │
   ┌─────────────┐     ┌──────────────┐    ┌─────────────┐│
   │ DragHandler │     │ ContextMenu  │    │ VRM         ││
   └──────┬──────┘     └──────┬───────┘    │ Controller  ││
          │                   │            └─────────────┘│
          └───────┬───────────┘                           │
                  ▼                                       │
           ┌─────────────┐                                │
           │ ElectronIPC │── IPC ──► Electron 主程序      │
           │ (橋接層)    │                                │
           └─────────────┘                                │
```

---

## 7. 開發順序建議

根據規格書的版本規劃，建議的模組開發順序：

### v0.1（透明視窗 + VRM + 動畫系統）

1. `SceneManager` — 透明背景 WebGL 渲染、幀率控制
2. `VRMController` — VRM 模型載入
3. `ElectronIPC` — 基礎 IPC 框架
4. `fileManager.ts` — config.json / animations.json 讀寫
5. `AnimationManager` — .vrma 載入與播放
6. `FallbackAnimation` — 內建呼吸/眨眼
7. 首次啟動流程（模型選擇、動畫資料夾選擇）
8. Electron `app.requestSingleInstanceLock()` — 單實例鎖定

### v0.2（視窗互動 + 自主移動 + 拖曳）

1. `windowMonitor.ts` — 視窗輪詢（koffi FFI，Windows-only）
2. `CollisionSystem` — 碰撞判定
3. `StateMachine` — 行為狀態機
4. `BehaviorAnimationBridge` — 狀態→動畫對應
5. `DragHandler` — 拖曳與吸附
6. 3D depth occlusion 遮擋實作（取代已棄用的 `SetWindowRgn`）
7. `ContextMenu` — 右鍵選單

### v0.3（表情 + 系統托盤）

1. `ExpressionManager` — 表情管理
2. `systemTray.ts` — 系統托盤
3. 設定視窗（`src-settings/`）基礎框架

### v0.4（Lip-sync + SpringBone）

1. 麥克風擷取模組（Electron 主程序）
2. Lip-sync 前端邏輯
3. SpringBone 啟用與效能調優

### v0.5（攝影機 + 進階設定 + 自動更新）

1. MediaPipe 整合或 Electron 主程序側攝影機備案
2. 設定視窗完整功能
3. electron-updater 自動更新設定
