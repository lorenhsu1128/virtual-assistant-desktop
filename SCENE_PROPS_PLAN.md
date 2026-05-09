# 可互動場景道具系統（Scene Props）開發計劃

> **狀態**：📋 規劃中，尚未開始實作
> **建立日期**：2026-04-11
> **對應模組（未建立）**：`src/props/`
> **預計相依**：`GLTFLoader`（已存在於 VRMController）、`Platform` 型別、`fileManager` 掃描模式

---

## Context

目前桌寵專案只能載入 VRM 角色模型，可互動對象僅限於「Windows 桌面視窗」（作為 platform 可坐、作為牆壁可碰、作為遮蔽物可躲）。使用者希望新增「場景道具」概念：讓使用者放入自己的 3D 模型（桌子、椅子、箱子、盆栽等）成為桌面世界的一部分，角色能像對待視窗一樣**坐上去、撞到會反應、躲在後面**。

**核心觀察**：專案架構非常適合這個擴充——

- `GLTFLoader` 已因 VRM 載入內建
- `Platform` 抽象已存在且與視窗解耦（`Platform` 純粹是「可站立平面」，不在乎來源）
- `rebuildWindowPlatforms()` 的 pattern 可複製為 `rebuildPropPlatforms()`
- `fileManager.scanAnimations` 的「資料夾掃描 + metadata 同步」模式可直接套用
- Orthographic camera + pixelToWorld 座標系統與視窗共用

**使用者決策**（2026-04-11 AskUserQuestion 確認）：

1. **互動層級**：Tier 3 — 可坐、可碰、可躲、可互動（完整 StateMachine 整合）
2. **放置方式**：拖曳放置，滑鼠滾輪縮放，右鍵選單旋轉/刪除，位置自動存檔
3. **資產管理**：專屬 `scene-props/` 資料夾掃描，類似 `animations.json` 的同步模式
4. **格式**：僅 GLB / glTF（不支援 OBJ/FBX）

**任務規模**：這是大功能，**分三階段提交**讓中間能驗證。

## Approach

### 核心設計原則

1. **Props 模組與 VRM 隔離**：新 `PropManager` 類別管理 props 生命週期，不動 `VRMController`
2. **重用 Platform 抽象**：prop 的頂面 → `Platform{ screenY, screenXMin, screenXMax }`，直接塞進 `BehaviorInput.platforms`，StateMachine 完全無需知道 prop 是什麼
3. **視窗+道具統一為 obstacleRects**：新增 `BehaviorInput.propRects: PropCollisionRect[]` 讓 tickWalk / tickHide / tickPeek 的判定邏輯擴充為「檢查 windowRects + propRects 聯集」
4. **單一 GLB 可多次放置**：每個「placed instance」有獨立 UUID，共用同一個 .glb 檔案
5. **Scene 深度整合**：prop Z 值由使用者配置（前景/背景），預設 = DEFAULT_Z（與角色同層）
6. **座標單位一致**：prop position 用螢幕邏輯像素（與 characterSize 相同），PropManager 內部自動 × pixelToWorld 轉世界座標

### 分階段提交

#### Phase 1 — 載入與渲染（無互動）

讓 prop 能載入、出現在畫面上、可以切換；純視覺，角色穿過無反應。

#### Phase 2 — 拖曳放置 UX

使用者可以用滑鼠拖曳、滾輪縮放、右鍵刪除/旋轉；位置持久化到 `scene-props.json`。

#### Phase 3 — Tier 3 互動整合

Prop 的 bounding box 投影成 platform（可坐）+ propRect（可碰/可躲），整合進 StateMachine。

每個 Phase 單獨 commit，可獨立驗證。

---

## Phase 1 — 載入與渲染

### 新增型別 `src/types/sceneProp.ts`

