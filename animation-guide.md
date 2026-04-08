# 角色動畫系統規範 — animation-guide.md

> 本文件為**唯一權威**的系統動畫檔案命名與載入規範。
> 對應實作：`src/types/animation.ts` / `src/animation/systemAnimationMatcher.ts` / `src/animation/AnimationManager.ts` / `src/main.ts`。

---

## 1. 系統動畫目錄

所有內建系統動畫檔案集中存放於：

```
assets/system/vrma/
```

此目錄於 **軟體啟動時一次性掃描並載入**，不在執行中動態讀取。新增或移除動畫檔後必須重啟程式。

> 使用者自訂動畫（`~/.virtual-assistant-desktop/animations.json` 指定的資料夾）是另一套獨立系統，不在本文件範圍內。

---

## 2. 檔名規範

### 2.1 基本格式

```
SYS_{STATE_PREFIX}_{NN}.vrma
```

| 欄位 | 說明 |
|---|---|
| `SYS_` | 固定前綴，表示系統內建動畫 |
| `{STATE_PREFIX}` | 對應的行為狀態（見第 3 節對照表） |
| `{NN}` | 兩位以上阿拉伯數字編號（建議 `01`、`02`、…、`99`，不限長度） |
| `.vrma` | VRM Animation 格式 |

- **大小寫不敏感**：`SYS_IDLE_01.VRMA` 與 `sys_idle_01.vrma` 皆有效，但**推薦全大寫**以保持一致。
- **編號可不連續**：`SYS_IDLE_01` + `SYS_IDLE_05` 正常運作，掃描時以檔名字典序排序。

### 2.2 檔案範例

```
assets/system/vrma/
├── SYS_IDLE_01.vrma
├── SYS_IDLE_02.vrma
│   ...
├── SYS_IDLE_20.vrma        ← 多支 idle 可隨機連續播放
├── SYS_SIT_01.vrma
│   ...
├── SYS_SIT_11.vrma
├── SYS_WALK_01.vrma
│   ...
├── SYS_WALK_06.vrma
├── SYS_DRAGGING_01.vrma    ← 注意：drag 狀態對應 DRAGGING
├── SYS_DRAGGING_02.vrma
├── SYS_HIDE_01.vrma
├── SYS_PEEK_01.vrma        ← 探頭動畫，runtime mirror 左右
└── SYS_FALL_01.vrma        ← （目前無檔，空池時不播）
```

---

## 3. 狀態對照表

| 行為狀態 | 檔案前綴 | 說明 | 播放策略 |
|---|---|---|---|
| `idle` | `IDLE` | 待機（站立發呆） | LoopOnce + finished 事件接力下一支 |
| `sit` | `SIT` | 坐下 | LoopRepeat，進入狀態時隨機挑一支 |
| `walk` | `WALK` | 行走 | LoopRepeat，進入狀態時隨機挑一支 |
| `drag` | `DRAGGING` | 被拖曳中 | LoopRepeat，進入狀態時隨機挑一支 |
| `peek` | `PEEK` | 探頭（躲在視窗後面） | LoopOnce + clamp（runtime mirror 左右） |
| `fall` | `FALL` | 從吸附處墜落 | LoopOnce + clamp |
| `hide` | `HIDE` | 移動到 peek 的過程 | LoopRepeat，進入狀態時隨機挑一支 |

> 權威來源：`src/types/animation.ts` 中的 `SYSTEM_STATE_FILE_PREFIX` 常數。修改對照表必須同步此檔。

---

## 4. 載入流程

```
程式啟動
  ↓
main.ts: loadAllSystemAnimations()
  ↓
ipc.scanVrmaFiles('assets/system/vrma/')  ← 掃一次取得所有 .vrma 清單
  ↓
for each state in SYSTEM_ANIMATION_STATES:
  ├─ filterFilesByState(allFiles, state)   ← regex 過濾
  ├─ for each file: vrmController.loadVRMAnimation(url)
  └─ animationManager.setStatePool(state, clips)
  ↓
peek 池特殊處理：
  └─ mirrorAnimationClip(peekClip, boneMapping) → setPeekLeftClips()
```

