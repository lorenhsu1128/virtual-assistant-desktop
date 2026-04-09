# 完整計畫書 — 影片動捕工作站

> 對應專案：virtual-assistant-desktop
> 文件版本：v1 Draft
> 建立日期：2026-04-09

---

## 1. 願景與範圍

**目標**：在桌寵主程式內提供一個獨立的「影片動捕工作站」子視窗，讓使用者載入影片 → 選取片段 → 動態捕捉 → 即時 scrub 預覽 → 匯出 `.vrma` 檔，該 `.vrma` 可被本專案自身的動畫系統直接載入播放。

**v1 範圍內**：
- 獨立 BrowserWindow 子視窗（Vanilla TS，抄 vrm-picker 架構）
- 兩個動捕引擎（EasyMocap sidecar、HybrIK-TS），下拉切換
- 含表情、含 hip 位移的 VRMA 匯出
- 時間軸雙拖曳把手選區間、預處理後 scrub 查表

**v1 範圍外**（未來版本）：
- Kalidokit 引擎
- 即時攝影機模式（v0.5 臉部追蹤再議）
- 動畫編輯 / keyframe 修正
- 多人偵測
- FK 精細版 SMPL→VRM 映射
- Draft 儲存 / 回復
- VMD 匯出

---

## 2. 系統架構

```
┌────────────────────────────────────────────────────────────┐
│  Electron Main                                              │
│  ├─ mocapStudioWindow.ts      開啟 / 關閉子視窗              │
│  ├─ easyMocapSidecar.ts        Python sidecar 生命週期       │
│  ├─ ipcHandlers.ts             mocap:* handlers              │
│  ├─ systemTray.ts              新選單項「影片動捕工作站」      │
│  └─ platform/windowConfig.ts   子視窗 BrowserWindow options  │
└────────────────────────────────────────────────────────────┘
                         │
                         │ IPC (preload → contextBridge)
                         ▼
┌────────────────────────────────────────────────────────────┐
│  Renderer (mocap-studio)                                    │
│                                                             │
│  MocapStudioApp — 應用狀態機                                 │
│  ├─ TopBar        載入影片 / 引擎下拉 / 轉換 / 匯出            │
│  ├─ VideoPanel    <video> + 2D overlay canvas               │
│  ├─ PreviewPanel  Three.js + VRM（PerspectiveCamera）       │
│  └─ Timeline      scrubber + in/out 雙拖曳把手               │
│                                                             │
│  src/mocap/ — 純邏輯，可單測                                 │
│  ├─ types.ts             MocapFrame / SmplTrack / MocapEngine│
│  ├─ engines/             EasyMocap / HybrIK-TS               │
│  ├─ smpl/                smplToVrm / jointLimits / skeleton  │
│  ├─ filters/             OneEuroFilter (quat log-map 版)     │
│  ├─ exporter/            VrmaExporter / gltfWriter           │
│  └─ mediapipe/           HolisticRunner（HybrIK-TS 才用）    │
└────────────────────────────────────────────────────────────┘
                         │
                         │ (Phase 4+) stdio / msgpack
                         ▼
┌────────────────────────────────────────────────────────────┐
│  Python Sidecar (使用者自裝)                                 │
│  easymocap_sidecar.py                                       │
│  ├─ 接 { videoPath, startMs, endMs }                         │
│  ├─ 呼叫 EasyMocap → SMPL params                             │
│  └─ 輸出標準化 SMPL JSON                                      │
└────────────────────────────────────────────────────────────┘
```

---

## 3. 核心資料結構

### 3.1 靜態（JSON / 檔案交換）

```ts
// Python sidecar 回傳給 TS 的 SMPL 軌道
interface SmplTrack {
  version: 1
  fps: number                // 通常 30
  frameCount: number
  betas: number[]            // β[10]，體型參數（v1 用不到但保留）
  // 每幀 24 個 joint 的 axis-angle（弧度）
  // frames[f][j] = [ax, ay, az]
  frames: number[][][]       // [frameCount][24][3]
  // 每幀 root translation (hips world position)
  trans: number[][]          // [frameCount][3]
  // 表情（v1 先從 MediaPipe blendshape 額外算，Python 端不管）
}
```