```ts
/** 單一 prop 放置實例（同一 GLB 可多次放置） */
export interface ScenePropInstance {
  /** 穩定 UUID（用 crypto.randomUUID） */
  id: string;
  /** 對應 library 中的檔名（不含路徑） */
  fileName: string;
  /** 使用者自訂顯示名稱（預設 = 檔名去副名） */
  displayName: string;
  /** 錨點螢幕座標（物件中心底部，邏輯像素） */
  position: { x: number; y: number };
  /** 統一縮放 0.1–5.0，預設 1.0 */
  scale: number;
  /** Y 軸旋轉（弧度），預設 0 */
  rotationY: number;
  /** 互動旗標（Phase 3 使用；Phase 1 保留欄位但不作用） */
  interactions: {
    collidable: boolean;  // 可撞
    sittable: boolean;    // 可坐
    hideable: boolean;    // 可躲
  };
  /** Z 深度選擇（Phase 3 使用） */
  zMode: 'default' | 'front' | 'back';
}

/** Prop metadata 持久化結構（存在 ~/.virtual-assistant-desktop/scene-props.json） */
export interface ScenePropMeta {
  folderPath: string;                // 使用者指定的資料夾
  library: string[];                 // 掃描到的 .glb 檔名清單
  instances: ScenePropInstance[];    // 目前場景中已放置的 prop
}

export const DEFAULT_SCENE_PROP_META: ScenePropMeta = {
  folderPath: '',
  library: [],
  instances: [],
};
```

### 新增 IPC（三層同步）

遵循 `LESSONS.md [2026-04-03] Electron IPC 三層同步` 守則。

**`electron/ipcHandlers.ts`** 新增：

- `pick_scene_props_folder` — 檔案對話框選資料夾
- `scan_scene_props` (folderPath) — 掃描 `.glb` / `.gltf` 檔名清單
- `read_scene_props_meta` — 讀 `scene-props.json`
- `write_scene_props_meta` (meta) — 寫入

**`electron/preload.ts`**：contextBridge 暴露對應 camelCase API

**`src/bridge/ElectronIPC.ts`**：包裝 try/catch + fallback（掃描失敗回空陣列、讀失敗回預設值）

### `electron/fileManager.ts` 擴充

- 新增 `readScenePropsMeta()` / `writeScenePropsMeta(meta)` — 模仿 `readAnimationMeta`
- 新增 `scanSceneProps(folderPath)` — 掃描 .glb/.gltf 檔名，merge 到現有 library 欄位
- 損毀偵測：JSON 解析失敗自動備份 `.bak` 並重建為 `DEFAULT_SCENE_PROP_META`（與 config.json 相同策略）

### 新增 `src/props/PropManager.ts`

**職責**：管理 prop instance 的載入、渲染、釋放；是 VRMController 的對等模組但處理純 glTF。

```ts
export class PropManager {
  private scene: THREE.Scene;
  private pixelToWorld: number;
  private loader: GLTFLoader;
  /** id → { instance meta, THREE.Group, boundingBox } */
  private loaded = new Map<string, LoadedProp>();
  private libraryFolderPath: string | null = null;

  constructor(scene: THREE.Scene, pixelToWorld: number);

  /** 設定資源資料夾（載入前必須呼叫） */
  setLibraryFolder(folderPath: string): void;

  /** 載入 prop instance 到 scene（非同步，從 library 路徑組裝 URL） */
  async addInstance(instance: ScenePropInstance): Promise<void>;

  /** 移除 prop instance（從 scene 取出 + dispose geometry/material） */
  removeInstance(id: string): void;

  /** 更新 instance 的位置/縮放/旋轉（用於 Phase 2 拖曳） */
  updateInstance(id: string, patch: Partial<ScenePropInstance>): void;

  /** 取得所有 loaded props 的 bounding box（給 Phase 3 StateMachine 用） */
  getCollisionRects(): PropCollisionRect[];

  /** 全部卸載 */
  disposeAll(): void;
}
```

**載入流程**（`addInstance`）：

1. `url = convertToAssetUrl(join(libraryFolderPath, instance.fileName))`
2. `const gltf = await loader.loadAsync(url)`
3. `const group = gltf.scene`
4. 設定 `group.position / scale / rotation.y` 依 instance
5. 遍歷子 mesh 設 `frustumCulled = false`（與 VRMController 一致，避免邊緣裁切）
6. 計算 `Box3.setFromObject(group)` 存為 boundingBox
7. `scene.add(group)`，加入 `loaded` Map

**URL 轉換**：沿用現有 `ipc.convertToAssetUrl` 機制（electron local-file 協定）

### `src/core/SceneManager.ts` 整合

