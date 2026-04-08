# Spike 執行結果記錄

> 執行完 spike 後，請在對應欄位填入結果。完成後把本檔內容貼給 Claude Code 做後續決策。

---

## 環境資訊

- **OS**：_（例：Windows 11 26200）_
- **GPU**：_（例：NVIDIA RTX 4060 / Intel Arc）_
- **Electron 版本**：35.1.2
- **@mediapipe/tasks-vision 版本**：0.10.34
- **@pixiv/three-vrm 版本**：3.4.0
- **執行日期**：_（例：2026-04-08）_

---

## Spike A — MediaPipe HolisticLandmarker

### 測試設定

- **Delegate 偏好**：`GPU` / `CPU`（擇一）
- **實際使用的 delegate**：_（自動降級後的結果）_
- **Init 耗時**：_ ms
- **測試影片**：`人物推動大箱子影片.mp4`
- **影片解析度**：_×_
- **影片時長**：_ s

### 延遲統計

| 指標 | 實測值 | 目標 | 是否通過 |
|---|---|---|---|
| 平均延遲 | _ ms | < 33ms | ☐ |
| p50 延遲 | _ ms | < 33ms | ☐ |
| p95 延遲 | _ ms | < 60ms | ☐ |
| 已處理幀數 | _ | — | — |

### Landmark group 回傳

| Group | 實測點數 | 目標 | 是否通過 |
|---|---|---|---|
| poseLandmarks | _ | 33 | ☐ |
| leftHandLandmarks | _ | 21 | ☐ |
| rightHandLandmarks | _ | 21 | ☐ |
| faceLandmarks | _ | 478（含虹膜） | ☐ |

### Spike A 結論

- [ ] **GPU delegate 可用**
- [ ] **單幀延遲達到 30fps 即時標準**
- [ ] **四個 landmark group 都正常回傳**
- [ ] **手指 landmarks 在身體動作快時仍穩定**
- [ ] **整體可以支撐 Stage 1 即時預覽全身骨架**

**筆記**：
_（在此記錄任何觀察到的特殊狀況，例如：初始化比預期慢、CPU 延遲飆高、某個 landmark group 時有時無等）_

---

## Spike B — VRMA round-trip

### Part 1: 匯出

| 步驟 | 結果 |
|---|---|
| 建 humanoid bone scene | ✓ / ✗ |
| Bone 數量 | _（目標 20）_ |
| GLTFExporter 輸出 glb | ✓ / ✗ |
| glb 原始大小 | _ bytes |
| 注入 extension 後大小 | _ bytes |
| humanBones 對應數 | _（目標 20）_ |
| 下載 spike-output.vrma | ✓ / ✗ |

### Part 2: 讀回驗證

| 步驟 | 結果 |
|---|---|
| 載入的 VRM 模型 | _（檔名）_ |
| VRM humanoid bones | _（數量）_ |
| VRMAnimationLoaderPlugin 解析 | ✓ / ✗ |
| vrmAnimations 數量 | _ |
| createVRMAnimationClip tracks 數 | _ |
| clip duration | _ s |

### Part 3: 視覺驗證（播放後）

| 觀察項 | 結果 |
|---|---|
| 左上臂以 Z 軸 ±45° 搖動 | ✓ / ✗ |
| 右上臂以 Z 軸 ∓45° 搖動 | ✓ / ✗ |
| Hip 上下搖動 ±10cm | ✓ / ✗ |

### Spike B 結論

- [ ] **Part 1 匯出成功**
- [ ] **Part 2 讀回成功**
- [ ] **Part 3 視覺驗證全部正確**
- [ ] **方案 2（GLTFExporter + extension 注入）確認可行**

**筆記**：
_（特別記錄任何需要修正的細節，例如：bone 名稱被 GLTFExporter 改過、必須加 dummy SkinnedMesh、specVersion 字串必須特定值、padding 計算錯誤等）_

---

## 整體結論

- [ ] **✅ A + B 都成功** → 進入 Phase 1：視窗骨架（按原計畫）
- [ ] **⚠ 只 A 成功** → 進入 Phase 1，但 VRMA 匯出延後到 v0.5，MVP 只輸出 .vad.json
- [ ] **⚠ 只 B 成功** → 評估 PoseLandmarker + HandLandmarker + FaceLandmarker 三合一方案
- [ ] **❌ 都失敗** → 需要重新評估整體架構

---

## 需要 Claude Code 協助的問題

_（若 spike 過程中遇到任何需要修正的地方、任何不確定的行為、任何想問的問題，在此列出）_

-
-
-
