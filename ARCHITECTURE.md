# virtual-assistant-desktop — 程式架構建議書

> **對應規格書版本：** v0.1 Draft  
> **更新日期：** 2026-04-03

---

## 1. 整體分層架構

系統分為三層，各層職責明確、邊界清晰：

```
┌─────────────────────────────────────────────┐
│           TypeScript 前端層                   │
│  Three.js 渲染、VRM 控制、動畫狀態機、        │
│  表情系統、碰撞判定、自主移動、UI             │
├─────────────────────────────────────────────┤
│           IPC 橋接層（TauriIPC）              │
│  Commands（前端→Rust）/ Events（Rust→前端）   │
├─────────────────────────────────────────────┤
│           Rust 後端層                         │
│  視窗感知、視窗裁切、檔案系統、系統托盤、     │
│  單實例鎖定、麥克風擷取                       │
└─────────────────────────────────────────────┘
```

**設計原則：**

- Rust 層負責所有需要系統權限的操作，不碰任何 3D 渲染邏輯。
- TypeScript 層負責所有視覺與互動邏輯，不直接呼叫系統 API。
- IPC 橋接層是兩邊的唯一溝通管道。若未來從 Tauri 換成 Electron，只需重寫此層。

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

**對外介面：**

- `loadModel(url: string): Promise<void>` — 載入 VRM 模型。
- `getBlendShapes(): string[]` — 取得模型支援的表情清單。
- `setBlendShape(name: string, value: number): void` — 設定表情權重。
- `setBoneRotation(boneName: string, rotation: Quaternion): void` — 設定骨骼旋轉。
- `getAnimationMixer(): AnimationMixer` — 提供 mixer 給 AnimationManager 使用。
- `update(deltaTime: number): void` — 更新 VRM 的 SpringBone 等內部邏輯。

#### animation/AnimationManager.ts

管理所有 .vrma 動畫的載入、索引、播放控制。

**職責：**

- 透過 `VRMAnimationLoaderPlugin` 載入 .vrma 並轉換為 `AnimationClip`。
- 維護按分類（idle/action/sit/fall/collide/peek）索引的動畫清單。
- 控制 `AnimationMixer` 的 crossfade 過渡。
- idle 動畫的加權隨機選取與自動輪播。

**對外介面：**

- `loadAnimations(entries: AnimationEntry[]): Promise<void>`
- `playByCategory(category: AnimationCategory): void`
- `playByName(name: string): void`
- `stopCurrent(): void`
- `getCurrentClip(): AnimationClip | null`
- `hasCategory(category: AnimationCategory): boolean`
- `update(deltaTime: number): void`

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

管理 BlendShape 表情的自動輪播、手動切換與優先級仲裁。

**職責：**

- 自動模式：維護隨機間隔計時器（15–45 秒），從允許自動播放的表情中選取。
- 手動模式：接收使用者指定的表情。
- 優先級仲裁：實作 `resolve()` 方法，根據以下優先級決定套用哪個來源：
  1. .vrma 動畫內的表情軌道（最高）
  2. 手動指定的表情
  3. 自動隨機表情（最低）

**對外介面：**

- `setManualExpression(name: string | null): void`
- `setAutoEnabled(enabled: boolean): void`
- `setAllowedExpressions(names: string[]): void`
- `resolve(): ExpressionState` — 回傳當前應套用的表情名稱與權重。

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

- 輸入：角色 bounding box + 視窗碰撞體清單（從 Rust 側透過 IPC 取得）+ 螢幕邊界。
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
- 拖曳過程中透過 Tauri `setPosition()` 移動視窗。
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

#### bridge/TauriIPC.ts

封裝所有 Tauri IPC 呼叫，前端其他模組不直接呼叫 `invoke()` 或 `listen()`。

**職責：**

- 將規格書 6.5 定義的所有 Commands 包裝為 typed async 函式。
- 將所有 Events 包裝為 typed EventEmitter 或 callback 註冊介面。
- 統一的錯誤處理（IPC 失敗時的 retry、fallback、日誌記錄）。

**範例：**

```typescript
// 其他模組使用方式
import { ipc } from '../bridge/TauriIPC';

const windows = await ipc.getWindowList();
ipc.onWindowLayoutChanged((rects) => {
  collisionSystem.updateWindowRects(rects);
});
```

#### types/

共用型別定義，確保 Rust 和 TypeScript 兩側的資料結構一致。

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

## 3. Rust 後端模組

### 3.1 模組總覽

```
src-tauri/src/
├── main.rs                 # 進入點、Tauri builder 設定
├── commands/               # Tauri command handlers
│   ├── mod.rs
│   ├── window_commands.rs  # get_window_list, set_window_region
│   ├── file_commands.rs    # scan_animations, read/write config, pick_file
│   └── device_commands.rs  # get_microphone_level, get_camera_frame
├── window_monitor.rs       # 視窗輪詢與差異比對
├── file_manager.rs         # 檔案讀寫與損毀處理
├── system_tray.rs          # 系統托盤
├── audio_capture.rs        # 麥克風擷取（v0.4 預留）
└── single_instance.rs      # 單實例鎖定
```