### 3.2 動態（Renderer 內部中間表示）

```ts
// 下游 pipeline 的統一幀格式
interface MocapFrame {
  timestampMs: number
  // VRM humanoid local rotation（smplToVrm 之後）
  boneRotations: Partial<Record<VRMHumanBoneName, THREE.Quaternion>>
  // VRM BlendShape 名 → 權重（0–1）
  blendShapes: Record<string, number>
  // 根部世界座標（相對於 MocapFrame[0] 的 hips 原點）
  hipsWorldPosition: { x: number; y: number; z: number } | null
}

// 引擎介面
interface MocapEngine {
  readonly id: 'easymocap' | 'hybrik-ts'
  readonly name: string
  readonly requiresSidecar: boolean
  init(): Promise<void>
  // 批次處理影片區間 → SMPL track
  solveRange(videoPath: string, startMs: number, endMs: number,
             onProgress: (ratio: number) => void,
             signal: AbortSignal): Promise<SmplTrack>
  dispose(): void
}
```

**設計要點**：
- 引擎輸出是 `SmplTrack`，不是 `MocapFrame[]`。這讓 SMPL→VRM 映射、clamp、filter 都在引擎**外**，共用 downstream pipeline。
- 表情不經過 SMPL：v1 先不做表情；v2 考慮從 MediaPipe FaceLandmarker 額外跑一次得到 blendshape weight，與 SMPL 軌道合流到 `MocapFrame`。

---

## 4. IPC 介面（mocap:* namespace）

| Channel | 方向 | 參數 | 回傳 |
|---|---|---|---|
| `mocap:open_studio` | R→M | — | `void` |
| `mocap:get_current_vrm_path` | R→M | — | `string \| null` |
| `mocap:pick_video` | R→M | — | `string \| null` |
| `mocap:save_vrma` | R→M | `{ bytes: Uint8Array, suggestedName: string }` | `string \| null` |
| `mocap:sidecar_ensure` | R→M | `{ engineId }` | `SidecarStatus` |
| `mocap:sidecar_solve` | R→M | `{ videoPath, startMs, endMs }` | `SmplTrack` |
| `mocap:sidecar_progress` | M→R (event) | `{ ratio }` | — |
| `mocap:sidecar_stop` | R→M | — | `void` |

**同步三處**：`electron/ipcHandlers.ts` / `electron/preload.ts` / `src/bridge/ElectronIPC.ts`（LESSONS.md 2026-04-03 教訓）。

**SidecarStatus** 型別：
```ts
type SidecarStatus =
  | { state: 'ready'; engineId: string }
  | { state: 'python_not_found'; hint: string }
  | { state: 'easymocap_not_installed'; hint: string }
  | { state: 'starting' }
  | { state: 'error'; message: string }
```

---

## 5. 檔案清單

### 5.1 新增

