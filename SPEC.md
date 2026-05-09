# virtual-assistant-desktop — 軟體規格書

> **目標平台：** Windows 10 / 11、macOS 11+  
> **版本：** v0.1 Draft  
> **更新日期：** 2026-04-07

---

## 1. 專案概述 (Project Overview)

### 1.1 核心定位

| 項目 | 說明 |
|------|------|
| 軟體類型 | 桌面虛擬陪伴軟體 (Desktop Mascot) |
| 目標平台 | Windows 10 (1903+) / Windows 11、macOS 11 (Big Sur) 以上 |
| 運行特性 | 常駐於系統背景、低資源消耗、支援多螢幕環境 |
| 最低系統需求（Windows） | Windows 10 1903+、支援 WebGL 2.0 之顯示卡 |
| 最低系統需求（macOS） | macOS 11 Big Sur 以上、Apple Silicon 或 Intel x64 |
| 目標使用者 | 喜愛虛擬角色、VTuber 文化的一般桌面使用者 |

### 1.2 版本規劃 (Release Roadmap)

專案分為三個階段遞增交付：

- **v0.1：** 透明視窗 + VRM 模型載入與渲染 + .vrma 動畫系統（資料夾掃描、分類、播放）
- **v0.2：** 視窗互動系統（碰撞、吸附、遮擋） + 自主移動行為狀態機 + 拖曳移動
- **v0.3：** 表情系統（自動+手動） + 系統托盤
- **v0.4：** 麥克風唇形同步 (Lip-sync) + SpringBone 物理運算
- **v0.5：** 攝影機臉部追蹤 + 進階設定介面 + 自動更新

---

## 2. 核心功能 (Core Features)

### 2.1 3D 模型渲染

- **模型格式：** 支援標準 `.vrm` 格式（VRM 0.x 與 1.0）。
- **物理運算：** 支援 VRM 內建 SpringBone，包含頭髮、衣物擺動。
- **模型限制：** 建議檔案大小上限 50MB，超過時顯示警告。頂點數建議不超過 10 萬。

### 2.2 動畫系統 (.vrma)

#### 2.2.1 動畫載入與管理

- **載入方式：** 使用者指定一個動畫資料夾，軟體啟動時自動掃描該資料夾內所有 `.vrma` 檔案並建立清單。
- **格式限制：** v0.1 僅支援 `.vrma` 格式。
- **設定檔：** 動畫 metadata 儲存於 `~/.virtual-assistant-desktop/animations.json`，記錄每個動畫的 metadata，包含：檔案名稱、使用者自訂顯示名稱（預設使用檔名）、分類標籤（`idle`、`action`、`sit`、`fall`、`collide`、`peek`）、是否循環播放 (`loop`)、權重（用於待機隨機播放的機率）。
- **預設行為：** 新掃描到的 `.vrma` 預設歸類為 `action`，使用者可在設定介面中改為 `idle`。
- **重新掃描：** v0.1 支援「啟動時自動掃描」與「設定介面中手動重新掃描按鈕」。

#### 2.2.2 動畫分類

- **待機動畫 (idle)：** 系統自動從所有標記為 `idle` 的動畫中依權重隨機選取播放，每段結束後 crossfade 過渡到下一段。若無任何 `idle` 動畫，fallback 到程式內建的基礎待機動畫。
- **內建 fallback 動畫：** 以程式碼驅動 bone rotation 實作基礎的呼吸（胸部骨骼微幅上下）與眨眼（BlendShape 週期性觸發），不依賴外部 .vrma 檔案，確保無論使用者是否載入動畫，角色都不會完全靜止。
- **觸發動畫 (action)：** 僅能透過右鍵選單手動觸發。觸發時中斷當前待機動畫、crossfade 到該 action，播完後自動回到待機輪播。
- **坐下動畫 (sit)：** 角色吸附到視窗頂部時自動播放。若無對應動畫則以站立姿態停留在視窗上。
- **落下動畫 (fall)：** 角色吸附的視窗被關閉或最小化時播放的過渡動畫。若無對應動畫則直接回到待機狀態。
- **碰撞動畫 (collide)：** 角色碰到視窗邊緣時播放的反應動畫。若無對應動畫則僅停止移動並改變方向。
- **探頭動畫 (peek)：** 角色躲在視窗後面時播放的探頭動畫。若無對應動畫則僅靜態露出部分身體。

