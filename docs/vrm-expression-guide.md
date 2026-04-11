# VRM 表情實務指南

> **對應模組**：`src/expression/ExpressionManager.ts`
> **工具**：`pnpm scan:expressions`（`scripts/scan-vrm-expressions.mjs`）
> **最後更新**：2026-04-11（基於 74 個 VRM 模型的掃描結果）

---

## 1. 目的

本文件紀錄跨多個 VRM 模型使用表情系統時的實務觀察與設計建議。主要解決以下問題：

1. **哪些表情是真正「通用」** — 可以假設「任何 VRM 模型都有」
2. **哪些表情雖然存在但不應該被自動輪播** — 例如 lip-sync 嘴型、服裝切換
3. **不同模型間的命名不一致如何處理** — 例如 `Surprised` vs `surprised`
4. **ExpressionManager 的優先級策略如何對應表情覆蓋率**

## 2. 掃描結果彙整（v1 — 74 模型）

使用 `pnpm scan:expressions` 對 `vrmodels/` 下 74 個有表情的 VRM 0.x 模型進行掃描（11 個無表情模型已於 2026-04-11 清除）。

### 2.1 跨模型交集（**100% 通用**）

**13 個表情，74/74 模型都有**：

```
情緒 (VRM 0.x preset)：
  neutral, joy, angry, sorrow, fun

嘴型 (lip-sync)：
  a, i, u, e, o

眨眼：
  blink, blink_l, blink_r
```

### 2.2 幾乎通用（70/74）

4 個**視線方向**表情，70 個模型有：

```
lookup, lookdown, lookleft, lookright
```

**缺少的 4 個模型**：`Feixiao.vrm`, `Mizuki.vrm`, `Purple_Heart.vrm`, `w.vrm`
→ 這些模型無法做視線引導動作。

### 2.3 常見自訂表情（覆蓋率排行）

| 次數 | 表情名稱 | 備註 |
|---|---|---|
| 24 | `Surprised` | 常見驚訝表情 |
| 21 | `-_-` | 半閉眼、無語 |
| 18 | `hehe` | 偷笑 |
| 12 | `chill` | 輕鬆 |
| 11 | `Confused` | 困惑 |
| 11 | `hah` | 大笑 |
| 11 | `Tongue` | 吐舌 |
| 11 | `XP` | 閉眼笑 |
| 10 | `hmpf` | 不屑 |
| 10 | `X` | |
| 7 | `XP1`, `XP2`, `XP3`, `hehe2` | 變體 |
| 6 | `What`, `hah2` | |
| 5 | `Sad`, `wow`, `woow`, `Wicked`, `XD`, `confused_a/b/c`, `LOVE`, `STAR`, `sadly`, `cheek`, `Hmpf`, `Surprised2` | |

### 2.4 ARKit / VTuber 全套（7 模型）

7 個 ElsieEstuary 相關模型共用一套 **104 個 ARKit-style / VRChat 擴充表情**：

```
Jaw_*, Mouth_*, Tongue_*, Cheek_*, Eye_*, Brow*, MouthSmile*, ...
```

這些對 ExpressionManager 沒有意義（都是底層 blendshape，不是語義化表情），**應整組排除在自動輪播外**。

### 2.5 服裝切換「偽表情」

有些模型把服裝切換放在 blendShapeGroup 中：

| 表情名稱 | 所在模型 | 實際作用 |
|---|---|---|
| `ToggleCoat` | `Dusk.vrm` | 切換外套 |
| `ToggleWP` | `Luna.vrm` | 切換武器 |

→ 這些**絕對不能被自動表情輪播觸發**，否則角色衣物會亂跳。

---

## 3. 大小寫不一致（潛在 bug 源）

掃描發現多個語義相同但大小寫不同的命名，當作不同表情處理會造成覆蓋率統計失真：

| 概念 | 小寫版 | 大寫版 | 建議 |
|---|---|---|---|
| 驚訝 | `surprised` (3) | `Surprised` (24) | Normalize 為小寫 |
| 困惑 | `confused` (1) | `Confused` (11) | Normalize 為小寫 |
| 微笑 | `smile` (1) | `Smile` (2) | Normalize 為小寫 |
| 偷笑 | `hehe` (18) | `Hehe` (2) | Normalize 為小寫 |
| 不屑 | `hmpf` (10) | `Hmpf` (5) | Normalize 為小寫 |
| 什麼 | `what` (1) | `What` (6) | Normalize 為小寫 |

**實作提示**：跨模型表情挑選邏輯（例如「隨機選一個通用表情」）應該先把 `getBlendShapes()` 結果做 `name.toLowerCase()` 統一再比對，避免 `Feixiao.vrm` 有 `surprised` 但被 `Surprised` 比對漏掉。

---

## 4. Tier-based 安全表情策略（建議）

ExpressionManager 的 `setAllowedAutoExpressions` 設計時，建議採用三層覆蓋率分級：

### Tier 1 — 100% 安全（自動輪播主力）

```
joy, angry, sorrow, fun
```

**4 個情緒表情**，所有 74 個模型都有。加上 `neutral` 作為預設回歸狀態（不輪播，只用於「停止表情」）。

