# 影片動作轉換器 (Video Motion Converter) — 實作計畫

> 目標版本：v0.4 ／ Phase 1 + Phase 2 一次完成
> 對應參考：MiKaPo（階層 quaternion 求解）+ Kalidokit（findRotation / 倍率 / 解剖 clamp）
> 一次輸出兩個檔：`.vad.json`（中繼）+ `.vrma`（VRM Animation）
> 計畫產出日期：2026-04-08

---

## 使用者鎖定的最終決策（含審閱過後的調整）

| 項目 | 決策 |
|---|---|
| 擷取範圍 | 全 VRM humanoid 骨架（~53 bones，**不含 leftToes / rightToes**） |
| Expression BlendShape | **不做**（選項 A），眼睛走 eye bone rotation |
| MediaPipe 模型 | `@mediapipe/tasks-vision` 的 `HolisticLandmarker`（GPU delegate，失敗降 CPU） |
| Solver 流派 | 混合：手臂 / 腿部 = Kalidokit 流派；脊椎 / 髖部 / 頭 = MiKaPo 流派；手指 = Kalidokit Hand.solve 架構；眼睛 = 虹膜相對眼角 |
| 數學工具 | 完全自研於 `src/video-converter/math/`，參考 Kalidokit API 形狀，零新 dependency |
| 處理流程 | 兩階段 capture：Stage 1 即時 1x 擷取；Stage 2 批次 re-pass + offline Gaussian 平滑 |
| 中繼資料格式 | 自訂 `.vad.json` |
| VRMA 匯出 | 方案 2：Three.js `GLTFExporter` + 後處理注入 `VRMC_vrm_animation` extension |
| 輸入來源 | 影片檔（.mp4 / .webm / .mov），MVP 不支援攝影機 |
| 預覽 VRM | 預設載入當前主視窗 VRM，轉換器視窗內可另選 |
| 儲存位置 | `~/.virtual-assistant-desktop/user-vrma/` |
| **BufferToClip 模組位置** | `src/animation/BufferToClip.ts`（避免反向依賴） |
| **Tray 選單** | 新增獨立「使用者動畫 ▸」選單，與系統「動畫 ▸」並列 |
| **Toes bone** | MVP 不處理，實際 ~53 bones |
| AnimationManager 整合 | 新增 `loadFromVadJson()` → 使用者動畫獨立 pool |
| 跨平台 | Win / macOS 兩平台完整支援（MediaPipe WASM 都可用，無 koffi 依賴） |
| 範圍 | Phase 1（MVP）+ Phase 2（手指 + 眼睛 + VRMA 匯出 + offline 平滑 + 設定面板）一次完成 |

---

## 0. 設計總覽

```
[影片檔] ──► <video> ──► HolisticLandmarker (GPU→CPU) ──► landmarks
                                                              │
                                                              ▼
                                                       PoseSolver (orchestrator)
                                                       ├─ BodySolver  (MiKaPo  脊椎/髖/頭階層)
                                                       ├─ BodySolver  (Kalido  四肢倍率+clamp)
                                                       ├─ HandSolver  (1 DOF / 3 DOF 拇指)
                                                       └─ EyeGazeSolver (虹膜→eye bone)
                                                              │
                          ┌───────────────────────────────────┤
                          ▼                                   ▼
                 Stage 1: 即時 (CaptureBuffer)        Stage 2: 批次 + Gaussian
                          │                                   │
                          ▼                                   ▼
              PreviewCharacterScene (右窗格)        BufferToClip → AnimationClip
                          │                                   │
                          ▼                                   ▼
                  使用者預覽 / scrub                   VadJsonWriter + VrmaExporter
                                                              │
                                                              ▼
                                            ~/.virtual-assistant-desktop/user-vrma/
```

獨立 BrowserWindow，從 tray 進入，與主透明視窗完全隔離（同 vrm-picker 模式）。

---

## 1. Spike 階段（實作前必跑的風險驗證）

### Spike A — HolisticLandmarker 在 Electron renderer 的可用性與延遲

**目標問題**：`@mediapipe/tasks-vision` HolisticLandmarker 能否在 Electron Chromium 跑起來？GPU delegate 是否可用？單幀延遲多少？是否能即時跑 30fps（< 33ms）？

**做法**：
1. `pnpm add @mediapipe/tasks-vision`
2. 在現有 vrm-picker 視窗（或一個臨時 spike.html）內 import `HolisticLandmarker`，從 CDN/local 載入 `.task` 模型 + WASM
3. 開一個 `<video>` 載入測試影片，每幀呼叫 `detectForVideo`
4. 用 `performance.now()` 量 4 個值：
   - GPU delegate 初始化是否成功
   - 平均每幀 inference 時間
   - p95 inference 時間
   - 是否回傳 face / left/right hand / pose worldLandmarks
5. CPU delegate 同樣量一遍
6. 在 macOS 與 Windows 各跑一次

**成功準則**：
- GPU delegate 在 Win/macOS 至少一個平台可用
- 中位 inference < 33ms（30fps 即時可行），即使 p95 < 60ms 也算可接受
- 三大 landmark group 都能穩定回傳

**失敗應變**：
- 若 GPU delegate 不可用 → 強制 CPU delegate，FRAME_SKIP=2，Stage 1 預覽降為 15fps
- 若單幀 > 100ms → Stage 1 即時預覽放棄手指（只預覽 body+eye），手指延後到 Stage 2 batch
- 若 HolisticLandmarker 完全跑不動 → fallback 到 PoseLandmarker + HandLandmarker + FaceLandmarker 三個獨立 task

### Spike B — VRMA 匯出 round-trip

**目標問題**：能否用 Three.js `GLTFExporter` 匯出含 humanoid bone hierarchy 的 glb，後處理注入 `VRMC_vrm_animation` extension JSON，再被 `@pixiv/three-vrm-animation` 的 `VRMAnimationLoaderPlugin` 讀回並套到任意 VRM 模型上正常播放？

