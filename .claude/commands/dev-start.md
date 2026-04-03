---
name: dev-start
description: 開始新開發任務前的準備清單。讀取 LESSONS.md 中的相關教訓、確認文件是否最新、提示可能的陷阱。
argument-hint: "[task description]"
user-invocable: true
---

開始新開發任務前，執行以下準備步驟：

## 1. 讀取相關教訓

根據 $ARGUMENTS 描述的任務，從 LESSONS.md 中找出相關的教訓：

- 如果任務涉及 StateMachine → 找「架構違規」分類中的相關記錄
- 如果任務涉及 IPC → 找「IPC 通訊」分類中的相關記錄
- 如果任務涉及 Rust → 找「Rust 後端」分類中的相關記錄
- 如果任務涉及新模組 → 找所有分類中與模組邊界相關的記錄

向使用者摘要：
```
⚠️ 相關教訓提醒：
  1. [2026-04-05] StateMachine 中不可 import Three.js
  2. [2026-04-08] IPC 呼叫必須透過 TauriIPC
```

如果沒有相關教訓，回報：`✅ 無相關教訓記錄`

## 2. 文件新鮮度檢查

快速掃描：

```bash
# 最近修改的原始碼
find src/ src-tauri/src/ -name "*.ts" -o -name "*.rs" -newer CLAUDE.md | head -20
```

如果有很多檔案比 CLAUDE.md 新 → 提醒「CLAUDE.md 可能需要更新，建議先執行 /doc-sync」

## 3. 任務規劃

基於任務描述，輸出：
- 預計會動到的模組列表
- 需要注意的模組邊界規則
- 建議使用的 Skills
- 預計需要同步更新的文件（CLAUDE.md、types/、TauriIPC 等）

## 輸出格式

```
═══════════════════════════════════
  開發任務準備 — {任務描述}
═══════════════════════════════════

⚠️ 相關教訓：
  1. [2026-04-05] StateMachine 中不可 import Three.js

📁 預計涉及的模組：
  - src/behavior/StateMachine.ts（修改）
  - src/behavior/CollisionSystem.ts（新增）
  - src/types/behavior.ts（新增）
  - tests/unit/CollisionSystem.test.ts（新增）

🚧 注意事項：
  - StateMachine 不可 import 'three'
  - CollisionSystem 的碰撞結果透過純資料傳遞

📚 建議使用 Skills：
  - state-machine / ts-frontend-module / vitest-unit

📝 完成後需同步更新：
  - CLAUDE.md 目錄結構
  - 如犯錯 → /log-mistake

═══════════════════════════════════
  準備完成，可以開始開發
═══════════════════════════════════
```