- 建構時新增 `this.propManager = new PropManager(this.scene, this.pixelToWorld)`
- 新增 `async loadSceneProps()` 方法：讀 `scene-props.json` → `setLibraryFolder` → 逐一 `addInstance`
- 在 `start()` 後、或 VRM 載入完成後呼叫
- `dispose()` 呼叫 `propManager.disposeAll()`

### 系統托盤新增項目

- `選擇道具資料夾...` → `pick_scene_props_folder` 更新 folderPath
- `管理場景道具...` → Phase 2 才實作對話框，Phase 1 先佔位或隱藏
- `Debug: 列印已載入 props` → console.log 所有 instance id + boundingBox（開發驗證用）

### Phase 1 驗證

- 手動編輯 `scene-props.json` 放入 1-2 個 instance，重啟後 prop 應出現在指定螢幕座標
- console 確認 bounding box 計算正確
- 縮放角色/切換模型後 prop 不受影響
- `bun run test` 仍 184/184（Phase 1 無單元測試新增；PropManager 整合測試難）
- `npx tsc --noEmit` / `bun run lint` 清潔
- 無記憶體洩漏：反覆載入卸載 prop

### Phase 1 commit

`feat(scene-props): Phase 1 — GLB 載入與渲染框架`

---

## Phase 2 — 拖曳放置 UX

依賴 Phase 1 完成。

### 新增模組 `src/interaction/PropDragHandler.ts`

**職責**：偵測滑鼠在 prop 上的 hit、拖曳、縮放、旋轉、刪除。

- 使用 `THREE.Raycaster` 對 `propManager.loaded` 做 3D 射線測試（滑鼠螢幕座標轉 NDC → 射線）
- hit 到 prop → 開始拖曳模式（暫停角色自主移動）
- 拖曳中 `mousemove` → 更新 `position`
- 滾輪 → `scale ± 0.1`
- 右鍵選單 → 旋轉 90°、刪除、toggle collidable/sittable/hideable、zMode
- 放開後自動 `ipc.writeScenePropsMeta(...)` 持久化
- 需與現有 `DragHandler`（角色拖曳）和 `HitTestManager`（角色穿透）協調：
  - **優先級**：PropDragHandler 先 hit-test，hit 到 prop 則阻擋事件；否則傳給現有 DragHandler

### HitTestManager 擴充

現有 `HitTestManager` 負責判定滑鼠在角色 pixel 上時關閉穿透。需擴充：**在 prop bounding box 內也關閉穿透**，讓 prop 可被點擊。

### 視覺回饋

- Hover 到 prop → prop 外框高亮（emissive tint 或額外 wireframe mesh）
- 拖曳中 → prop 半透明跟隨
- 右鍵選單用 HTML overlay（與現有 CharacterContextMenu 同模式）

### Phase 2 commit

`feat(scene-props): Phase 2 — 拖曳放置 / 縮放 / 旋轉 UX`

---

## Phase 3 — Tier 3 互動整合

依賴 Phase 1+2 完成。

### 新增型別 `PropCollisionRect`

```ts
export interface PropCollisionRect {
  id: string;              // instance id（辨識用，類似 hwnd）
  /** 螢幕座標 AABB（邏輯像素） */
  x: number;
  y: number;
  width: number;
  height: number;
  /** 頂面 Y（sit 用，通常 = y） */
  topY: number;
  /** Z 深度（遮擋判定用） */
  z: number;
  interactions: {
    collidable: boolean;
    sittable: boolean;
    hideable: boolean;
  };
}
```

### `BehaviorInput` 擴充

```ts
interface BehaviorInput {
  // ... 既有欄位
  /** 場景道具碰撞矩形（與 windowRects 同語義但來源不同） */
  propRects: PropCollisionRect[];
}
```

### PropManager 新方法

`getCollisionRects(): PropCollisionRect[]`

- 對每個 loaded prop 計算螢幕空間 AABB
  - `Box3.setFromObject(group)` 取世界空間 box
  - 轉換為螢幕座標（世界 / pixelToWorld）
  - 投影成 2D rect
- 過濾 `interactions.sittable || .collidable || .hideable === false` 的不輸出
- 標注 `topY`（= 螢幕空間 Y 最小值 = 最上緣）