**做法**：
1. 寫一個 spike 程式：
   - 建一個最小 `THREE.Scene`，只有 humanoid bone 階層（hips → spine → chest → ... → head；左右肩 → 上臂 → 下臂 → 手 → 手指；左右腿 → 膝 → 踝），每根 bone 是 `THREE.Bone`
   - 建一個簡單測試 clip：hip Y 軸週期搖動 + leftUpperArm Z 軸轉動，2 秒
   - `GLTFExporter.parseAsync(scene, { binary: true, animations: [clip] })`
   - 解析回傳的 `ArrayBuffer`：拆出 glb container（magic + version + length + JSON chunk + BIN chunk）
   - 解 JSON chunk → 加 `extensionsUsed: ["VRMC_vrm_animation"]` + `extensions.VRMC_vrm_animation: { specVersion: "1.0", humanoid: { humanBones: { ... } } }`
   - 重新計算 JSON chunk padding（4-byte align），重組 glb
   - 寫入 `spike.vrma`
2. 用既有 VRMController + VRMAnimationLoaderPlugin 載入 `spike.vrma`，套到主模型播放

**成功準則**：
- `spike.vrma` 能被 `VRMAnimationLoaderPlugin` 解析（不丟錯）
- 套到 VRM 模型後手臂與 hip 動起來且方向正確

**失敗應變**：
- 若 GLTFExporter 命名 / node ordering 與 vrma loader 期望不符 → 改寫 mapping 邏輯
- 若 SkinnedMesh 是必須的 → 在 minimal scene 加一個 1 vertex 的 dummy SkinnedMesh
- 若 VRMA 無法產出 → 保留 `.vad.json` 為唯一輸出，匯出 .vrma 推到 v0.5

### Spike C — Renderer 視窗內兩個 Three.js context 共存（左右窗格）

**目標問題**：左窗格的 `<video>` overlay canvas + 右窗格的 VRM Three.js scene 同時運行是否會掉幀？

**做法**：在 spike 視窗一邊放 `<video>` + 2D canvas overlay 畫 skeleton lines、一邊放 Three.js + 載入 VRM 跑 idle，量整體 fps。

**成功準則**：整體 ≥ 30 fps，無 GPU context 衝突。

**失敗應變**：左窗格只用 2D canvas，右窗格獨佔 WebGL（已是預設方案，這個 spike 主要是確認）。

---

## 2. 新檔案清單

### 2.1 入口

#### `video-converter.html`
頂層 HTML，包含 `#vc-toolbar`、`#vc-left`（video + skeleton overlay canvas + 控制條）、`#vc-right`（VRM 預覽 canvas + 模型切換按鈕）、`#vc-timeline`、`#vc-status`、`#vc-settings-panel`。

#### `src/video-converter/main.ts`
- **職責**：DOM bootstrap、初始化 ConverterApp、連接 ipc
- **公開介面**：`async function bootstrap(): Promise<void>`
- **依賴**：`ConverterApp`, `bridge/ElectronIPC`

#### `src/video-converter/ConverterApp.ts`
- **職責**：整個轉換器的應用級 orchestrator。管理三階段狀態（Load / Process / Preview），協調 VideoSource / MediaPipeRunner / PoseSolver / CaptureBuffer / PreviewCharacterScene / UI 之間的事件流
- **公開介面**：
  ```ts
  class ConverterApp {
    constructor(roots: { left: HTMLElement; right: HTMLElement; toolbar: HTMLElement; timeline: HTMLElement });
    async init(): Promise<void>;
    async loadVideo(filePath: string): Promise<void>;
    async loadVrm(vrmPath: string): Promise<void>;
    async startStage1(): Promise<void>;        // 即時擷取
    async stopStage1(): Promise<void>;
    async runStage2AndExport(name: string): Promise<{ vadPath: string; vrmaPath: string }>;
    dispose(): void;
  }
  type AppPhase = 'load' | 'processing' | 'preview';
  ```

### 2.2 video/

#### `src/video-converter/video/VideoSource.ts`
- **職責**：封裝 `<video>` 元素的載入、播放、暫停、seek、currentTime / duration / fps 推算（透過 `HTMLVideoElement.requestVideoFrameCallback`）。提供「逐幀回呼」與「seek 並等待」兩種模式（Stage 1 用前者，Stage 2 用後者）
- **公開介面**：
  ```ts
  class VideoSource {
    constructor(videoEl: HTMLVideoElement);
    async loadFile(path: string): Promise<void>;
    play(): void; pause(): void;
    get duration(): number; get currentTime(): number;
    get nominalFps(): number;
    onFrame(cb: (now: number, metadata: VideoFrameCallbackMetadata) => void): () => void;
    async seekTo(t: number): Promise<void>;
    dispose(): void;
  }
  ```

#### `src/video-converter/video/SkeletonOverlay.ts`
- **職責**：在覆蓋於 `<video>` 上的 2D canvas 上畫 MediaPipe POSE_CONNECTIONS / HAND_CONNECTIONS / FACE landmarks，視覺驗證偵測結果
- **公開介面**：
  ```ts
  class SkeletonOverlay {
    constructor(canvas: HTMLCanvasElement, video: HTMLVideoElement);
    draw(result: HolisticResult): void;
    clear(): void;
    resize(): void;
  }
  ```

### 2.3 tracking/

#### `src/video-converter/tracking/MediaPipeRunner.ts`
- **職責**：封裝 `HolisticLandmarker` 的初始化（GPU→CPU 降級）、`detectForVideo` 呼叫、結果序列化
- **公開介面**：
  ```ts
  class MediaPipeRunner {
    async init(opts?: { preferGpu?: boolean }): Promise<void>;
    get delegate(): 'GPU' | 'CPU';
    detect(video: HTMLVideoElement, timestampMs: number): HolisticResult;
    dispose(): void;
  }
  interface HolisticResult {
    poseLandmarks: Landmark[];
    poseWorldLandmarks: Landmark[];
    leftHandLandmarks: Landmark[];
    rightHandLandmarks: Landmark[];
    faceLandmarks: Landmark[];
    timestampMs: number;
  }
  ```

#### `src/video-converter/tracking/landmarkTypes.ts`
型別定義：`Landmark { x; y; z; visibility? }`、index enums。