```
mocap-studio.html                        # vite 第三個 entry

src/mocap-studio/
├── main.ts                              # entry、建立 MocapStudioApp
├── MocapStudioApp.ts                    # 應用狀態機（載影片/轉換/scrub/匯出）
├── ui/
│   ├── TopBar.ts
│   ├── VideoPanel.ts                    # <video> + 2D overlay
│   ├── PreviewPanel.ts                  # Three.js PerspectiveCamera + VRM
│   └── Timeline.ts                      # scrubber + 雙拖曳把手
└── style.css

src/mocap/
├── types.ts                             # MocapFrame / SmplTrack / MocapEngine
├── engines/
│   ├── EngineRegistry.ts
│   ├── EasyMocapSidecarEngine.ts        # Phase 4
│   └── HybrikTsEngine.ts                # Phase 5
├── smpl/
│   ├── SmplSkeleton.ts                  # 24 joint 定義、parent chain
│   ├── smplToVrm.ts                     # 核心：SMPL θ → VRM quat（含「併入 parent」自適應）
│   ├── jointLimits.ts                   # hardcode 限制表
│   └── applyClamp.ts                    # 套用 limits
├── filters/
│   └── OneEuroFilter.ts                 # quat log-map 版
├── exporter/
│   ├── VrmaExporter.ts                  # MocapFrame[] → GLB Uint8Array
│   └── gltfWriter.ts                    # glTF JSON + GLB binary 組裝
├── mediapipe/
│   └── HolisticRunner.ts                # Phase 5 (HybrIK-TS only)
└── hybrik/
    ├── SolverCore.ts                    # Phase 5：IK 核心
    ├── TwistSwing.ts                    # Phase 5：twist-swing 分解
    └── LandmarkToSmplJoint.ts           # Phase 5：33→24 mapping

electron/
├── mocapStudioWindow.ts                 # BrowserWindow lifecycle
└── easyMocapSidecar.ts                  # Phase 4：spawn / idle kill / stdio

resources/python/
└── easymocap_sidecar.py                 # Phase 4：Python wrapper 腳本（打包進安裝包）

tests/
├── unit/
│   ├── smplToVrm.test.ts                # Phase 2a
│   ├── jointLimits.test.ts              # Phase 2a
│   ├── OneEuroFilter.test.ts            # Phase 2b
│   └── VrmaExporter.test.ts             # Phase 3（多 fixture round-trip）
└── fixtures/mocap/
    ├── smpl_rest.json                   # 靜止
    ├── smpl_single_joint.json           # 單關節（左肘屈 90°）
    ├── smpl_full_body.json               # 全身動作
    ├── smpl_with_hips.json              # 含 hip 位移
    └── smpl_with_blendshapes.json       # 含表情
```

### 5.2 修改

```
vite.config.ts                           # build.rollupOptions.input 加第三 entry
electron/ipcHandlers.ts                  # 註冊 mocap:* handlers
electron/preload.ts                      # contextBridge 暴露 mocap API
electron/systemTray.ts                   # 加「影片動捕工作站」選單項
electron/platform/windowConfig.ts        # 加 mocap-studio 視窗 options
src/bridge/ElectronIPC.ts                # 前端 mocap 方法包裝
src/types/config.ts                      # 若要記住上次影片路徑（optional）
CLAUDE.md                                # 目錄結構區塊補上 src/mocap*
```

---

## 6. Phase 詳細計畫

### Phase 0 — Scaffolding（基礎設施，零 mocap 邏輯）

**動作**：
1. `git pull`（拉遠端）
2. `vite.config.ts` 改 multi-page：加入 `mocap-studio.html` 為第三個 input（`index`、`vrm-picker`、`mocap-studio`）
3. 建立 `mocap-studio.html` 與 `src/mocap-studio/` 目錄 + 檔案骨架（`main.ts`、`MocapStudioApp.ts`、`style.css`）
4. 先把 `PreviewPanel.ts` 寫成最小版：`PerspectiveCamera` + Three.js scene + 載入主視窗 VRM
5. `electron/mocapStudioWindow.ts`：BrowserWindow 建立/關閉，抄 `vrmPickerWindow.ts` 結構
6. `electron/platform/windowConfig.ts` 加 `getMocapStudioWindowOptions(bounds)`
7. `electron/systemTray.ts` 加選單項「影片動捕工作站」
8. IPC 三層同步：`mocap:open_studio`、`mocap:get_current_vrm_path`
9. `pnpm build:electron` + kill electron + `pnpm dev`

**驗收**：托盤點「影片動捕工作站」→ 開啟子視窗 → 右側 panel 顯示目前主視窗的 VRM（PerspectiveCamera、無粗黑邊、MToon outline 正常）。

**風險**：vite multi-page 設定 + electron-builder `files` 打包路徑。有 vrm-picker 作為參考，複製即可。

---

### Phase 1 — 影片載入與時間軸

**動作**：
1. TopBar 加「載入影片」按鈕，呼叫 `mocap:pick_video`
2. `VideoPanel.ts` 的 `<video>` 載入所選檔案
3. `Timeline.ts`：總長 bar + 目前位置游標 + 兩個可拖曳把手（in / out），把手邊顯示 `mm:ss.fff`
4. 拖動 in/out 把手時即時更新 `<video>.currentTime` 預覽該點
5. 播放 / 暫停鈕