#### 2.2.3 動畫播放機制

- **過渡方式：** 所有動畫切換皆使用 crossfade 混合過渡，避免生硬切換。
- **技術實作：** 透過 `@pixiv/three-vrm` 的 `VRMAnimationLoaderPlugin` 載入 `.vrma`，轉換為 Three.js `AnimationClip`，以 `AnimationMixer` 控制播放。

### 2.3 表情系統 (BlendShapes)

#### 2.3.1 表情來源

表情來自 VRM 模型內建的 BlendShapes。軟體啟動時讀取模型支援的所有表情清單。

#### 2.3.2 觸發方式

- **自動模式：** 待機時每隔隨機間隔（15–45 秒）自動切換一次表情，僅從使用者標記為「允許自動播放」的表情中選取（預設全部允許）。
- **手動模式：** 右鍵選單列出所有可用表情，使用者可直接切換。

#### 2.3.3 表情與動畫的優先級

當多個來源同時控制表情時，依以下優先級處理（由高到低）：

1. **.vrma 動畫內的表情軌道：** 正在播放的動畫若包含 morph target tracks，由動畫控制表情。
2. **手動指定的表情：** 使用者透過右鍵選單手動切換的表情。
3. **自動隨機表情：** 系統待機時自動輪播的表情。

當 action 動畫播放結束回到 idle 後，表情控制權回到自動/手動系統。

### 2.4 桌面環境融合

- **透明視窗：** 全透明、無邊框視窗，僅顯示 3D 角色本身。
- **滑鼠穿透：** 遊標在模型外可點擊桌面其他圖示，在模型上可進行互動（動態判定 Hit-test）。
- **永遠置頂：** 視窗始終保持 Always-on-top。支援 Win+D 顯示桌面時可選擇隱藏或保持顯示（由使用者設定）。
- **多螢幕支援：** 角色可跨螢幕拖曳。正確處理不同 DPI 縮放比例（100%/125%/150%）的多螢幕場景。
- **邊緣碰撞：** 角色不可被完全拖出可見螢幕範圍，至少保留 20% 身體在螢幕內。
- **角色縮放：** 使用者可透過滑鼠滾輪或設定面板調整角色在螢幕上的顯示大小。縮放範圍為 50%–200%（相對於預設大小），預設為 100%。縮放值儲存於 config.json。

### 2.5 基礎互動系統

- **拖曳移動：** 按住滑鼠左鍵可將角色拖曳至螢幕任意位置。
- **待機動畫：** 由動畫系統（2.2）自動管理，隨機播放 idle 分類的 .vrma 動畫。
- **右鍵選單：** 在角色上點擊右鍵可開啟快捷選單，結構如下：

```
右鍵選單
├── 動畫 ▶         （子選單：列出所有 action 分類的動畫，依顯示名稱排列）
├── 表情 ▶         （子選單：列出模型所有可用 BlendShapes）
├── ──────────      （分隔線）
├── 縮放 ▶         （子選單：50% / 75% / 100% / 125% / 150% / 200%）
├── 暫停自主移動    （切換項：暫停/恢復自主移動行為）
├── ──────────      （分隔線）
└── 設定            （開啟設定視窗）
```

當動畫或表情數量超過 15 項時，子選單自動啟用捲動或分頁顯示，避免選單過長。

### 2.6 環境感測與進階互動

#### 2.6.1 麥克風唇形同步 (Lip-sync)

- **基礎模式：** 偵測麥克風音量，動態驅動 VRM 模型嘴型張合。
- **進階模式（規劃中）：** 基礎元音分析（A/I/U/E/O 五個母音對應不同 BlendShape）。
- **隱私指示：** 麥克風啟用時，視窗或系統托盤圖示須有明顯的視覺指示（如圖示變色或動畫）。