#### `src/video-converter/tracking/boneMapping.ts`
- **職責**：定義 VRM humanoid bone 與 MediaPipe landmark 的對應，以及每根骨骼的 A-Pose reference direction（MiKaPo 流派必須）
- **公開介面**：
  ```ts
  const VRM_BONE_PARENT_CHAIN: Record<VRMHumanoidBoneName, VRMHumanoidBoneName[]>;
  const A_POSE_REFERENCE_DIR: Record<VRMHumanoidBoneName, Vec3>;
  const FINGER_CHAINS: { side: 'left' | 'right'; finger: 'thumb'|'index'|'middle'|'ring'|'little'; bones: VRMHumanoidBoneName[]; landmarkIndices: number[] }[];
  ```
- **注意**：不含 `leftToes` / `rightToes`（MVP 不處理）

### 2.4 math/（自研，零新依賴）

#### `src/video-converter/math/Vector.ts`
```ts
type Vec3 = { x: number; y: number; z: number };
function v3(x,y,z): Vec3;
function add/sub/scale/dot/cross/length/normalize/distance/lerpV;
function findRotation(from:Vec3, to:Vec3): Quat;
function rollPitchYaw(a,b,c): { roll; pitch; yaw };
function angleBetween3DCoords(a,b,c): number;
```

#### `src/video-converter/math/Euler.ts`
```ts
type EulerOrder = 'XYZ'|'YZX'|'ZXY'|'XZY'|'YXZ'|'ZYX';
function eulerToQuat(x,y,z,order='XYZ'): Quat;
function quatToEuler(q, order='XYZ'): {x,y,z};
```

#### `src/video-converter/math/Quat.ts`
```ts
type Quat = { x; y; z; w };
function quatIdentity/quatMul/quatConj/quatNormalize/quatSlerp;
function quatFromAxisAngle/quatFromUnitVectors/quatRotateVec/quatDot;
function quatEnsureShortestPath(prev, curr): Quat;  // 若 dot<0 翻號
```

#### `src/video-converter/math/helpers.ts`
`clamp`, `lerp`, `remap`, `degToRad`, `radToDeg`, `gaussianWeight(distance, sigma)`

### 2.5 solver/

#### `src/video-converter/solver/PoseSolver.ts` (orchestrator)
```ts
class PoseSolver {
  constructor(opts: { enableHands: boolean; enableEyes: boolean });
  solve(result: HolisticResult): SolvedPose;
}
interface SolvedPose {
  hipsTranslation: Vec3 | null;
  boneRotations: Partial<Record<VRMHumanoidBoneName, Quat>>;
}
```

#### `src/video-converter/solver/BodySolver.ts`
混合流派核心。
```ts
class BodySolver {
  solveSpineHierarchical(world: Landmark[]): { hips; spine; chest; upperChest; neck; head };
  solveArms(world, parentChain): { LUA; LLA; LH; RUA; RLA; RH };
  solveLegs(world, parentChain): { LUL; LLL; LF; RUL; RLL; RF };  // 不含 Toes
  solveHipsTranslation(world): Vec3;
}
```

#### `src/video-converter/solver/HandSolver.ts`
```ts
class HandSolver {
  solveHand(handLm: Landmark[], side: 'left'|'right'): Partial<Record<VRMHumanoidBoneName, Quat>>;
}
```

#### `src/video-converter/solver/EyeGazeSolver.ts`
```ts
class EyeGazeSolver {
  solve(faceLm: Landmark[]): { leftEye: Quat | null; rightEye: Quat | null };
}
```

### 2.6 filters/

#### `src/video-converter/filters/OneEuroFilter.ts`
```ts
class OneEuroFilterScalar {
  constructor(opts: { minCutoff; beta; dCutoff });
  filter(value, timestampMs): number;
  reset(): void;
}
class OneEuroFilterQuat {
  filter(q: Quat, timestampMs): Quat;
  reset(): void;
}
```

#### `src/video-converter/filters/GaussianQuatSmoother.ts`
Stage 2 離線 ±N 幀 quaternion-safe Gaussian 平滑。
```ts
class GaussianQuatSmoother {
  constructor(opts: { halfWindow; sigma });
  smoothTrack(track: Quat[]): Quat[];
}
```
**重點**：對 window 中心點，從中心向外逐一 slerp 累加，權重為 normalized gaussian。**禁止對 xyzw 分量加權平均**。

### 2.7 capture/

#### `src/video-converter/capture/types.ts`
```ts
interface CaptureFrame {
  timestampMs: number;
  hipsTranslation: Vec3 | null;
  boneRotations: Partial<Record<VRMHumanoidBoneName, Quat>>;
}
interface CaptureBufferData {
  fps: number;
  duration: number;
  frames: CaptureFrame[];
}
```

#### `src/video-converter/capture/CaptureBuffer.ts`
```ts
class CaptureBuffer {
  push(frame: CaptureFrame): void;
  clear(): void;
  get frames(): readonly CaptureFrame[];
  sampleAt(t: number): CaptureFrame | null;
  finalize(fps: number): CaptureBufferData;
}
```

### 2.8 export/

#### `src/video-converter/export/VadJsonWriter.ts`
`async function writeVad(filePath: string, data: CaptureBufferData): Promise<void>`

#### `src/video-converter/export/VadJsonReader.ts`
`async function readVad(filePath: string): Promise<CaptureBufferData>`

#### `src/video-converter/export/VrmaExporter.ts`
```ts
class VrmaExporter {
  async export(clip: THREE.AnimationClip, opts?: { specVersion?: string }): Promise<ArrayBuffer>;
}
```
內部 helper：`buildMinimalHumanoidScene()` / `parseGlbContainer` / `repackGlbContainer` / `injectVrmAnimationExtension`

### 2.9 preview/

#### `src/video-converter/preview/PreviewCharacterScene.ts`
```ts
class PreviewCharacterScene {
  constructor(canvas: HTMLCanvasElement);
  async loadVrm(path: string): Promise<void>;
  applyPose(pose: SolvedPose, smoothingDamping?: number): void;
  applyBufferFrame(frame: CaptureFrame): void;
  start(): void; stop(): void; dispose(): void;
}
```

#### `src/video-converter/preview/VrmSwitcher.ts`
```ts
class VrmSwitcher {
  constructor(host: HTMLElement, onChange: (path: string) => void);
  async refresh(): Promise<void>;
  setActive(path: string): void;
}
```

### 2.10 ui/

- `src/video-converter/ui/Toolbar.ts` — 頂部工具列
- `src/video-converter/ui/Timeline.ts` — 底部時間軸 + scrub
- `src/video-converter/ui/SettingsPanel.ts` — 右側面板（手指開關 / Gaussian sigma / Stage 2 fps）

