# 已知問題與教訓 (Lessons Learned)

> **此檔案是 AI 的「錯誤記憶」。**
> 每當 Claude Code 犯錯並被修正後，將錯誤記錄在此。
> 此檔案被 CLAUDE.md 引用（@LESSONS.md），因此每次對話都會載入。
> 
> 格式：日期 + 錯誤描述 + 正確做法 + 受影響的檔案

---

## 架構違規

### [範例] 2026-04-03 — StateMachine 中誤用 Three.js

- **錯誤**：在 `StateMachine.ts` 中 `import { Vector3 } from 'three'` 來計算移動方向
- **正確做法**：StateMachine 是純邏輯模組，不得 import Three.js。使用 `{ x: number, y: number }` 的純資料型別代替 Vector3
- **受影響檔案**：`src/behavior/StateMachine.ts`
- **根因**：Vector3 看起來方便，但引入 Three.js 依賴會破壞純邏輯模組的可測試性

---

## IPC 通訊

### [範例] 2026-04-03 — 直接使用 invoke() 繞過 TauriIPC

- **錯誤**：在 `DragHandler.ts` 中直接 `import { invoke } from '@tauri-apps/api/core'`
- **正確做法**：所有 IPC 呼叫必須透過 `bridge/TauriIPC.ts`，由 TauriIPC 統一處理錯誤和 fallback
- **受影響檔案**：`src/interaction/DragHandler.ts`
- **根因**：直接 invoke 會繞過統一的錯誤處理策略，IPC 失敗時可能中斷 render loop

---

## Rust 後端

<!-- 新增教訓時，在對應分類下加入即可 -->

---

## 效能問題

<!-- 新增教訓時，在對應分類下加入即可 -->

---

## 型別問題

<!-- 新增教訓時，在對應分類下加入即可 -->

---

## 如何新增教訓

當你修正了 Claude Code 的錯誤後，請執行：

```
/log-mistake
```

或手動在對應分類下加入：

```markdown
### [日期] — 一句話描述錯誤

- **錯誤**：Claude Code 做了什麼
- **正確做法**：應該怎麼做
- **受影響檔案**：哪些檔案
- **根因**：為什麼會犯這個錯（幫助 AI 理解「為什麼不能這樣做」）
```