**驗收**：載影片 → 拖 in/out → 影片 seek 同步 → 在 in/out 之間能播放。

**風險**：低。純 HTML5 video API。

---

### Phase 2 — 下游 pipeline（靜態 fixture 驅動，無引擎）

**這是最關鍵的基礎，做完之後引擎只剩「吐 SmplTrack」這單一責任**。

#### 2a — SMPL 骨架與映射
1. `smpl/SmplSkeleton.ts`：24 joint 定義、parent chain、rest pose 方向常數
2. `smpl/smplToVrm.ts`：
   - 接 `SmplTrack.frames[f]` → VRM `boneRotations`
   - runtime 讀 VRM humanoid rest pose（選項 B）
   - 缺失 bone 自適應：四元數累乘到直系 parent（Q28 策略）
   - 單元測試：`tests/unit/smplToVrm.test.ts`
     - rest fixture → 所有 bone 都是 identity quat
     - single_joint fixture → 只有 leftLowerArm 非 identity
     - full_body → parent chain 傳遞正確

3. `smpl/jointLimits.ts`：hardcode VRM humanoid bone 的 Euler 限制表
4. `smpl/applyClamp.ts`：套用 limits 到 `MocapFrame`
   - 單元測試：超出範圍的輸入被 clamp 到邊界

#### 2b — One Euro Filter
1. `filters/OneEuroFilter.ts`：
   - 對 quaternion：轉 log map（tangent space）→ 各分量獨立 One Euro → 轉回 quat → 歸一化
   - 參數：`minCutoff`（平滑強度）、`beta`（速度響應）、`dCutoff`
2. 單元測試：
   - 靜止雜訊軌道 → filter 後漂移 < 閾值
   - 階梯輸入 → 低 beta 時延遲大、高 beta 時延遲小

#### 2c — Fixture pipeline 閉環
1. `MocapStudioApp.ts` 加「載入 SMPL fixture（dev-only 按鈕）」
2. fixture → smplToVrm → clamp → filter → `MocapFrame[]`
3. Timeline 變成 `MocapFrame[]` 的 scrub index
4. PreviewPanel 根據 scrub 位置套用 `MocapFrame` 到 VRM（**直接 set bone quat，不經過 AnimationMixer**，避免 mixer.clipAction reuse 坑）
5. 寫一組 `smpl_full_body.json` 手工 fixture 測試整條

**驗收**：載入 fixture → scrub timeline → VRM 做出對應動作，動作連續平順。

**風險**：中。smplToVrm 的座標系轉換容易手忙腳亂，需要多個 fixture + 單測覆蓋。

---

### Phase 3 — VRMA exporter（高風險，獨立 phase）

**動作**：
1. `exporter/gltfWriter.ts`：
   - 手刻 glTF 2.0 JSON + GLB binary（`0x46546C67` magic + JSON chunk + BIN chunk）
   - 參考 three.js `GLTFExporter` 原始碼結構（但不依賴它，因為我們要加 extension）
2. `exporter/VrmaExporter.ts`：
   - 輸入：`MocapFrame[]`
   - 輸出：`Uint8Array`（GLB）
   - 結構：
     - Node tree：humanoid bone nodes（用 VRM 1.0 humanoid bone 命名）
     - Animation：rotation sampler per bone（CUBICSPLINE 或 LINEAR）
     - BlendShape：morph target weight sampler
     - Hip translation：hips node 的 translation sampler
     - **`extensionsUsed: ['VRMC_vrm_animation']`**
     - **`extensions.VRMC_vrm_animation`**：humanoid bone → node index mapping + expressions mapping
3. 匯出流程：TopBar「匯出 .vrma」→ `mocap:save_vrma` → 存檔對話框
4. **Round-trip 驗證單元測試**：
   - 多個 fixture（rest / single_joint / full_body / with_hips / with_blendshapes）
   - 每個 fixture：`MocapFrame[] → VrmaExporter → Uint8Array → 本專案 VRMAnimationLoaderPlugin → 載回 → 比對`
   - 比對策略：
     - 骨骼：quaternion dot product > 1 - 1e-5（同向性）
     - 表情：weight 差 < 1e-5
     - Hip：position 差 < 1e-5
   - fixture 中任一筆幀誤差超標 → 測試 fail