### 2.11 電子側

#### `electron/videoConverterWindow.ts`
開啟 / 聚焦 / 關閉影片轉換器 BrowserWindow（複製 vrmPickerWindow.ts 模式）。

### 2.12 共用模組（依 Q1 決策）

#### `src/animation/BufferToClip.ts` ⭐ 放在 animation/ 而非 video-converter/
```ts
function bufferToClip(data: CaptureBufferData, clipName: string): THREE.AnimationClip;
```
避免 `AnimationManager` 反向依賴 `video-converter/`，由 video-converter 反過來 import 它。

---

## 3. 修改既有檔案的清單

### `electron/platform/windowConfig.ts`
新增 `getVideoConverterWindowOptions(parent)`：1280×800、minWidth 1024、minHeight 720、frame: true、autoHideMenuBar: true、backgroundColor `#1e1e2e`、parent、modal: false、title `'影片動作轉換器'`

### `electron/main.ts`
註冊 video-converter local-file protocol（既有共用）；setup 階段 import `videoConverterWindow.ts`

### `electron/ipcHandlers.ts`
新增以下 handlers（見第 4 節），實作分離到 `electron/videoConverterIO.ts`

### `electron/preload.ts`
新增對應 contextBridge 條目

### `src/bridge/ElectronIPC.ts`
新增 typed 包裝方法

### `electron/systemTray.ts`
- 新增選單項「影片動作轉換器」
- 新增**獨立「使用者動畫 ▶」子選單**（依 Q2 決策），與系統「動畫 ▶」並列

### `electron/fileManager.ts`
新增：
- `getUserVrmaDir(): string`
- `ensureUserVrmaDir(): Promise<void>`
- `listUserVrmas(): Promise<{ vadPath; vrmaPath; createdAt }[]>`
- `writeUserVrma(name, vadJson, vrmaBuffer): Promise<{ vadPath, vrmaPath }>`

### `src/main.ts`（主視窗）
- 監聽 tray action `open_video_converter`
- 監聽 tray action `play_user_vrma::<filename>`

### `src/animation/AnimationManager.ts`
新增方法：
```ts
async loadFromVadJson(filePath: string): Promise<THREE.AnimationClip | null>;
async setUserClip(clip: THREE.AnimationClip): Promise<void>;
playUserClip(): void;
stopUserClip(): void;
```
內部呼叫新的 `src/animation/BufferToClip.ts`。

### `src/types/animation.ts`
新增 `UserAnimationSource` 型別與 `vadFilePath` 欄位。

### `src/types/tray.ts`
- `userAnimations: { name; vadPath }[]` 欄位
- Tray action prefix `play_user_vrma::`

### `vite.config.ts`
```ts
input: {
  main: resolve(__dirname, 'index.html'),
  vrmPicker: resolve(__dirname, 'vrm-picker.html'),
  videoConverter: resolve(__dirname, 'video-converter.html'),  // 新增
}
```

### `package.json`
新增 dependency：`@mediapipe/tasks-vision`

---

## 4. IPC 介面列表

| 名稱 | 方向 | 參數 | 回傳 | 用途 |
|---|---|---|---|---|
| `open_video_converter` | renderer→main | — | `void` | 開啟轉換器視窗 |
| `pick_video_file` | renderer→main | — | `string \| null` | 開檔對話框 |
| `read_video_as_url` | renderer→main | `filePath` | `string` | 回傳 local-file:// URL |
| `list_user_vrmas` | renderer→main | — | `UserVrmaEntry[]` | 列出 user-vrma/ 所有配對 |
| `write_user_vrma` | renderer→main | `{name, vadJson, vrmaBuffer}` | `{vadPath, vrmaPath}` | 寫入 user-vrma/ |
| `read_user_vad` | renderer→main | `filePath` | `string` (JSON) | 主視窗 AnimationManager 讀回 |
| `delete_user_vrma` | renderer→main | `vadPath` | `boolean` | 刪除一組 |
| `get_user_vrma_dir` | renderer→main | — | `string` | 顯示輸出位置 |
| `notify_user_animations_changed` | main→renderer | `entries: UserVrmaEntry[]` | — | tray 選單刷新 |

全部走 ipcMain.handle / preload contextBridge / ElectronIPC.ts 三層同步。

---

## 5. 關鍵演算法偽碼

### 5.1 BodySolver.solveSpineHierarchical（MiKaPo 流派）

```
INPUT  poseWorldLandmarks
OUTPUT { hips, spine, chest, upperChest, neck, head }

// 1. hips quaternion (root)
hipMid      = midpoint(world[LH], world[RH])
shoulderMid = midpoint(world[LS], world[RS])
hipRight    = normalize(world[RH] - world[LH])
torsoUp     = normalize(shoulderMid - hipMid)
hipForward  = normalize(cross(hipRight, torsoUp))
hipsWorldQ  = matrixToQuat([hipRight, torsoUp, hipForward])
hips        = hipsWorldQ

// 2. spine
worldDir = normalize(shoulderMid - hipMid)
localDir = quatRotateVec(quatConj(hipsWorldQ), worldDir)
spine    = quatFromUnitVectors(REF_DIR.spine, localDir)

// 3. chest / upperChest
ancestorQ = quatMul(hipsWorldQ, spine)
...

// 4. neck / head
ancestorQ_neck = quatMul(ancestorQ, upperChest)
neckWorldDir   = normalize(world[NOSE] - shoulderMid)
neck = quatFromUnitVectors(REF_DIR.neck, quatRotateVec(quatConj(ancestorQ_neck), neckWorldDir))

ancestorQ_head = quatMul(ancestorQ_neck, neck)
earMid = midpoint(world[LEFT_EAR], world[RIGHT_EAR])
headWorldDir = normalize(earMid - world[NOSE])
head = quatFromUnitVectors(REF_DIR.head, quatRotateVec(quatConj(ancestorQ_head), headWorldDir))
```

### 5.2 BodySolver.solveArms（Kalidokit 流派，必須經祖先鏈）