#### 2.6.2 攝影機視覺追蹤

- **功能：** 透過視訊鏡頭捕捉使用者臉部位置，使桌寵頭部與視線 (LookAt) 跟隨移動。
- **技術：** 使用 MediaPipe Face Landmarker，需驗證在 Electron Chromium 中可正常存取 getUserMedia。
- **隱私指示：** 攝影機啟用時同樣須有明顯的視覺指示。預設為關閉，由使用者主動啟用。

> ⚠️ **技術風險：** Electron Chromium 對 getUserMedia 的支援需在 MVP 前先做 prototype 驗證。若不可行，備案為透過 Node.js 主程序呼叫原生攝影機 API 並將影像傳遞至前端。

### 2.7 視窗互動系統 (Window Interaction)

#### 2.7.1 視窗感知（Node.js 主程序）

- **實作方式：** 透過 Node.js 主程序呼叫 koffi FFI（`GetWindow` 遍歷 + `GetWindowRect` + `DwmGetWindowAttribute`），定期輪詢取得所有可見視窗的位置、大小與 Z-order。
- **輪詢頻率：** 每秒 3–5 次。
- **過濾規則：** 排除不可見視窗、最小化視窗、桌寵自身視窗，產生「視窗碰撞體清單」透過 Electron IPC 傳送至前端。
- **效能優化：** 僅在角色位置或視窗佈局發生變化時才更新碰撞體與遮擋區域，避免無謂重算。

#### 2.7.2 碰撞行為 (Collide)

- **碰撞判定：** 使用角色 bounding box 對視窗矩形做 AABB 碰撞檢測，將所有可見視窗的四邊當作碰撞牆壁。
- **拖曳碰撞：** 角色被拖曳時碰到視窗邊緣會停止移動。
- **自主移動碰撞：** 角色自主移動時遇到視窗會改變方向，並觸發 `collide` 分類動畫（若有）。

#### 2.7.3 吸附行為 (Sit)

- **拖曳吸附：** 使用者將角色拖曳至某個視窗頂部邊緣附近（距離 20px 以內）時，自動吸附到該視窗上邊緣，觸發 `sit` 分類動畫（若有）。
- **自主吸附：** 角色自主移動時，有一定機率選擇走到附近視窗的頂部並坐下。
- **跟隨移動：** 吸附後角色跟隨該視窗一起移動——視窗被拖動時角色同步移動。
- **脫離條件：** 視窗被關閉或最小化時，角色執行 `fall` 分類動畫（若有），隨後回到待機狀態。使用者也可直接拖曳角色離開視窗。

#### 2.7.4 遮擋行為 (Peek)

- **實作方式：** 使用 Windows Region API（`SetWindowRgn`）在 OS 層級動態裁切桌寵視窗形狀，將被其他視窗遮擋的區域從視窗區域中移除，達到角色「藏在視窗後面」的視覺效果。
- **觸發方式：** 角色自主移動時可選擇走到視窗邊緣並「躲」到後面，僅露出部分身體，觸發 `peek` 分類動畫（若有）。
- **更新策略：** 僅在角色位置或遮擋視窗的位置/大小發生變化時才重新計算 region。

#### 2.7.5 自主移動行為狀態機

角色不被拖曳時，依以下狀態機運作：

- **idle（待機）：** 播放 idle 動畫，停留一段隨機時間（可設定範圍）。
- **walk（行走）：** 隨機選擇方向行走，遇到螢幕邊緣或視窗碰撞時改變方向。
- **drag（拖曳）：** 使用者按住滑鼠拖曳角色時進入此狀態，放開後回到 idle 或 sit。
- **sit（坐下）：** 走到視窗頂部並坐下，停留一段時間後離開。
- **fall（墜落）：** 角色吸附的視窗被關閉或最小化時，從吸附處墜落的過渡狀態。
- **hide（隱藏移動）：** 角色移動到視窗邊緣準備躲藏的過渡狀態。
- **peek（探頭）：** 走到視窗邊緣並躲到後面，短暫露出後回到行走或待機。

