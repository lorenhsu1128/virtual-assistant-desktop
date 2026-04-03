---
name: dev-auto
description: 一鍵啟動完整開發流水線。自動執行：讀取教訓 → 規劃 → [人工確認] → 建立模組 → 撰寫程式碼 → 測試 → 效能檢查 → 程式碼審查 → 文件同步 → 提交。規劃確認後全程自動。
argument-hint: "[task description]"
user-invocable: true
---

你是開發流水線的指揮官。使用者透過 $ARGUMENTS 描述一個開發任務，你將自動執行完整的開發流程。

**關鍵原則：計劃需要人工確認，確認後全部自動執行到底，中間不再詢問。**

---

## Phase 1: 規劃（需人工確認）

### 1.1 讀取教訓

讀取 LESSONS.md，找出與本次任務相關的教訓。摘要列出。

### 1.2 分析任務

根據 SPEC.md 和 ARCHITECTURE.md，分析：
- 此任務涉及哪些模組（新增 / 修改）
- 每個模組所屬的層（Rust / TypeScript / Svelte）
- 模組間的依賴順序（先建底層，再建上層）
- 需要注意的模組邊界規則
- 需要同步的 IPC 介面和型別定義

### 1.3 產出開發計劃

輸出結構化的開發計劃：

```
═══════════════════════════════════════════════════
  開發計劃 — {任務描述}
═══════════════════════════════════════════════════

⚠️ 相關教訓：
  • [2026-04-05] StateMachine 不可 import three
  
📋 開發步驟（將按此順序自動執行）：

  Step 1 — 建立型別定義
    檔案：src/types/collision.ts
    內容：CollisionResult, Region 介面

  Step 2 — 建立 Rust command（如需要）
    檔案：src-tauri/src/commands/window_commands.rs
    內容：新增 get_window_list command

  Step 3 — 更新 TauriIPC bridge（如需要）
    檔案：src/bridge/TauriIPC.ts
    內容：新增 getWindowList wrapper

  Step 4 — 建立核心模組
    檔案：src/behavior/CollisionSystem.ts
    內容：AABB 碰撞檢測、吸附判定、遮擋計算

  Step 5 — 建立測試
    檔案：tests/unit/CollisionSystem.test.ts
    內容：碰撞判定、邊界條件、吸附閾值測試

  Step 6 — 整合到 SceneManager
    檔案：src/core/SceneManager.ts
    內容：在 render loop 的正確位置呼叫 CollisionSystem

🚧 注意事項：
  • CollisionSystem 不可直接操作 3D 物件
  • 碰撞結果透過純資料 CollisionResult 傳遞
  • render loop 順序：StateMachine → CollisionSystem → AnimationManager

📝 完成後自動執行：
  • 所有測試
  • ESLint + Clippy
  • 效能檢查
  • 程式碼審查
  • 文件同步
  • Git commit

═══════════════════════════════════════════════════
  確認此計劃後，將自動執行所有步驟。
  輸入 "ok" 或 "確認" 開始。
  輸入修改建議則調整計劃後重新確認。
═══════════════════════════════════════════════════
```

### 1.4 等待確認

**這是整個流程中唯一的人工確認點。**

- 使用者回覆 "ok" / "確認" / "go" / "開始" → 進入 Phase 2
- 使用者提出修改意見 → 調整計劃 → 重新輸出計劃 → 再次等待確認

---

## Phase 2: 自動執行（確認後不再中斷）

按照計劃中的步驟順序，自動執行每一步。

### 執行規則

1. **每完成一個 Step，輸出簡短進度**：
   ```
   ✅ Step 1/6 — src/types/collision.ts 已建立
   ✅ Step 2/6 — get_window_list command 已新增
   🔄 Step 3/6 — 更新 TauriIPC.ts...
   ```

2. **每個 Step 內部自動處理**：
   - 建立檔案（套用對應 Skill 的模板和規範）
   - 加入 JSDoc / rustdoc 註解
   - 遵循模組邊界規則（讀取 .claude/rules/ 中的規則）
   - 確保型別一致（Rust ↔ TypeScript）

3. **遇到錯誤時不中斷，標記並繼續**：
   ```
   ⚠️ Step 4/6 — CollisionSystem.ts 編譯有 2 個型別錯誤
     → 自動修正中...
   ✅ Step 4/6 — 已修正，編譯通過
   ```

4. **如果某個錯誤無法自動修正**：
   - 完成所有能完成的步驟
   - 在最終報告中列出需要人工介入的問題
   - 不在中間停下來問使用者

---

## Phase 3: 自動驗證

所有開發步驟完成後，依序執行：

### 3.1 單元測試
```bash
pnpm test
```
如果測試失敗，自動修正後重跑（最多嘗試 3 次）。

### 3.2 TypeScript 檢查
```bash
npx tsc --noEmit
```
如果有型別錯誤，自動修正。

### 3.3 ESLint
```bash
pnpm lint
```
如果有 lint 錯誤，自動修正（`pnpm lint --fix`）。

### 3.4 Rust Clippy（如果有修改 .rs）
```bash
cargo clippy -- -D warnings
```
如果有警告，自動修正。

### 3.5 效能檢查

執行 /check-perf 的邏輯：
- 搜尋 setInterval 濫用
- 搜尋 unwrap()
- 搜尋模組邊界違規
- 搜尋 any 型別

### 3.6 型別同步檢查

執行 /sync-types 的邏輯：
- 比對 Rust struct 和 TypeScript interface

---

## Phase 4: 自動收尾

### 4.1 程式碼審查

執行 code-reviewer agent 的邏輯：
- 架構合規性
- 模組邊界
- 程式碼品質

### 4.2 文件同步

執行 /doc-sync 的邏輯：
- 掃描新增 / 修改的模組
- 如果 CLAUDE.md 中的目錄結構需要更新，自動更新
- 如果有新的 IPC 介面，確認文件已記錄

### 4.3 Git Commit

如果所有驗證通過：
```bash
git add -A
git commit -m "{conventional commit message}"
```

Commit message 格式：
- `feat({module}): {描述}` — 新功能
- `fix({module}): {描述}` — 修復
- `refactor({module}): {描述}` — 重構

---

## 最終報告

```
═══════════════════════════════════════════════════
  開發完成報告 — {任務描述}
═══════════════════════════════════════════════════

📁 建立 / 修改的檔案：
  ✅ src/types/collision.ts（新增）
  ✅ src/behavior/CollisionSystem.ts（新增）
  ✅ src/bridge/TauriIPC.ts（修改，+2 methods）
  ✅ tests/unit/CollisionSystem.test.ts（新增，12 tests）
  ✅ src/core/SceneManager.ts（修改，整合 CollisionSystem）

🧪 測試：24/24 通過
📝 Lint：ESLint ✅  Clippy ✅
⚡ 效能：無違規
🔍 審查：✅ 通過
📄 文件：CLAUDE.md 已更新目錄結構
📦 Commit：feat(collision): 實作 AABB 碰撞判定系統

⚠️ 需注意事項：（如果有的話）
  • 無

═══════════════════════════════════════════════════
```

---

## 異常處理

### 如果測試反覆失敗（3 次修正後仍失敗）
- 標記為需人工介入
- 繼續完成其他步驟
- 在最終報告中列出

### 如果遇到架構決策不確定
- 依據 SPEC.md 和 ARCHITECTURE.md 做決策
- 在最終報告中標註「自動決策」供使用者複查

### 如果 LESSONS.md 中有直接相關的教訓
- 在開發過程中主動遵循
- 在最終報告中標註「已依據教訓 X 避開陷阱」