```
FOR side in [LEFT, RIGHT]:
  shoulder = world[SHOULDER]
  elbow    = world[ELBOW]
  wrist    = world[WRIST]

  // 1. UpperArm raw rotation
  worldDir_upper = normalize(elbow - shoulder)
  ancestorQ      = parentChain[chest]          // ⚠️ 必須反轉祖先鏈
  localDir       = quatRotateVec(quatConj(ancestorQ), worldDir_upper)
  upperArmRaw    = quatFromUnitVectors(REF_DIR[`${side}UpperArm`], localDir)

  // 2. 套 Kalidokit 倍率 + clamp
  euler = quatToEuler(upperArmRaw, 'XYZ')
  invert = (side === LEFT) ? -1 : 1
  euler.z *= -2.3 * invert
  euler.x = clamp(euler.x, -0.5, π)
  euler.y = clamp(euler.y, -π/2, π/2)

  // 3. LowerArm：1 DOF Z 軸
  bendAngle = angleBetween3DCoords(shoulder, elbow, wrist)
  lowerArmZ = -(π - bendAngle)
  lowerArmZ = clamp(lowerArmZ, -2.14, 0)
  lowerArmEuler = { x:0, y:0, z: lowerArmZ * invert }

  // 4. 生物耦合
  upperArmEuler.y += lowerArmEuler.x * 0.5

  // 5. Wrist：同樣反轉祖先鏈
  ...
```

### 5.3 HandSolver.solveFinger（四指 1 DOF）

```
FOR each finger [index, middle, ring, little]:
  FOR each segment k in [0,1,2]:
    prev = (k === 0) ? handLm[0] : handLm[fingerIndices[k-1]]
    curr = handLm[fingerIndices[k]]
    next = handLm[fingerIndices[k+1]]
    bend = angleBetween3DCoords(prev, curr, next)  // π = 直
    zRot = -(π - bend)
    zRot = clamp(zRot, -π/2, 0)
    invert = (side === 'left') ? -1 : 1
    rotations[fingerBone[k]] = eulerToQuat(0, 0, zRot * invert, 'XYZ')

// 大拇指：3 DOF，每節 findRotation(prev→curr)，套 dampener + startPos
```

### 5.4 EyeGazeSolver.solve

```
eyeCenter = midpoint(EYE_INNER, EYE_OUTER)
eyeWidth  = distance(EYE_INNER, EYE_OUTER)
eyeHeight = distance(EYE_TOP, EYE_BOT)

irisOffset.x = (IRIS.x - eyeCenter.x) / (eyeWidth * 0.5)
irisOffset.y = (IRIS.y - eyeCenter.y) / (eyeHeight * 0.5)
irisOffset = clamp([-1, 1])

yaw   = irisOffset.x * (π / 6)   // ±30°
pitch = irisOffset.y * (π / 9)   // ±20°
eyeQuat = eulerToQuat(pitch, yaw, 0, 'XYZ')
```

### 5.5 GaussianQuatSmoother.smoothTrack（quaternion-safe）

```
PRECOMPUTE weights[k] = exp(-k*k / (2*σ*σ))

FOR i in [0..N):
  center = track[i]
  acc    = center
  accW   = weights[0]
  FOR k in [1..H]:
    leftIdx  = max(0, i - k)
    rightIdx = min(N-1, i + k)
    leftQ    = quatEnsureShortestPath(center, track[leftIdx])
    rightQ   = quatEnsureShortestPath(center, track[rightIdx])
    w = weights[k]
    accW += w; acc = quatSlerp(acc, leftQ,  w / accW)
    accW += w; acc = quatSlerp(acc, rightQ, w / accW)
  smoothed[i] = quatNormalize(acc)
```
**原理**：任何時刻 acc 都是合法單位 quaternion；每次新增樣本用 `w / (accW + w)` 作為 slerp t，等同「累積平均往新樣本拉」。

### 5.6 VrmaExporter.export（方案 2）

```
// 1. 建 minimal humanoid bone hierarchy
scene = new THREE.Scene()
FOR each VRMHumanoidBoneName b (不含 toes):
  bone = new THREE.Bone()
  bone.name = b
  nodes[b] = bone
// 連 parent chain
scene.add(nodes.hips)

// 2. clip track 名稱必須為 "<boneName>.quaternion" / "hips.position"
//    BufferToClip 已保證格式

// 3. GLTFExporter 產出 glb
glb = await exporter.parseAsync(scene, {
  binary: true,
  animations: [clip],
  trs: true,
})

// 4. 拆解 glb
{ header, jsonChunk, binChunk } = parseGlbContainer(glb)
gltf = JSON.parse(textDecode(jsonChunk))

// 5. 建 boneName → node index map
boneNodeMap = {}
FOR i, node in gltf.nodes:
  if node.name in VRM_HUMANOID_NAMES:
    boneNodeMap[node.name] = i

// 6. 注入 extension
gltf.extensionsUsed = (gltf.extensionsUsed || []).concat(['VRMC_vrm_animation'])
gltf.extensions = gltf.extensions || {}
gltf.extensions.VRMC_vrm_animation = {
  specVersion: '1.0',
  humanoid: { humanBones: {} }
}
FOR boneName, idx in boneNodeMap:
  gltf.extensions.VRMC_vrm_animation.humanoid.humanBones[boneName] = { node: idx }

// 7. 重新打包 glb（注意 padding 4-byte align + 0x20 空白）
newJsonBytes = textEncode(JSON.stringify(gltf))
padJson = padTo4(newJsonBytes, 0x20)
totalLen = 12 + 8 + padJson.length + 8 + binChunk.length
header = writeGlbHeader(totalLen)
return concat(header, JSON chunk, BIN chunk)
```

---

## 6. Vitest 單元測試覆蓋清單