每個狀態有停留時間範圍與轉移機率，讓行為自然不重複。v0.2 參數先寫死，未來可開放使用者調整。

**自主移動參數：**

- **移動速度：** 預設 60 px/s（以 100% 縮放為基準），隨角色縮放比例等比調整。
- **活動範圍：** 限定在角色當前所在的單一螢幕內，不會自主跨螢幕移動。
- **移動頻率：** idle 停留 5–20 秒後，有 60% 機率進入 walk，20% 機率進入 sit，10% 機率進入 peek，10% 機率繼續 idle。
- **暫停機制：** 使用者可透過右鍵選單暫停/恢復自主移動。

---

## 3. 系統與設定介面 (System & Settings UI)

### 3.1 系統托盤 (System Tray)

軟體啟動後常駐於 Windows 右下角通知區域 (Notification Area)。點擊右鍵可開啟控制選單：

- 載入自訂 VRM 模型
- 切換角色動作或表情
- 開關麥克風 / 攝影機權限
- 效能模式切換（正常 / 省電）
- 開啟設定視窗
- 結束程式

### 3.2 設定視窗

獨立的設定視窗，提供以下項目：

- **模型管理：** 瀏覽、選擇、預覽 VRM 模型。
- **動畫管理：** 指定動畫資料夾、檢視已掃描的 .vrma 清單、設定每個動畫的分類（idle/action/sit/fall/collide/peek）、顯示名稱、循環播放與權重、手動重新掃描按鈕。
- **表情管理：** 檢視模型支援的 BlendShapes 清單、設定哪些表情允許自動播放。
- **視窗行為：** Win+D 顯示桌面時是否隱藏、多虛擬桌面行為。
- **效能調整：** 繪圖幀率上限、省電模式開關。
- **裝置權限：** 麥克風、攝影機權限管理與狀態顯示。
- **關於：** 版本資訊、第三方授權資訊、檢查更新。

---

## 4. 首次啟動體驗 (First Run Experience)

### 4.1 啟動流程

首次啟動時（偵測到 `~/.virtual-assistant-desktop/config.json` 不存在），軟體依以下流程引導使用者：

1. **歡迎畫面：** 簡短介紹軟體功能。
2. **選擇 VRM 模型：** 彈出檔案選擇器，要求使用者選取一個 `.vrm` 檔案。此步驟為必要，無法跳過。
3. **選擇動畫資料夾（可選）：** 提示使用者指定動畫資料夾。可跳過，跳過時角色將使用內建 fallback 動畫。
4. **完成：** 建立 config.json，啟動主程式。

### 4.2 無模型狀態

若使用者在非首次啟動時刪除了已選取的 VRM 模型檔案，軟體啟動後顯示友善提示訊息並自動彈出檔案選擇器，引導使用者重新選取模型。在模型載入前不渲染 3D 視窗。

### 4.3 單實例鎖定 (Single Instance)

軟體僅允許同時運行一個實例。啟動時透過 Electron 的 `app.requestSingleInstanceLock()` 檢測是否已有實例運行。若偵測到已有實例，新啟動的程序將已運行的實例視窗帶到前景後自行退出。

---

## 5. 效能規格 (Performance Specification)

### 4.1 資源預算

| 計量項目 | 目標值 |
|----------|--------|
| CPU 佔用（待機） | < 2% |
| 記憶體佔用（待機） | < 200 MB |
| GPU 佔用（待機） | 可忽略 |
| 執行檔體積（未含模型） | < 30 MB |
| 安裝後佔用空間 | < 100 MB |

### 4.2 幀率策略

- **前景活動：** 30 fps（可調整）。
- **視窗失焦 / 最小化：** 降至 10 fps 或暫停渲染。
- **省電模式（電池供電時）：** 自動降至 15 fps，簡化物理運算。

### 4.3 WebGL Context 復原

Three.js 在長時間運行後可能遇到 WebGL context lost 事件。程式須監聽此事件並自動重建渲染器與場景，不需使用者介入。

---

## 6. 技術堆疊 (Tech Stack)

### 6.1 桌面端框架