5. **肉眼驗證**：把 `full_body` export 的 .vrma 載到主視窗動畫系統播一次，動作看起來要對

**驗收**：五個 fixture 的 round-trip 測試全過 + 肉眼驗證通過。

**風險**：**最高**。VRMA 格式規格細節多，任何欄位缺漏會造成 loader 靜默失敗。緩解：round-trip 測試加肉眼驗證。

**預估投入**：比其他 phase 多 50%，但鎖死風險後後續引擎工作會很順。

---

### Phase 4 — EasyMocap sidecar（第一條真引擎）

#### 4a — Python sidecar 腳本
1. `resources/python/easymocap_sidecar.py`：
   - stdin 接 JSON line `{ cmd: 'solve', videoPath, startMs, endMs }`
   - 呼叫 EasyMocap API（或 subprocess demo script）處理影片
   - 輸出標準 SMPL JSON 到 stdout
   - stderr 輸出進度 `{ progress: 0.42 }`
   - 支援 `{ cmd: 'ping' }` 健康檢查、`{ cmd: 'shutdown' }` 主動關閉
2. 使用者文件：README 新增「安裝 EasyMocap」章節

#### 4b — Electron 端 sidecar 管理
1. `electron/easyMocapSidecar.ts`：
   - `ensure()`：檢查 python 是否在 PATH（`python --version`）→ 檢查 EasyMocap 是否可 import → spawn python 子進程
   - 懶啟動：第一次 `solve()` 被呼叫時才 spawn
   - Idle kill：每次 solve 完重設 10 分鐘 timer，timer 到自動 `shutdown`
   - stdio 協定：line-delimited JSON
   - 進度事件透過 `mocap:sidecar_progress` 推到 renderer
   - 錯誤分類：python_not_found / easymocap_not_installed / runtime_error
2. IPC handlers：`mocap:sidecar_ensure` / `mocap:sidecar_solve` / `mocap:sidecar_stop`

#### 4c — TS 引擎 adapter
1. `engines/EasyMocapSidecarEngine.ts`：
   - `init()` → 呼叫 `ipc.mocap.sidecarEnsure()`
   - `solveRange()` → 呼叫 `ipc.mocap.sidecarSolve()` → 回傳 `SmplTrack`
   - `requiresSidecar: true`
2. `EngineRegistry.ts` 註冊

#### 4d — UI 串接
1. TopBar 下拉選「EasyMocap」→ init → 顯示 sidecar 狀態（ready/starting/error）
2. 「轉換」按鈕：disabled 直到 sidecar ready；按下後 `solveRange` + progress bar
3. 取消按鈕：`AbortSignal` 傳給 engine → engine 呼叫 `sidecar_stop` 中斷 python
4. 結束後自動執行 Phase 2c 的 fixture pipeline 邏輯（SmplTrack → smplToVrm → clamp → filter → MocapFrame[]）
5. 時間軸 scrub 立刻可用
6. 「匯出 .vrma」按鈕 enabled

**驗收**：使用者裝好 python + EasyMocap → 選影片 → 選區間 → 轉換 → scrub 看到 VRM 動 → 匯出 .vrma → 主視窗能載回播放。

**風險**：高。Python 環境變數跨平台差異大（Windows 用 `python`、macOS 可能是 `python3`），spawn 的 cwd 要對，stdio buffer size 要設對。緩解：早期就測跨平台。

---

### Phase 5 — HybrIK-TS engine（第二條引擎）

#### 5a — MediaPipe 接入
1. `mediapipe/HolisticRunner.ts`：包裝 `@mediapipe/tasks-vision` `PoseLandmarker`（body only，不需要 holistic，節省推理成本）
2. 從 `<video>` 每幀抓 frame 送 MediaPipe
3. 輸出 33 個 3D landmark