### SceneManager render loop 整合

```
StateMachine.tick(input) 前：
  const propRects = propManager.getCollisionRects();
  input.propRects = propRects;
  // 同時把可坐的 prop 轉成 Platform 塞進 input.platforms
  input.platforms.push(...propRects.filter(r => r.interactions.sittable).map(r => ({
    id: `prop:${r.id}`,
    screenY: r.topY,
    screenXMin: r.x,
    screenXMax: r.x + r.width,
  })));
```

### StateMachine 最小侵入修改

- `tickWalk` 碰撞檢查加入 `input.propRects` 的聯集迴圈（與 windowRects 平行）
- `tickHide` / `tickPeek` / `enterOpendoor` 等 hide 目標可選 prop（用 `id` 字串區分 `window:123` / `prop:uuid`）
- 或更簡單：維持 `hwnd: number` 介面，用**synthetic hwnd**（如 `1_000_000_000 + propIndex`）代表 prop；犧牲語義清晰度換實作簡單

### 深度排序

- PropManager 依 `instance.zMode` 設定 `group.position.z`：
  - `default` = 8.5（與角色同層）
  - `front` = 9.0（角色前）
  - `back` = 7.0（角色後）
- `resolveCharacterZ` 無需修改（依然用視窗 hwnd 決定角色 Z）

### Phase 3 commit

`feat(scene-props): Phase 3 — Tier 3 互動整合（sit/collide/hide）`

---

## Files to Modify / Create

### 新增（Phase 1）

- `src/types/sceneProp.ts`
- `src/props/PropManager.ts`

### 修改（Phase 1）

- `electron/ipcHandlers.ts` — 4 個新 handler
- `electron/preload.ts` — 對應 contextBridge API
- `src/bridge/ElectronIPC.ts` — 4 個 wrapper 方法
- `electron/fileManager.ts` — scanSceneProps / readScenePropsMeta / writeScenePropsMeta
- `src/types/config.ts` — 新增 `scenePropsFolder: string | null` 欄位（v1 可省）
- `src/core/SceneManager.ts` — 建構 PropManager 並整合載入流程
- `electron/systemTray.ts` — 新增托盤選單項
- `src/main.ts` — 托盤 action handler（`pick_scene_props_folder`）
- `CLAUDE.md` — 更新目錄結構加入 `src/props/`

### 新增（Phase 2）

- `src/interaction/PropDragHandler.ts`

### 修改（Phase 2）

- `src/interaction/HitTestManager.ts` — 加入 prop bounding box 穿透區
- `src/core/SceneManager.ts` — 掛 PropDragHandler
- `src/main.ts` — 串接事件

### 修改（Phase 3）

- `src/types/behavior.ts` — `BehaviorInput.propRects`
- `src/types/sceneProp.ts` — 加 `PropCollisionRect`
- `src/props/PropManager.ts` — `getCollisionRects()`
- `src/behavior/StateMachine.ts` — 碰撞與 hide 判定擴充
- `src/core/SceneManager.ts` — render loop 把 propRects 塞進 BehaviorInput

## 可重用的既有工具

- **GLTFLoader**：`three/addons/loaders/GLTFLoader.js`，VRMController 已在用
- **`ipc.convertToAssetUrl`**：local-file 協定 URL 組裝，已在 VRM 載入流程使用
- **`fileManager.readAnimationMeta` 模式**：JSON 讀寫 + 損毀備份 + 預設值重建
- **`VRMController.loadModel` 的 frustumCulled = false pattern**：避免邊緣裁切
- **`Platform` 型別**：Phase 3 直接複用作為 prop 的「可坐平面」介面
- **`CharacterContextMenu`**：Phase 2 的右鍵選單 UI 參考
- **`rebuildWindowPlatforms`（SceneManager.ts:1438）**：Phase 3 的 prop→platform 轉換參考
- **`crypto.randomUUID`** (Node + browser)：產生 stable instance id

## 相關教訓（LESSONS.md）