每個狀態都有獨立的 `clips[]`，`playStateRandom(state)` 從中隨機挑一支播放。

---

## 5. 播放策略（每狀態）

配置來源：`src/types/animation.ts` 中的 `SYSTEM_STATE_PLAY_CONFIG`。

| 狀態 | `loop` | `fadeDuration` (秒) | `clampWhenFinished` | 備註 |
|---|---|---|---|---|
| `idle` | `false` | 0.7 | `true` | LoopOnce，finished 事件觸發下一支 idle（接力） |
| `sit` | `true` | 1.5 | — | 站姿→坐姿差異大，用最長 crossfade |
| `walk` | `true` | 0.3 | — | 快速反應 |
| `drag` | `true` | 0.3 | — | 快速反應 |
| `peek` | `false` | 0.5 | `true` | 由 StateMachine 以 clip duration 決定停留時間 |
| `fall` | `false` | 0.3 | `true` | 短暫動畫 |
| `hide` | `true` | 0.3 | — | 與 walk 策略相同（也是移動中） |

---

## 6. 特殊機制

### 6.1 idle 連續播放（接力機制）

`idle` 狀態以 LoopOnce 播放 **一支完整的動畫**，播完後由 `mixer` 的 `finished` 事件觸發 `playNextIdle()` 隨機接下一支。這讓每支 idle 動畫都能完整呈現，不會在中途被切斷。

實作位置：`AnimationManager.onAnimationFinished`。

### 6.2 peek 左右鏡像（runtime mirror）

探頭動畫需要左右兩個方向，但磁碟上只保留**右側**版本（`SYS_PEEK_NN.vrma`）。

載入流程：
1. 掃描 `SYS_PEEK_*.vrma` → 存入 `statePools.get('peek')`（右側池）
2. 讀取 VRM 模型的 humanoid bone mapping
3. 對每支 peek clip 呼叫 `mirrorAnimationClip(clip, boneMapping)` → 存入 `peekLeftClips`（左側池）
4. 播放時由 `BehaviorAnimationBridge` 根據 `peekSide` 傳入 `playStateRandom('peek', side)` 自動選取對應池

若 VRM 模型無 humanoid bone mapping（非標準 VRM 骨架），左側鏡像池為空，`playStateRandom('peek', 'left')` 會退回右側池並 log warning。

實作位置：`main.ts: loadAllSystemAnimations` peek 區塊；`AnimationManager.playStateRandom`。

### 6.3 walk / hide 的 per-clip 步伐重分析

`walk` 與 `hide` 是移動狀態，`StateMachine` 依賴 `moveSpeed` 推進角色位置。若所有 walk clip 的步伐長度 / 週期不同，用固定速度會造成「腳在原地打滑」或「腳跟拖地」。

解決方案：**每次切換 walk/hide 動畫時重新分析該 clip 的步伐**，動態更新 StateMachine 的移動速度。

流程：
```
BehaviorAnimationBridge.update() 偵測狀態轉換
  ↓
am.playStateRandom('walk') → 回傳 picked entry
  ↓
onWalkClipPicked(picked.clip) callback（由 SceneManager 注入）
  ↓
analyzeWalkAnimation(clip, vrmController) → { stepLength, cycleDuration, worldSpeed }
  ↓
sceneManager.setStepAnalysis(stepLength, worldSpeed)
  ↓
StateMachine 下一幀使用新的移動速度
```

實作位置：`BehaviorAnimationBridge.update`、`main.ts: initializeBehaviorSystem` 內的 callback 注入。

### 6.4 使用者動畫優先級

系統動畫（`assets/system/vrma/`）與使用者動畫（`animations.json`）並存：

- **idle 狀態**：系統 idle 池優先；若池為空才 fallback 到使用者 idle 分類
- **其他狀態**：純系統動畫，不會 fallback 到使用者動畫
- **使用者觸發的 action**：從右鍵選單選取的使用者 action 動畫會 **覆蓋** 任何系統動畫；播完後回到 idle 池

---

## 7. 新增一支動畫（操作流程）

### 情境 A：為現有狀態新增一支 variant