#### 5b — HybrIK IK solver 移植
1. `hybrik/LandmarkToSmplJoint.ts`：33 → 24 joint 座標映射（平均 / 插值）
2. `hybrik/TwistSwing.ts`：twist-and-swing 分解
3. `hybrik/SolverCore.ts`：
   - 讀 SMPL 骨骼長度常數
   - 對每個 joint 用 HybrIK 論文的 analytical IK 求解 θ
   - 骨骼長度一致性修正
   - 輸出 SmplTrack 格式
4. 單元測試：用 Phase 4 的 EasyMocap 輸出當「參考答案」，比對 HybrIK-TS 結果差異

#### 5c — Clamp 在 SMPL 空間
1. 把 `jointLimits.ts` 擴充 SMPL 版（24 joint 的 axis-angle 限制）
2. HybrIK-TS engine 輸出前套用

#### 5d — 引擎註冊
1. `engines/HybrikTsEngine.ts`：
   - `init()` → 載入 MediaPipe 模型
   - `solveRange()` → 每幀推理 → 每幀 IK 求解 → 組 SmplTrack
   - `requiresSidecar: false`
2. UI 下拉加「HybrIK-TS」選項

**驗收**：同一段影片用兩個引擎分別跑 → 輸出視覺相似（細節可以不同但大方向一致）→ 都能匯出有效 .vrma。

**風險**：高。IK 演算法移植若錯，肉眼看到的就是「VRM 動作詭異」，很難知道是 33→24 映射錯、還是 IK 錯、還是 clamp 錯。緩解：用 EasyMocap 當參考答案逐步 debug。

---

### Phase 6 — Polish

1. 進度條：`sidecar_progress` 事件 → Timeline 上方顯示
2. 取消：`AbortController` 串到底
3. 錯誤訊息：python not found 時顯示「請安裝 Python 3.10+ 並執行 `pip install easymocap-public`」之類提示
4. macOS 煙霧測試：至少 HybrIK-TS 要能跑（EasyMocap 可能要額外 macOS 環境驗證）
5. 效能檢查：記憶體洩漏（開關視窗 10 次）、Three.js scene dispose 正確
6. **評估要不要升級 smplToVrm 到 FK 精細版**（根據 Phase 2–5 的肉眼驗證結果）
7. CLAUDE.md 文件同步、LESSONS.md 補新犯的錯

---

## 7. 測試策略

| 類型 | 範圍 | 工具 |
|---|---|---|
| 單元測試 | smplToVrm / jointLimits / OneEuroFilter / VrmaExporter | Vitest |
| Round-trip | VrmaExporter 多 fixture export → loader load → diff | Vitest + VRMAnimationLoaderPlugin |
| 整合測試 | Engine + pipeline + export 端對端（EasyMocap 需 python） | 手動為主 |
| 肉眼驗證 | 每個 phase 結束時對照真人動作看 VRM 合不合理 | 手動 |
| 跨平台 | Windows 為主，Phase 6 做 macOS 煙霧測試 | 手動 |

---

## 8. 跨平台策略

| 功能 | Windows | macOS |
|---|---|---|
| BrowserWindow 子視窗 | ✅ | ✅ |
| MediaPipe (HybrIK-TS) | ✅ GPU delegate | ✅ 降 CPU fallback |
| Python sidecar (EasyMocap) | ✅ | 🟡 需 `python3` 路徑探測 |
| VRMA exporter | ✅ | ✅ |
| 檔案 picker / save dialog | ✅ | ✅（透過 Electron API，無差異） |

**策略**：
- 視窗參數走 `electron/platform/windowConfig.ts`
- Python sidecar 啟動命令跨平台抽象：`electron/easyMocapSidecar.ts` 內部判斷 `isMac ? 'python3' : 'python'`（`process.platform` 判斷集中在這個檔案內部，視同「平台 API 封裝」）
- 若使用者平台不支援某引擎，下拉選單顯示 disabled 並顯示原因

---

## 9. 風險總表