### 3.2 各模組職責

#### window_monitor.rs

- 以獨立執行緒運行，每秒 3–5 次呼叫 `EnumWindows` + `GetWindowRect`。
- 過濾不可見、最小化、桌寵自身的視窗。
- 與上一次結果做差異比對，僅在佈局變化時透過 Tauri event 推送 `window_layout_changed`。
- 提供 `set_window_region()` 函式，接收前端計算的裁切區域並呼叫 `SetWindowRgn`。

#### file_manager.rs

- 掃描指定資料夾的 .vrma 檔案，回傳檔案清單。
- 讀寫 `~/.virtual-assistant-desktop/config.json` 和 `animations.json`。
- config.json 損毀偵測：解析失敗時自動備份為 `.bak` 並以預設值重建。
- animations.json 同步：掃描結果與現有設定合併，移除已不存在的條目、新增新發現的檔案。

#### system_tray.rs

- 建立系統托盤圖示與右鍵選單。
- 麥克風/攝影機啟用時切換托盤圖示（隱私指示）。
- 選單項目點擊後透過 Tauri event 通知前端。

#### single_instance.rs

- 啟動時建立 named mutex。
- 偵測到已有實例時，透過 Windows 訊息找到現有實例視窗並帶到前景，新程序退出。

---

## 4. 關鍵設計決策

### 4.1 視窗位置同步策略

角色在螢幕上的移動是透過 Tauri 的 `setPosition()` 移動整個透明視窗實現的，不是在 canvas 內移動 3D 模型。3D 模型永遠位於 canvas 中央。

**理由：**

- 滑鼠穿透的 hit-test 依賴視窗位置，如果模型在 canvas 內偏移，穿透區域的計算會非常複雜。
- OS 層級的視窗移動效能遠優於在大 canvas 內移動渲染區域。
- `SetWindowRgn` 的遮擋裁切也是以視窗座標為基準。

### 4.2 設定視窗用獨立 WebView

設定視窗是透過 Tauri 多視窗 API 開啟的第二個 WebView，而非在主透明視窗上蓋一層 UI。

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

TauriIPC 模組應實作以下錯誤處理策略：

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

---

## 5. 專案目錄結構

```
virtual-assistant-desktop/
├── vrmodels/                     # VRM 模型
├── vrma/                         # VRM 動畫
├── src-tauri/                    # Rust 後端
│   ├── src/
│   │   ├── main.rs
│   │   ├── commands/
│   │   │   ├── mod.rs
│   │   │   ├── window_commands.rs
│   │   │   ├── file_commands.rs
│   │   │   └── device_commands.rs
│   │   ├── window_monitor.rs
│   │   ├── file_manager.rs
│   │   ├── system_tray.rs
│   │   ├── audio_capture.rs
│   │   └── single_instance.rs
│   ├── Cargo.toml
│   └── tauri.conf.json
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
│   │   └── TauriIPC.ts
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
│       └── TauriIPC.test.ts
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
           │ TauriIPC    │────── IPC ──────► Rust 後端    │
           │ (橋接層)    │                                │
           └─────────────┘                                │
```

---

## 7. 開發順序建議

根據規格書的版本規劃，建議的模組開發順序：

### v0.1（透明視窗 + VRM + 動畫系統）

1. `SceneManager` — 透明背景 WebGL 渲染、幀率控制
2. `VRMController` — VRM 模型載入
3. `TauriIPC` — 基礎 IPC 框架
4. `file_manager.rs` — config.json / animations.json 讀寫
5. `AnimationManager` — .vrma 載入與播放
6. `FallbackAnimation` — 內建呼吸/眨眼
7. 首次啟動流程（模型選擇、動畫資料夾選擇）
8. `single_instance.rs` — 單實例鎖定

### v0.2（視窗互動 + 自主移動 + 拖曳）

1. `window_monitor.rs` — 視窗輪詢
2. `CollisionSystem` — 碰撞判定
3. `StateMachine` — 行為狀態機
4. `BehaviorAnimationBridge` — 狀態→動畫對應
5. `DragHandler` — 拖曳與吸附
6. `SetWindowRgn` 遮擋實作
7. `ContextMenu` — 右鍵選單

### v0.3（表情 + 系統托盤）

1. `ExpressionManager` — 表情管理
2. `system_tray.rs` — 系統托盤
3. 設定視窗（`src-settings/`）基礎框架

### v0.4（Lip-sync + SpringBone）

1. `audio_capture.rs` — 麥克風擷取
2. Lip-sync 前端邏輯
3. SpringBone 啟用與效能調優

### v0.5（攝影機 + 進階設定 + 自動更新）

1. MediaPipe 整合或 Rust 側攝影機備案
2. 設定視窗完整功能
3. Tauri updater 設定