1. 將 `.vrma` 檔放入 `assets/system/vrma/`，檔名遵循 `SYS_{PREFIX}_{NN}.vrma` 格式
2. 編號取目前最大值 +1（或任意未使用編號）
3. 重啟程式
4. 啟動 log 會顯示：`[sys-anim] pool '{state}' loaded: N clips`

**範例**：新增一支 idle 動畫
```
assets/system/vrma/SYS_IDLE_21.vrma   ← 新增
# 重啟程式後，idle 池從 20 → 21 支
```

### 情境 B：為 `fall` 等目前無檔案的狀態補檔

1. 製作 `SYS_FALL_01.vrma`（建議 1–2 秒的 LoopOnce 動畫）
2. 放入 `assets/system/vrma/`
3. 重啟程式 → `[sys-anim] pool 'fall' loaded: 1 clips`

無需修改任何 code。

---

## 8. 新增一個全新的狀態（開發者流程）

例如：想新增「喝茶」狀態 `tea`。

1. **`src/types/behavior.ts`**：在 `BehaviorState` 加入 `'tea'`
2. **`src/types/animation.ts`**：
   - `SystemAnimationState` 加入 `'tea'`
   - `SYSTEM_STATE_FILE_PREFIX.tea = 'TEA'`
   - `SYSTEM_ANIMATION_STATES` 陣列加入 `'tea'`
   - `SYSTEM_STATE_PLAY_CONFIG.tea = { loop: true, fadeDuration: 1.0, clampWhenFinished: false }`
3. **`src/behavior/BehaviorAnimationBridge.ts`**：`STATE_TO_POOL.tea = 'tea'`
4. **`src/behavior/StateMachine.ts`**：加入狀態轉移邏輯
5. **`assets/system/vrma/`**：放入 `SYS_TEA_01.vrma`（以及更多 variants）
6. **`tests/unit/systemAnimationMatcher.test.ts`**：加入對應測試
7. **本文件**：第 3 節對照表加入新狀態
8. 重啟程式

---

## 9. 已知限制與降級行為

| 情況 | 行為 |
|---|---|
| `SYS_IDLE_*` 池為空 | fallback 到使用者 idle 分類；若無使用者動畫則使用 `FallbackAnimation`（呼吸+眨眼） |
| `SYS_WALK_*` 池為空 | walk 狀態無動畫（T-pose 滑行），log warning |
| `SYS_SIT_*` 池為空 | sit 狀態無動畫，log warning |
| `SYS_FALL_*` 池為空 | fall 狀態無動畫（瞬間過渡），log warning |
| `SYS_HIDE_*` 池為空 | hide 狀態無動畫，log warning |
| `SYS_PEEK_*` 池為空 | peek 狀態無動畫 |
| VRM 模型無 humanoid bone mapping | peek 左側鏡像失敗，左右 peek 皆用右側池 |
| 檔案解析失敗（壞檔） | 跳過該檔並 log warning，不影響其他動畫 |

---

## 10. 對應原始碼索引

| 檔案 | 職責 |
|---|---|
| `src/types/animation.ts` | 型別定義、檔名前綴表、播放策略表 |
| `src/animation/systemAnimationMatcher.ts` | 純函式：檔名 regex 產生、過濾、反查 |
| `src/animation/AnimationManager.ts` | `setStatePool` / `playStateRandom` / `stopStateAnimation` / idle 接力機制 |
| `src/animation/StepAnalyzer.ts` | `analyzeWalkAnimation` 計算步伐長度與世界速度 |
| `src/animation/AnimationMirror.ts` | `mirrorAnimationClip` 左右骨骼翻轉 |
| `src/behavior/BehaviorAnimationBridge.ts` | 狀態→池映射、peek side 選擇、walk/hide callback |
| `src/main.ts: loadAllSystemAnimations` | 啟動時一次性掃描與載入 |
| `src/core/SceneManager.ts` | Bridge callback 注入、cinematic 直接呼叫 playStateRandom |
| `tests/unit/systemAnimationMatcher.test.ts` | 檔名辨識測試（21 tests） |
| `tests/unit/BehaviorAnimationBridge.test.ts` | Bridge 狀態轉換測試（11 tests） |

---

_最後更新：2026-04-08_