| 測試檔 | 測試案例 |
|---|---|
| `tests/unit/video-converter/math/Vector.test.ts` | findRotation Z90°;  angleBetween3DCoords 直線 π / 垂直 π/2；rollPitchYaw 水平面；邊界 |
| `tests/unit/video-converter/math/Quat.test.ts` | quatMul(I,a)=a；quatFromUnitVectors round-trip；slerp t=0/0.5/1；quatEnsureShortestPath 翻號；rotateVec 與 matrix 一致 |
| `tests/unit/video-converter/math/Euler.test.ts` | XYZ / ZYX round-trip（非 gimbal 區誤差 < 1e-6） |
| `tests/unit/video-converter/solver/BodySolver.test.ts` | (1) A-Pose → identity; (2) T-pose 左手平舉 → upperArm Z ≈ ±π/2; (3) hips translation; (4) 頭右看 → Y 正; (5) **父鏈非 identity 時的 arms 測試** |
| `tests/unit/video-converter/solver/HandSolver.test.ts` | 攤平=0；拳頭≈-π/2；V字手勢；左右鏡像對稱 |
| `tests/unit/video-converter/solver/EyeGazeSolver.test.ts` | 直視 / 右看 / 上看 |
| `tests/unit/video-converter/filters/OneEuroFilter.test.ts` | 常數 / 高頻方波 / 緩慢漸變 |
| `tests/unit/video-converter/filters/GaussianQuatSmoother.test.ts` | 全 identity / 尖刺 90° / 線性漸變 / **與分量加權平均差異顯著** |
| `tests/unit/video-converter/capture/CaptureBuffer.test.ts` | sampleAt 線性插值；finalize fps |
| `tests/unit/animation/BufferToClip.test.ts` | clip duration / track 數 / hips VectorKeyframeTrack |
| `tests/unit/video-converter/export/VadJsonRoundTrip.test.ts` | write→read 完全相同 |
| `tests/unit/video-converter/export/VrmaGlbContainer.test.ts` | parseGlb / repackGlb round-trip；JSON chunk padding；header length |
| `tests/unit/video-converter/tracking/boneMapping.test.ts` | 每根 bone 有 reference dir；parent chain 正確；**不含 leftToes / rightToes** |

---

## 7. Commit / Phase 切分

### Phase 0 — Spike（Commit 1）
- **目標**：驗證 HolisticLandmarker 與 VRMA round-trip
- **新增**：`scripts/spike-mediapipe.ts`, `scripts/spike-vrma-export.ts`
- **驗收**：得到 delegate 結論 + 延遲數據；spike.vrma 可被 loader 載入並播放
- **Commit**：`chore(video-converter): spike mediapipe holistic + vrma round-trip`

### Phase 1 — 視窗骨架（Commit 2）
- **目標**：從 tray 開出空白影片轉換器視窗
- **新增**：`video-converter.html`, `src/video-converter/main.ts`, `electron/videoConverterWindow.ts`
- **修改**：`vite.config.ts`, `platform/windowConfig.ts`, `electron/main.ts`, IPC 三層新增 `open_video_converter`, `systemTray.ts`
- **驗收**：tray → 影片動作轉換器 → 開出 1280×800 視窗
- **Commit**：`feat(video-converter): scaffold standalone window with tray entry`

### Phase 2 — 數學工具 + 測試（Commit 3）
- **新增**：`math/{Vector,Quat,Euler,helpers}.ts` + 5 個測試檔
- **驗收**：`pnpm test` 全綠
- **Commit**：`feat(video-converter): add zero-dependency math utilities`

### Phase 3 — Bone mapping + Landmark types（Commit 4）
- **新增**：`tracking/landmarkTypes.ts`, `tracking/boneMapping.ts` + 測試
- **Commit**：`feat(video-converter): define VRM bone mapping and A-pose reference dirs`

### Phase 4 — Solver 全套 + 測試（Commit 5）
- **新增**：`solver/{BodySolver,HandSolver,EyeGazeSolver,PoseSolver}.ts` + 測試
- **Commit**：`feat(video-converter): implement hybrid pose/hand/eye solvers`

### Phase 5 — Filter 模組 + 測試（Commit 6）
- **新增**：`filters/{OneEuroFilter,GaussianQuatSmoother}.ts` + 測試
- **Commit**：`feat(video-converter): add One Euro filter and quaternion-safe Gaussian smoother`

### Phase 6 — Capture buffer + Clip 轉換（Commit 7）
- **新增**：`video-converter/capture/{types,CaptureBuffer}.ts`、**`src/animation/BufferToClip.ts`**（依 Q1） + 測試
- **Commit**：`feat(animation): shared BufferToClip + video-converter capture buffer`

### Phase 7 — MediaPipe Runner（Commit 8）
- **新增**：`tracking/MediaPipeRunner.ts`
- **修改**：`package.json` 加 `@mediapipe/tasks-vision`
- **驗收**：轉換器視窗載入 spike 影片 → console log landmarks
- **Commit**：`feat(video-converter): integrate MediaPipe HolisticLandmarker`

### Phase 8 — 左窗格 video + skeleton overlay（Commit 9）
- **新增**：`video/{VideoSource,SkeletonOverlay}.ts`, `ui/Toolbar.ts`
- **修改**：IPC `pick_video_file`, `read_video_as_url`
- **驗收**：選影片 → 左窗格播放 + skeleton 繪製
- **Commit**：`feat(video-converter): video source + skeleton overlay in left pane`

### Phase 9 — 右窗格 VRM 預覽（Commit 10）
- **新增**：`preview/{PreviewCharacterScene,VrmSwitcher}.ts`
- **驗收**：右窗格載入當前 VRM，可切換其他 .vrm
- **Commit**：`feat(video-converter): VRM preview pane with model switcher`

### Phase 10 — Stage 1 即時 capture pipeline（Commit 11）
- **新增**：`ConverterApp.ts` 串接完整 Stage 1 pipeline
- **驗收**：影片播放時，右窗格 VRM 同步動作（body + eye），左窗格 skeleton；停止後 buffer 有 frames
- **Commit**：`feat(video-converter): stage 1 realtime capture pipeline`

### Phase 11 — Timeline + scrub + Stage 2 batch（Commit 12）
- **新增**：`ui/Timeline.ts`
- **修改**：`ConverterApp.runStage2` 用 `seekTo` 逐幀重抽 + GaussianQuatSmoother
- **驗收**：Stage 1 結束後可 scrub；按「高品質處理」進度 100% 後重 preview 平滑結果
- **Commit**：`feat(video-converter): stage 2 offline reprocess with gaussian smoothing`

### Phase 12 — VadJson 寫入 + 主視窗 loader（Commit 13）
- **新增**：`export/{VadJsonWriter,VadJsonReader}.ts` + round-trip 測試
- **修改**：`fileManager.ts`（user-vrma 目錄）、IPC 三層、`AnimationManager.loadFromVadJson`、`src/main.ts` tray action、**systemTray 新增獨立「使用者動畫 ▶」選單**（依 Q2）
- **驗收**：匯出 .vad.json → 主視窗 tray「使用者動畫 ▶」出現 → 點選播放
- **Commit**：`feat(video-converter): persist .vad.json and integrate with main window`