| 項目 | 說明 |
|------|------|
| 框架 | Electron (Node.js) |
| 優勢 | 成熟的 Chromium 渲染引擎，跨平台支援佳，透明視窗穩定 |
| 注意事項 | 執行檔體積較大（~150 MB），記憶體佔用較高（含 Chromium） |
| Windows API | 透過 koffi FFI 呼叫 user32.dll / dwmapi.dll（僅 Windows） |

### 6.2 視覺與 3D 渲染

- **Three.js：** WebGL 3D 渲染核心引擎。
- **@pixiv/three-vrm：** 官方維護的 Three.js 擴充，解析 VRM 骨骼、材質、物理與表情。
- **MediaPipe Face Landmarker：** 用於攝影機臉部/視線追蹤的輕量級 ML API。

### 6.3 核心邏輯與架構

- **TypeScript：** 強型別支援，處理 3D 向量、座標轉換與狀態管理。
- **UI 框架：** 主視窗使用 Vanilla TS；設定面板可使用 Svelte 或 Preact。

### 6.4 開發工具鏈

- **Vite：** 前端建置與開發伺服器。
- **bun：** 套件管理員與 script runner（取代舊的 pnpm + Corepack 流程）。
- **ESLint + Prettier：** 程式碼品質與排版風格維護。
- **Vitest：** 單元測試框架，與 Vite 生態系原生整合。

### 6.5 Electron IPC 通訊設計

Electron 主程序（Node.js）與 TypeScript 渲染層透過 Electron IPC 機制溝通。主程序在 `electron/ipcHandlers.ts` 註冊 `ipcMain.handle()`，渲染層透過 `src/bridge/ElectronIPC.ts` 封裝呼叫（經 `electron/preload.ts` 的 `contextBridge` 暴露）。以下為主要的 command 與 event 定義：

**Commands（渲染層呼叫主程序，透過 `ipcMain.handle()`）：**

| Command 名稱 | 說明 | 回傳 |
|--------------|------|------|
| `get_window_list` | 取得當前可見視窗的位置、大小、Z-order 清單 | `WindowRect[]` |
| `set_window_region` | 設定桌寵視窗的裁切區域（遮擋用） | `void` |
| `scan_animations` | 掃描指定資料夾內的 .vrma 檔案 | `AnimationEntry[]` |
| `read_config` | 讀取 config.json | `Config` |
| `write_config` | 寫入 config.json | `void` |
| `read_animation_meta` | 讀取 animations.json | `AnimationMeta` |
| `write_animation_meta` | 寫入 animations.json | `void` |
| `pick_file` | 開啟系統檔案選擇器（VRM / 資料夾） | `string \| null` |
| `get_microphone_level` | 取得當前麥克風音量 | `number` |
| `get_camera_frame` | 取得攝影機畫面（備案用） | `Base64Image` |

**Events（主程序推送至渲染層，透過 `webContents.send()`）：**

| Event 名稱 | 說明 | 資料 |
|------------|------|------|
| `window_layout_changed` | 桌面視窗佈局發生變化時推送 | `WindowRect[]` |
| `display_changed` | 螢幕解析度或 DPI 變更時推送 | `DisplayInfo[]` |
| `power_mode_changed` | 電源模式切換（AC/電池）時推送 | `PowerMode` |

以上為 v0.1–v0.2 的核心 IPC 介面，後續版本新增功能時擴充。

---

## 7. 平台適配 (Platform Specifics)

### 7.1 DPI 處理

兩平台都依賴 Electron 的邏輯像素（DIP）座標系統。Windows 上額外處理 Per-Monitor DPI Aware v2，在不同縮放比例的螢幕間拖動角色時動態重算視窗座標與渲染縮放。macOS 上 Retina 縮放由系統處理，但仍須注意 `devicePixelRatio` 在跨螢幕時的同步。

### 7.2 Windows 特有行為定義