### Tier 2 — 幾乎通用（視線引導）

```
lookup, lookdown, lookleft, lookright
```

**4 個視線方向**，70/74 模型有。用於 idle 時讓角色看向不同方向，增加生動感。對缺少這些的 4 個模型，ExpressionManager 應自動降級回 Tier 1。

### Tier 3 — 常見自訂（case-insensitive 比對）

```
surprised, hehe, confused, chill, hah, hmpf, -_-
```

**7 個高頻自訂表情**，至少 10/74 模型有。這層應：
1. 用 **case-insensitive** 比對模型現有表情
2. 只在模型確實有時才加入 allowlist
3. 每次載入新模型時重新決定 Tier 3 成員

### ⛔ 絕對不要放進 allowlist

| 類別 | 範例 | 原因 |
|---|---|---|
| Lip-sync 嘴型 | `a`, `i`, `u`, `e`, `o` | 應由 lip-sync 系統控制 |
| 眨眼 | `blink`, `blink_l`, `blink_r` | 應由眨眼系統控制 |
| 服裝切換 | `ToggleCoat`, `ToggleWP` | 會讓衣物亂跳 |
| ARKit 擴充 | `Jaw_*`, `Mouth_*`, `Tongue_*`, `Eye_*`, `Brow*`, `Cheek_*` | 底層 blendshape，非語義表情 |
| 視線底層 | `EyeLookInLeft` 等 ARKit 眼動 | 用 Tier 2 的 `lookup/down/left/right` 代替 |

### 預設 allowlist 生成邏輯（推薦虛擬碼）

```ts
function computeDefaultAutoExpressionAllowlist(
  available: string[],
): string[] {
  const lower = new Map(available.map((n) => [n.toLowerCase(), n]));

  const tier1 = ['joy', 'angry', 'sorrow', 'fun'];
  const tier2 = ['lookup', 'lookdown', 'lookleft', 'lookright'];
  const tier3 = ['surprised', 'hehe', 'confused', 'chill', 'hah', 'hmpf', '-_-'];

  const allowlist: string[] = [];
  for (const name of [...tier1, ...tier2, ...tier3]) {
    const actual = lower.get(name);
    if (actual) allowlist.push(actual); // 保留原始 case
  }
  return allowlist;
}
```

---

## 5. 如何重跑分析

專案內建工具 `pnpm scan:expressions`：

```bash
pnpm scan:expressions                    # 完整報告（預設 vrmodels/）
pnpm scan:expressions -- --duplicates    # 只顯示重複表情排行
pnpm scan:expressions -- --json          # JSON 輸出（供腳本處理）
pnpm scan:expressions -- custom/folder   # 指定其他目錄
```

掃描結果可用於：

- 新增模型後驗證其表情是否符合 Tier 1/2/3 標準
- 確認 case-insensitive normalize 後的 Tier 3 實際覆蓋率
- 找出 outlier 模型（例如只有 13 個表情、缺 look\* 的）
- 偵測新的 toggle 偽表情（名稱含 Toggle/WP/Coat 等）

**注意**：工具只解析 GLB header 的 JSON chunk，不載入 BIN，速度快但**無法取得 blendshape 的實際權重資料**；若要驗證「表情是否真的改變臉部」需要實際載入模型。

---

## 6. 已知特殊情況

### 6.1 完全無表情的模型（已清除）

2026-04-11 前掃描到 11 個模型完全沒有表情（`blendShapeGroups` 為空陣列或不存在）：

```
Cocoria, DreamSeeker, Guinaifen, Herrscher_of_Finality, Jiangyu,
Lenna, QiongJiu, Sabrina, Topaz_ReUp, jingliu_hsr, shorekeeper_wuwa
```

這些模型已從 `vrmodels/` 刪除（非 git 追蹤）。未來若再發現類似情況，ExpressionManager 應：

1. `setAvailableExpressions([])` 時自動 disable 自動輪播
2. 托盤選單「表情」子選單顯示「（此模型無表情）」或灰掉

### 6.2 獨特表情（1 模型專用）

9 個只存在於單一模型的表情，**不應納入跨模型策略**：

```
Ou           @ Alice.vrm
AA, AA2      @ Daitaku_Helios.vrm
confused     @ Female_Rover.vrm    (注意：其他模型都是大寫 Confused)
smile        @ Gentildonna.vrm
what         @ Nefer.vrm
rar          @ Zibai.vrm
ToggleCoat   @ Dusk.vrm            ← 服裝切換
ToggleWP     @ Luna.vrm            ← 服裝切換
```

---

## 7. 相關參考

- **SPEC.md §2.3** — 表情系統功能定義
- **ARCHITECTURE.md §2.2** — ExpressionManager 模組設計
- **CLAUDE.md** — 專案整體規範
- **`src/expression/ExpressionManager.ts`** — 實作
- **`src/types/config.ts`** — `allowedAutoExpressions` 欄位
- **`scripts/scan-vrm-expressions.mjs`** — 掃描工具

---

_本文件基於實測資料產生，當模型集合變動（新增/刪除模型）時應重跑 `pnpm scan:expressions` 更新統計數據。_