### Phase 13 — VRMA 匯出（Commit 14）
- **新增**：`export/VrmaExporter.ts` + glb container 測試
- **修改**：`ConverterApp.runStage2AndExport` 額外輸出 .vrma
- **驗收**：產出 .vrma 能被 VRMAnimationLoaderPlugin 載入並套到任意 VRM
- **Commit**：`feat(video-converter): export .vrma via GLTFExporter + VRMC_vrm_animation injection`

### Phase 14 — Settings panel + UI polish（Commit 15）
- **新增**：`ui/SettingsPanel.ts`
- **驗收**：開關手指/眼睛/Stage 2 sigma 生效；錯誤訊息顯示
- **Commit**：`feat(video-converter): settings panel and UI polish`

### Phase 15 — 文件同步（Commit 16）
- **修改**：CLAUDE.md / SPEC.md / ARCHITECTURE.md / LESSONS.md / 新增 `video-converter-guide.md`
- **Commit**：`docs: sync documentation for video motion converter feature`

---

## 8. 風險與 Open Questions

### 風險
1. **HolisticLandmarker 手指漂移**：身體動作快時手指 landmarks 不穩。HandSolver 加 visibility 門檻（< 0.5 保留上一幀，通知 OneEuroFilter 不納入）
2. **eye bone 缺失**：許多 VRM 模型沒有 leftEye/rightEye。`PreviewCharacterScene.applyPose` 須檢查 `humanoid.getNormalizedBoneNode('leftEye')`，缺失時靜默跳過
3. **GLTFExporter target node 命名**：可能自動加 suffix。在建 scene 時手動設 `node.extras.originalBoneName`，反查用
4. **glb JSON chunk padding**：4-byte align，補 `0x20`（空白），bin chunk 補 `0x00`。length field uint32 little-endian
5. **VRMAnimationLoaderPlugin spec 嚴格度**：可能要求 `humanoid.humanBones.hips` 存在；spec version "1.0"。Spike B 必須驗證
6. **Renderer GPU 記憶體**：兩個 WebGL context + MediaPipe GPU delegate 可能 OOM。Spike C 驗證
7. **HolisticLandmarker 啟動時間**：首次 task + WASM 編譯 5–15 秒，UI 須顯示「初始化中…」
8. **跨平台 model 路徑**：`.task` 檔的載入路徑 dev / packaged 不同，走 local-file 協定或 bundled in `assets/mediapipe/`

### Open Questions
1. 手指即時預覽門檻由 spike 決定，預設 OFF
2. A-Pose reference direction 精準值：先用 MiKaPo 的數值，實測偏差大時用當前 VRM rest pose 反推
3. Stage 2 重抽 fps：先固定 30fps
4. 使用者動畫播放時是否暫停 idle 輪播？暫定覆蓋 → 播完回 idle（同 user action）

---

## 9. 跨平台驗證清單