- **Win+D 顯示桌面：** 可選擇隱藏或保持顯示（預設：保持顯示）。
- **多虛擬桌面：** 桌寵僅顯示在當前活動的虛擬桌面，不跨桌面顯示。
- **Focus Assist / 勿擾模式：** 偵測到勿擾模式啟用時，降低動畫頻率、隱藏互動提示。
- **視窗感知（碰撞 / 吸附 / 遮擋）：** 透過 koffi FFI 呼叫 user32.dll 的 GetWindow 遍歷與 DwmGetWindowAttribute 過濾，**僅在 Windows 啟用**。

### 7.3 macOS 特有行為定義

- **Mission Control / Spaces：** 桌寵僅顯示在當前 Space，不跨 Space 顯示。
- **Dock / 選單列：** 應用程式以「accessory」角色運行，不在 Dock 顯示主圖示，僅以選單列圖示常駐（規劃中）。
- **視窗感知功能停用：** macOS 上沒有對等的 user32.dll API，視窗碰撞 / 吸附 / 遮擋 / Peek 功能停用，角色僅在螢幕內自由移動。
- **滑鼠穿透：** 透過 `setIgnoreMouseEvents(true, { forward: true })` 實現，與 Windows 同樣機制但需要 `forward` 選項才能在透明區域穿透。
- **檔案協定：** local-file 協定的路徑解析需處理 macOS 與 Windows 不同的根目錄格式（見 `electron/platform/protocolHelper.ts`）。

### 7.4 跨平台抽象層

所有平台分支必須集中在 `electron/platform/` 目錄：

- `index.ts` — 匯出 `isWindows` / `isMac` 旗標與其他平台模組。
- `windowConfig.ts` — 各平台的 BrowserWindow 建構參數與建立後設定。
- `protocolHelper.ts` — local-file 協定路徑解析。

主程式碼禁止直接散落 `process.platform === 'win32'` 判斷，所有差異透過 `electron/platform/` 統一接口取用。系統 API 呼叫（koffi、AppleScript 等）必須在不支援的平台優雅降級（回傳預設值），不可 throw。

---

## 8. 持久化與資料管理 (Persistence & Data)

所有軟體設定與資料統一儲存於 `~/.virtual-assistant-desktop/` 目錄下，目錄結構如下：

```
~/.virtual-assistant-desktop/
├── config.json          # 使用者偏好設定
├── config.json.bak      # 設定檔損毀時的自動備份
├── animations.json      # 動畫 metadata（分類、權重、顯示名稱等）
├── logs/                # 日誌檔案
│   └── app-YYYY-MM-DD.log
└── crash/               # 崩潰報告
    └── crash-YYYY-MM-DD-HHmmss.log
```

### 8.1 設定檔 (config.json)

使用 Node.js `fs` 模組將使用者偏好儲存於 `~/.virtual-assistant-desktop/config.json`（透過 `electron/fileManager.ts` 管理），包含：

- 視窗位置與大小
- 當前選用的 VRM 模型路徑
- 動畫資料夾路徑
- 麥克風 / 攝影機開關狀態
- 幀率設定、省電模式偏好
- 角色縮放比例
- 自主移動暫停狀態

**損毀處理：** 若 config.json 無法解析（格式錯誤、檔案損毀），軟體將原檔備份為 `config.json.bak`，以全部預設值重新建立 config.json 並記錄警告日誌。不中斷啟動流程。

### 8.2 動畫設定檔 (animations.json)

動畫 metadata 儲存於 `~/.virtual-assistant-desktop/animations.json`，記錄每個 .vrma 檔案的分類、顯示名稱、循環播放、權重等設定。軟體啟動時自動掃描動畫資料夾並與此設定檔同步。

### 8.3 檔案管理

VRM 模型與 .vrma 動畫檔案儲存於使用者指定的外部目錄，軟體僅記錄路徑參照，不複製檔案。若檔案被移動或刪除，顯示友善提示並引導重新選取。

---

## 9. 錯誤處理與日誌 (Error Handling & Logging)

### 9.1 日誌系統

- **日誌位置：** 儲存於 `~/.virtual-assistant-desktop/logs/`。
- **日誌輪替：** 保留最近 7 天的日誌，單檔上限 10MB。
- **日誌等級：** ERROR / WARN / INFO / DEBUG，生產環境預設 INFO 以上。

