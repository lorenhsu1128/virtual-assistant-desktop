# Spike 執行指引

> **Phase 0 — Video Motion Converter**
> 兩個獨立的 spike 用於在 Phase 1 開工前驗證兩個最高風險技術點。
> 執行後將結果填入 `SPIKE-RESULTS.md`，再決定後續架構。

---

## Spike A — MediaPipe HolisticLandmarker

**目標**：驗證 `@mediapipe/tasks-vision` 的 `HolisticLandmarker` 在 Electron Chromium 可用性、GPU delegate、單幀延遲。

### 執行方式

1. 在專案根目錄執行：
   ```bash
   pnpm dev
   ```
   這會同時啟動 Vite dev server (`http://localhost:1420`) 與 Electron 主視窗。

2. **在 Electron 主視窗中**（不是外部瀏覽器），按 `Ctrl + L` 或手動輸入網址：
   ```
   http://localhost:1420/spike-mediapipe.html
   ```

   > ⚠️ **必須在 Electron 視窗內執行**，因為 GPU delegate 的行為可能與一般瀏覽器不同。
   > 如果 Electron 主視窗是透明桌寵，你可以暫時關掉它，改用一個新的 Electron 視窗：
   > ```bash
   > # 方法 A：直接在主視窗的 DevTools Console 執行
   > location.href = 'http://localhost:1420/spike-mediapipe.html'
   > ```

3. 頁面操作：
   - 選擇 delegate（預設 GPU）
   - 按「1. 初始化 HolisticLandmarker」
     - 首次會從 CDN 下載 `.task` 模型（~15MB）與 WASM，等 5–15 秒
     - 觀察：delegate 是否成功 / 是否自動降級 CPU
   - 按「2. 載入影片」：選擇專案根目錄的 `人物推動大箱子影片.mp4`
   - 按「3. 開始偵測」
     - 影片會自動播放，每幀呼叫 `detectForVideo`
     - 右側面板即時顯示：delegate、init 耗時、平均 / p50 / p95 延遲、四個 landmark group 回傳狀態
     - 影片上會疊加 skeleton overlay

### 要觀察什麼

| 觀察項 | 目標值 | 實測後填入 SPIKE-RESULTS.md |
|---|---|---|
| GPU delegate 可用 | YES | |
| Init 耗時 | < 20s | |
| 平均延遲 | < 33ms（30fps 可行） | |
| p50 延遲 | < 33ms | |
| p95 延遲 | < 60ms（可接受） | |
| pose landmarks | 33 points | |
| leftHand landmarks | 21 points | |
| rightHand landmarks | 21 points | |
| face landmarks | 478 points（含虹膜）| |

### 失敗應變

| 症狀 | 應變 |
|---|---|
| GPU delegate 初始化失敗 | 程式會自動降 CPU，觀察 CPU 延遲是否可接受 |
| 單幀 > 100ms | Stage 1 即時預覽放棄手指 |
| HolisticLandmarker 完全跑不動 | fallback 到 PoseLandmarker + HandLandmarker + FaceLandmarker 三個獨立 task |

---

## Spike B — VRMA round-trip

**目標**：驗證 Three.js `GLTFExporter` + 注入 `VRMC_vrm_animation` extension 能產出被 `VRMAnimationLoaderPlugin` 讀回的 `.vrma`。

### 執行方式

1. 同樣在 Electron 視窗內訪問：
   ```
   http://localhost:1420/spike-vrma-export.html
   ```

2. 頁面操作：
   - 按「1. 產出測試 VRMA」
     - 內部會建最小 humanoid bone scene、2 秒測試 clip、用 GLTFExporter 輸出、注入 extension
     - 觀察 log：bone 數量、glb size、humanBones 對應數
   - 按「2. 下載 spike-output.vrma」→ 儲存到任意位置
   - 「3. 載入 VRM」：選專案目錄下的任意 `.vrm`（例如 `vrmodels/` 下的任一個）
     - 右側 canvas 顯示 VRM 模型
   - 「4. 載入 VRMA」：選剛剛下載的 `spike-output.vrma`
     - 觀察 log：`VRMAnimationLoaderPlugin` 是否成功解析、`createVRMAnimationClip` 是否回傳 tracks
   - 按「5. 播放驗證」
     - **視覺驗證**：VRM 模型的左右上臂應該以 Z 軸為軸 ±45° 搖動、hip 應該上下搖動 ±10cm
     - 如果只有其中一個動 → 部分成功（需要微調 bone 命名或 track 名稱）
     - 如果兩個都不動 → 失敗

### 要觀察什麼

| 觀察項 | 目標 | 實測後填入 SPIKE-RESULTS.md |
|---|---|---|
| GLTFExporter 輸出 glb | ✓ binary ArrayBuffer | |
| 注入 extension 後的 glb size | ~10KB 級別 | |
| humanBones 對應數 | 20（本 spike 的 bone 數） | |
| VRMAnimationLoaderPlugin 解析 | 不丟錯 | |
| createVRMAnimationClip tracks 數 | > 0 | |
| 視覺：左上臂搖動 | ✓ | |
| 視覺：右上臂搖動 | ✓ | |
| 視覺：hip 上下搖 | ✓ | |

### 失敗應變

| 症狀 | 應變 |
|---|---|
| GLTFExporter 生成的 node 名稱與 VRM bone 名稱不符 | 手動設 `node.extras.originalBoneName`，反查時比對 extras |
| VRMAnimationLoaderPlugin 要求 SkinnedMesh | 在 minimal scene 加一個 1 vertex 的 dummy SkinnedMesh |
| specVersion 不相容 | 嘗試 "1.0" / "1.0-draft" / 查 three-vrm-animation 原始碼 |
| VRM 動但方向錯 | bone rest pose 與 VRM 不符，需要套參考方向（Phase 4 solver 的工作） |
| 完全無法播放 | 保留 `.vad.json` 為唯一輸出，VRMA 匯出推到 v0.5 |

---

## 執行後的下一步

1. 把結果填入 `src/spike/SPIKE-RESULTS.md`
2. 把 SPIKE-RESULTS.md 的內容貼給 Claude Code
3. Claude Code 會根據結果：
   - 若 A + B 都成功 → 進入 **Phase 1：視窗骨架**
   - 若只 A 成功 → 進入 Phase 1，但 VRMA 匯出改為 v0.5 規劃
   - 若只 B 成功 → 評估 PoseLandmarker + HandLandmarker + FaceLandmarker 三合一方案
   - 若都失敗 → 重新評估整個架構