### Windows 10/11
- [ ] HolisticLandmarker GPU delegate 初始化成功
- [ ] 單幀 inference < 50ms
- [ ] 視窗開啟 / 拖動 / 關閉
- [ ] 開檔對話框
- [ ] local-file:// 載入 .mp4（注意反斜線轉換）
- [ ] 右窗格 VRM 載入
- [ ] 匯出落地到 `C:\Users\...\.virtual-assistant-desktop\user-vrma\`
- [ ] 主視窗 tray「使用者動畫 ▶」出現並可播放
- [ ] WASM + .task 載入（dev 與 packaged）

### macOS 11+
- [ ] HolisticLandmarker GPU delegate（Metal / WebGPU）或 fallback CPU
- [ ] 視窗 frame 顯示正確
- [ ] NSOpenPanel 正常
- [ ] local-file:// 路徑（`/Users/...`）正確
- [ ] `~/.virtual-assistant-desktop/user-vrma/` 權限正常
- [ ] 無 koffi 依賴

### 共通
- [ ] dev 模式：改 electron/ 後 build:electron + 重啟
- [ ] packaged 模式：electron-builder 後 MediaPipe assets 正確 bundled

---

## 10. 文件同步清單

| 文件 | 更新內容 |
|---|---|
| `CLAUDE.md` | 目錄結構加 `src/video-converter/`；版本表 v0.4；tray 選單加「影片動作轉換器」+「使用者動畫 ▶」 |
| `SPEC.md` | 新增「6.x 影片動作轉換器」章節 |
| `ARCHITECTURE.md` | 新增「Video Converter Module」段落 |
| `LESSONS.md` | 實作教訓累積 |
| `animation-guide.md` | 使用者動畫是獨立 pool，不進系統 statePool |
| 新增 `video-converter-guide.md` | 操作手冊 |

---

## 11. 執行順序建議（時間壓力下的 demo 路徑）

若要最快拿到可演示版本：
1. Phase 0 Spike A（必做）
2. Phase 1（視窗骨架）
3. Phase 2（math）
4. Phase 3（bone mapping）
5. Phase 4（**僅 BodySolver**，跳過 Hand/Eye）
6. Phase 7（MediaPipe Runner）
7. Phase 8（左窗格）
8. Phase 9（右窗格）
9. Phase 10（Stage 1 pipeline）

→ **「載入影片 → 桌寵跟著動」demo**，約 50% 工作量。

接著：
10. Phase 5 + Phase 6（filter + buffer）
11. Phase 12（存檔 + 主視窗整合）
12. Spike B + Phase 13（VRMA 匯出）
13. Phase 4 補完 Hand/Eye + Phase 11 Stage 2
14. Phase 14 + 15

若 Spike B 失敗，`.vad.json` 是足夠的最低保證。

---

## 12. 設計遺漏 / 矛盾檢查（Plan agent 發現）

1. **VRM 無 eye bone 時的警示**：`PreviewCharacterScene` 載入新 VRM 時 log `[VC] this VRM has eye bones: yes/no`，SettingsPanel 顯示警示
2. **Kalidokit 流派必須經祖先鏈反轉**：四肢 solver 若忘記先用 chest 累積祖先鏈反矩陣，方向會錯。單元測試要涵蓋「父鏈非 identity」case
3. **Stage 2 不應使用 OneEuroFilter**：只走 GaussianQuatSmoother，避免 Stage 1 filter state 污染
4. **filter 與 slerp 順序**：OneEuroFilter 先（raw 去抖）→ CaptureBuffer 寫入 → applyPose 時 slerp(0.3)。CaptureBuffer 存「filtered but not slerped」
5. **BufferToClip 位置**：`src/animation/BufferToClip.ts`（依 Q1 決策）
6. **Toes bone**：MVP 不做（依 Q3 決策）
7. **使用者動畫 tray 位置**：獨立「使用者動畫 ▶」選單（依 Q2 決策）

---

## 13. 關鍵檔案路徑索引

- `electron/vrmPickerWindow.ts` — 第二視窗範本
- `electron/platform/windowConfig.ts` — 新增 getVideoConverterWindowOptions
- `electron/ipcHandlers.ts` — 新增多個 IPC handler
- `electron/preload.ts` / `src/bridge/ElectronIPC.ts` — 三層同步
- `electron/fileManager.ts` — user-vrma 目錄管理
- `electron/systemTray.ts` — 新增選單項與使用者動畫子選單
- `src/animation/AnimationManager.ts` — 新增 loadFromVadJson
- `src/vrm-picker/main.ts` / `PreviewScene.ts` — 獨立 renderer 範本
- `src/core/VRMController.ts` — hip 平滑與 SpringBone reset 參考
- `vite.config.ts` — 新增第三個 entry
- `MIKAPO.md` / `KALIDOKIT.md` — 演算法理論依據
- `LESSONS.md` — 特別注意「dist-electron 重編譯」「IPC 三層同步」「DPI 座標」三條

---

## 14. 已知問題與待校正項（Phase 10+ 實作中累積）

以下項目在對應 phase 先標記、延後處理，集中留給 Phase 14 / Phase 15
或獨立的校正輪次。

### 動作捕捉品質
- **姿勢校正未臻完美**：Phase 10.5 已用 VRM bind pose 反推校正 REF_DIR
  並修正 hips Y180 composition，軀幹 / 四肢大方向正確，但仍可能存在：
  - Kalidokit 倍率（plan 第 5.2 節 `euler.z *= -2.3`）未套用
  - 四肢 Euler clamp 範圍未套用
  - 解剖合理性耦合（`upperArmEuler.y += lowerArmEuler.x * 0.5`）未套用
- **head bone 暫時 skip**：ear-nose 追蹤在側面視角會退化，head 沒有 child
  可供 calibrateRefDirs。PreviewCharacterScene.SKIP_BONES 先排除，
  Phase 14+ 用 rigid body 三點基底重做（可直接從 earMid + nose 建 basis
  並用 quatFromMat3）
- **shoulder bone 固定 identity**：沒有對應 landmark，聳肩 / 肩胛動作無法追蹤
- **A-pose vs T-pose 靜態 bind 假設**：校正只讀 bind pose 的 child 位置，
  對於動畫 bind 位置非標準姿勢的模型可能仍有偏差
- **Phase 12 實測發現的三個明顯偏差**（2026-04-08）：
  1. **手腕方向不對**：hand bone 解算用 `wrist → index` 方向，但 VRM bind
     pose 的手腕 child（手指 metacarpal）位置並非指向 index 方向。
     需改為從手掌平面法向量 + index/pinky 方向建 basis
  2. **頭部 facing 不對**：head bone 整個 skip（見上方），所以頭永遠保持
     bind pose 的朝前方向。需 Phase 14+ 補回（三點 rigid body 基底）
  3. **腳踝方向不對**：foot bone 解算用 `ankle → foot_index` 方向，同樣
     與 VRM bind pose 的 foot child 位置不一致。需用 heel + toe + ankle
     三點建平面法向量

### 高品質處理（Stage 2）
- **已修正**：performance.now() 取代 video.currentTime 作為 MediaPipe
  timestamp，避免 Stage 1→Stage 2 切換時的 INVALID_ARGUMENT timestamp
  mismatch（MediaPipe calculator graph 內部單調性檢查）
- **UI 仍可改善**：處理期間影片 seek 會閃爍；可考慮隱藏左窗格 video 或
  加 overlay 遮罩
- **速度**：每幀 seek + detect 約 50-100ms，5 秒影片約 8-15 秒處理。
  未來可考慮 worker pool 或直接用離線 image pipeline（非 video mode）

### VRMA 匯出
- **尚未驗證整合**：Spike B 只驗證了 minimal scene round-trip，尚未確認
  Stage 1/2 結果 → AnimationClip → VrmaExporter → 主視窗 AnimationManager
  載入播放的完整鏈路。Phase 13 實作並驗證
- **bone 命名映射**：Phase 3 的 VRM_BONE_PARENT_CHAIN 用 VRM 1.0 名稱，
  若使用者模型為 VRM 0.x，fingers 命名可能不一致（拇指 Metacarpal vs
  Proximal 順序差）。Phase 13 VRMA 匯出時需處理

### Hand / Eye 追蹤
- **Stage 1 預設啟用 hands**（2026-04-08 後）：`enableHands: true`。
  HandSolver 使用 Kalidokit 風格 1 DOF Z-axis bending（每節手指由
  `angleBetween3DCoords(prev, curr, next)` 推得 clamp 到 `[-π/2, 0]` 的
  euler Z，左右手 `invert` 翻轉），不依賴 REF_DIR 校正。PoseSolver 端
  對端測試（`tests/unit/video-converter/solver/PoseSolver.test.ts`）
  涵蓋左右手 routing / enable 切換 / landmark 不足降級等情境。
  使用者可透過 SettingsPanel 即時關閉（若影響 fps）
- **Eye 追蹤**：EyeGazeSolver 已實作但多數 VRM 模型沒有 leftEye/rightEye
  humanoid bone，套用時會被靜默跳過

---

## 結語

此計畫已涵蓋所有設計決策、實作細節、測試覆蓋、風險點。共 16 個 commit，可分階段交付。**建議執行順序：先跑 Phase 0 雙 spike**（一個 commit 內解決最高風險），視結果決定是否需要調整後續架構。