### 9.2 當機處理

- **WebGL context lost：** 自動重建渲染器與場景。
- **VRM 載入失敗：** 顯示友善錯誤訊息，回退至預設狀態。
- **.vrma 載入失敗：** 跳過該動畫檔案並記錄警告日誌，不影響其他動畫正常運作。
- **未預期崩潰：** 透過 Electron process `'uncaughtException'` 捕捉，寫入 `~/.virtual-assistant-desktop/crash/`，下次啟動時提示使用者可回報。

---

## 10. 測試策略 (Testing Strategy)

- **單元測試：** 使用 Vitest 測試狀態管理、座標計算、動畫狀態機等純邏輯。
- **整合測試：** 測試 Electron 主程序與前端的 IPC 通訊、檔案讀取、設定持久化。
- **手動測試矩陣：** 透明視窗渲染、滑鼠穿透、拖曳、多螢幕 DPI 切換、視窗碰撞/吸附/遮擋行為等視覺功能需人工驗證。
- **效能測試：** 使用 Windows Task Manager 監控資源佔用，確保符合第 5 章效能目標。

---

## 11. 授權與法律 (Licensing & Legal)

### 11.1 第三方授權

專案使用的主要開源元件及其授權：

| 元件 | 授權 |
|------|------|
| Electron | MIT |
| koffi | MIT |
| Three.js | MIT |
| @pixiv/three-vrm | MIT |
| MediaPipe | Apache 2.0 |

---

## 12. 未來擴充規劃 (Future Considerations)

以下功能不在當前範圍內，但架構設計時應預留擴充空間：

- **AI 對話與系統操作：** 整合 LLM API，讓桌寵能與使用者對話。進一步支援透過自然語言指令驅動桌寵執行作業系統內的 CLI 工具（如開啟應用程式、檔案操作、系統查詢等），協助使用者操作電腦。需設計權限控管與指令確認機制，避免誤執行高風險操作。**Electron shell 權限預留：** 此功能依賴 Node.js `child_process` 模組。架構設計階段應預先規劃 shell 指令的白名單策略（allowlist 模式），僅允許執行預定義的安全指令集。高風險操作（如刪除檔案、修改系統設定）需經使用者二次確認彈窗。建議設計三層權限模型：安全指令（自動執行）、一般指令（需確認）、禁止指令（永遠拒絕）。
- **插件系統：** 允許第三方開發動作、表情、互動擴充。
- **更多動畫格式：** 支援 VMD（MMD 格式）、BVH 等其他動畫格式匯入。
- **動畫資料夾即時監控：** 使用 file watcher 即時偵測新增/刪除的 .vrma 檔案，無需手動重新掃描。
- **多角色：** 同時顯示多個桌寵角色。
- **macOS 進階功能：** 透過 AppleScript 或 Accessibility API 擴展 macOS 上的視窗感知功能。

---

## 附錄 A：技術風險評估 (Technical Risks)

| 風險項目 | 說明與緩解方案 |
|----------|----------------|
| Chromium + getUserMedia | Electron Chromium 對攝影機存取的支援需驗證。備案：Node.js 主程序原生攝影機 API。 |
| 透明視窗 + WebGL | 部分顯示卡驅動可能導致透明區域渲染異常。需多硬體測試。 |
| 長時間運行穩定性 | 記憶體洩漏、WebGL context lost。需建立長時間運行測試（24h+）。 |
| SmartScreen 攔截 | 未簽章的執行檔會被攔截。需取得程式碼簽章或引導使用者手動放行。 |
| DPI 縮放相容性 | 混合 DPI 多螢幕場景複雜。需在多種縮放組合下測試。 |
| SetWindowRgn 效能 | 頻繁更新視窗 region 可能影響渲染效能。需限制僅在位置變化時更新。 |
| 視窗輪詢準確性 | 部分應用程式的視窗可能有非標準行為（如無邊框、分層視窗），影響碰撞判定準確性。需多應用程式場景測試。 |