- **[2026-04-03] Electron IPC 三層同步**：Phase 1 新增 IPC 必須同時改 ipcHandlers、preload、ElectronIPC
- **[2026-04-03] 電子主程序重新編譯**：改 electron/ 後必須 `bun run build:electron` + 重啟
- **[2026-04-07] Render loop cache 不可在同步呼叫立刻使用**：PropManager 的 instance 狀態切勿在 IPC handler 立刻讀，要走 source-of-truth getter
- **[2026-04-03] 架構違規**：PropManager 可依賴 Three.js；但 StateMachine 依然不能 import prop 或 three
- **[2026-04-09] AnimationAction instance reuse**：不相關（props 不使用 AnimationMixer）
- **[2026-04-09] MToon outline 正交相機**：若 prop 含 MToon material 會有同樣問題；Phase 1 驗證時確認（大多商業 GLB 用 standard PBR，不會中此陷阱）

## Verification

### Phase 1

- 手動編輯 `scene-props.json` 放入 1 個 instance，重啟後 prop 出現
- `npx tsc --noEmit` / `bun run test` / `bun run lint` 清潔
- console 無 GLTFLoader 錯誤
- 切換 VRM 模型後 prop 不受影響
- 角色穿過 prop 無反應（因 Phase 1 無互動）
- 記憶體：反覆切換 `scenePropsFolder` 後 `Object3D` 計數穩定（devtools 檢查）

### Phase 2

- 滑鼠在 prop 上可拖曳移動
- 滾輪縮放範圍 0.1–5.0
- 右鍵選單可刪除、旋轉、toggle interactions
- 放開滑鼠後重啟應用，prop 回到放下的位置
- 角色拖曳（DragHandler）與 prop 拖曳互不干擾

### Phase 3

- 角色走到 prop 會撞牆並改變方向（collidable=true 時）
- 角色走到 prop 頂部會自動 sit（sittable=true 時），視窗/prop 兩種 platform 行為一致
- 托盤「暫停/恢復自主移動」行為正常
- opendoor / enterdoor 不受 prop 影響
- 走出 prop 範圍正常繼續 walk
- 完整手動測試矩陣：Tier 1/2/3 旗標的 8 種組合

## 注意事項 / 已知風險

- **記憶體洩漏**：GLTFLoader 載入的 `gltf.scene` 底下的 geometry/material 必須在 removeInstance 時 `dispose()`，否則 GPU 資源累積（VRMController.dispose() 是好參考）
- **大型 GLB 載入時間**：幾十 MB 的 .glb 解析可能卡住 UI thread 幾百 ms。Phase 1 先串接，v2 可考慮 worker loader
- **座標系單位混淆**：`position` 存螢幕邏輯像素而非世界座標，避免與 VRM 模型的世界空間尺寸混淆；PropManager 內部做 × pixelToWorld 轉換
- **Raycaster 效能**：hit test 每幀針對多個 prop 呼叫可能吃 CPU；只在 mousemove 時呼叫而非每幀
- **共享 GLB 快取**：多個 instance 指向同一檔名時，loader 會重複下載。Phase 1 先不處理，Phase 2 可加 `Map<fileName, gltf>` 快取並 `gltf.scene.clone()`
- **VRM 0.x 模型能否當 prop**：可以，GLTFLoader 會忽略 VRM extension 直接載 scene，但會失去骨骼/表情；不推薦但不擋
- **MToon 描邊問題**：若使用者把 VRM 風格 GLB 當 prop 可能遇到正交相機描邊變粗。若發生可沿用 `VRMController.setMToonOutlineEnabled` 的 duck-typing 處理
- **命名衝突**：`scene-props.json` 與 `animations.json` 同層儲存於 `~/.virtual-assistant-desktop/`
- **z-order 與視窗互動**：Phase 3 的 prop 遮擋若使用 zMode='back' 可能與 WindowMeshManager 的 depth-only mesh 衝突；需實測深度值範圍

---

## 開發啟動檢查清單

未來開始實作時，先確認：

- [ ] LESSONS.md 是否有新的相關教訓（特別是 Three.js / GLTFLoader / Electron IPC 相關）
- [ ] 跨平台守則是否仍有效（此功能純前端，兩平台共用）
- [ ] `vrmodels/` 或類似目錄是否有範例 GLB 可測試
- [ ] 先 `git pull` 同步遠端，再建 `feature/scene-props-phase-1` 分支
- [ ] Phase 1 完成並驗證後再開 Phase 2，避免整包做完才發現設計問題