| 風險 | 等級 | 緩解 |
|---|---|---|
| VRMA exporter 格式錯誤 | 🔴 高 | Phase 3 多 fixture round-trip + 肉眼驗證，投入 1.5 倍時間 |
| SMPL→VRM 座標系錯 | 🟠 中 | Phase 2a 多 fixture 單測；rest/single_joint 必過 |
| Python 環境差異 | 🟠 中 | 使用者自裝 + 友善錯誤訊息 |
| HybrIK IK 數學移植錯 | 🟠 中 | 用 EasyMocap 輸出當參考答案 |
| MediaPipe macOS GPU 不穩 | 🟡 低 | GPU → CPU 自動降級 |
| vite multi-page 打包漏檔 | 🟡 低 | 抄 vrm-picker，electron-builder `files` 檢查 |
| Quaternion filter 精度 | 🟡 低 | Log-map + 歸一化、單測覆蓋 |
| Electron 主程序熱重載 | 🟡 低 | LESSONS.md 2026-04-07 已知，開發流程守紀律 |

---

## 10. 驗收里程碑

- **Milestone A**（Phase 0–1 完成）：托盤開視窗、載影片、選區間。純 UI，無 mocap。
- **Milestone B**（Phase 2–3 完成）：靜態 fixture 完整閉環。可以 export .vrma 並被主視窗載入播放。**這是功能上的第一個「真正 shippable」狀態**——即使沒有引擎，基礎設施已完整。
- **Milestone C**（Phase 4 完成）：EasyMocap 完整流程跑通。**v1 的最小可用版本**。
- **Milestone D**（Phase 5 完成）：HybrIK-TS 第二引擎、使用者可選。**v1 完整版**。
- **Milestone E**（Phase 6 完成）：polish 後 ready-to-release。

---

## 11. 開工前置清單

- [ ] `git pull` 同步遠端
- [ ] 確認 `pnpm build:electron` 目前能過
- [ ] 確認 `pnpm test` 目前全綠
- [ ] 備份 `vite.config.ts`（改 multi-page 前）
- [ ] CLAUDE.md「目前開發狀態」表格預留 v0.4 前的「影片動捕工作站」行

---

## 附錄 A — 關鍵決策紀錄（討論過程）

| 問題 | 決定 | 理由 |
|---|---|---|
| VRMA vs VMD 匯出格式 | 直接 VRMA | 桌寵是 VRM 生態，VMD 對使用者無最終價值 |
| 含表情軌道 | 是 | 對桌寵有實用價值（會說話的動畫） |
| 含 hip 位移軌道 | 是 | 呼應 sit 補償邏輯 |
| UI 框架 | Vanilla TS | 沿用 vrm-picker 架構，降低工具鏈投資 |
| 時間軸策略 | 取向 A 預處理 + 查表 scrub | 使用者體驗好、記憶體成本可接受 |
| 時間軸 in/out | 雙拖曳把手 | 符合影片編輯直覺 |
| 預覽 VRM 來源 | 主視窗 model 快照 | 避免 scrub 過程中換模型 |
| Python sidecar 生命週期 | 懶啟動 + 10min idle kill | 平衡記憶體與啟動延遲 |
| Python 環境 | 使用者自裝 | 打包 portable Python 會超過 150MB 預算 |
| Python 職責 | 只做「影片 → SMPL JSON」 | 最薄 wrapper，可換上游工具 |
| SMPL→VRM rest pose 基準 | 選項 B：runtime 讀取 | 自動吸收 VRM 0.x / 1.0 差異 |
| HybrIK 路徑 | 走 SMPL 中間層 | 與 EasyMocap 共用下游，測一次兩邊好 |
| Clamp / Filter 空間 | SMPL 空間（SMPL 系） | SMPL joint 軸向有論文標準，寫 limits 更穩 |
| SMPL→VRM 缺失 bone | 併入 parent（累乘 quat） | Phase 6 再評估是否升級 FK 版 |
| 引擎 | 移除 Kalidokit，EasyMocap 先、HybrIK-TS 後 | 用 EasyMocap 當 HybrIK-TS 的參考答案 |
| Phase 2 策略 | 靜態 SMPL fixture 解耦引擎與下游 | 降低首個引擎的雙重不確定性 |
| Phase 3 扎實度 | 多 fixture + round-trip 單測 + 肉眼驗證 | VRMA exporter 錯誤會影響所有下游 |
| 托盤選單文字 | 「影片動捕工作站」 | — |
