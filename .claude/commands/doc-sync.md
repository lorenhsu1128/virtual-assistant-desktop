---
name: doc-sync
description: 掃描目前的程式碼結構，比對 CLAUDE.md、Skills、型別定義，找出過時或遺漏的文件內容，並提供更新建議。開發告一段落後執行。
user-invocable: true
---

掃描目前專案的實際程式碼狀態，與各文件進行比對，找出不一致之處。

## 掃描步驟

### 1. 目錄結構 vs CLAUDE.md

掃描 `src/` 和 `src-tauri/src/` 的實際檔案結構：

```bash
find src/ -name "*.ts" -type f | sort
find src-tauri/src/ -name "*.rs" -type f | sort
find src-settings/ -name "*.svelte" -type f | sort
```

比對根目錄 `CLAUDE.md` 中「關鍵目錄結構」章節：
- 列出文件中提到但程式碼中不存在的模組（已移除？）
- 列出程式碼中存在但文件未提到的模組（新增後忘記更新？）

### 2. IPC 介面 vs 文件

掃描 Rust 側所有 `#[command]` 定義：

```bash
grep -rn "#\[command\]" src-tauri/src/ --include="*.rs" -A 2
```

掃描 TypeScript 側 TauriIPC 中所有 wrapper：

```bash
grep -n "invoke<\|listen<" src/bridge/TauriIPC.ts
```

比對：
- Rust 有但 TauriIPC 沒有的 command（忘記同步前端？）
- TauriIPC 有但 Rust 沒有的 command（已移除但前端未清理？）

### 3. 型別定義一致性

掃描 `src/types/` 的所有 interface/type：

```bash
grep -n "export interface\|export type" src/types/*.ts
```

掃描 Rust 側對應的 struct/enum：

```bash
grep -n "pub struct\|pub enum" src-tauri/src/**/*.rs
```

列出不一致之處。

### 4. 測試覆蓋

掃描 `tests/` 下的測試檔案：

```bash
find tests/ -name "*.test.ts" -type f | sort
```

比對 `src/` 下的模組：
- 列出有模組但沒有測試的情況

### 5. LESSONS.md 相關性檢查

讀取 LESSONS.md 中提到的「受影響檔案」：
- 如果檔案已被移除或重構，標記該教訓可能需要更新

## 輸出格式

```
═══════════════════════════════════
  文件同步檢查報告
═══════════════════════════════════

📁 目錄結構
  ✅ CLAUDE.md 中的 14 個模組都存在
  ⚠️ 新增模組未記錄：
    - src/behavior/WanderStrategy.ts（建議加入 CLAUDE.md 目錄結構）

🔌 IPC 介面
  ✅ 10 個 commands 兩側一致
  ⚠️ Rust 側有但前端缺少：
    - get_display_list（src-tauri/src/commands/window_commands.rs:45）

📐 型別定義
  ✅ 5 個型別兩側一致
  ⚠️ TypeScript 新增但 Rust 未對應：
    - DisplayInfo（src/types/window.ts:15）

🧪 測試覆蓋
  ⚠️ 缺少測試：
    - src/behavior/WanderStrategy.ts → 無對應測試

📝 LESSONS.md
  ✅ 8 條教訓都與現有程式碼相關

═══════════════════════════════════
  摘要：4 個待更新項目
═══════════════════════════════════
```

## 自動修正

對每個發現的不一致，詢問使用者是否要自動修正：

- **目錄結構不一致** → 更新 CLAUDE.md 中的目錄結構描述
- **IPC 不一致** → 呼叫 `/add-ipc` 或 `/sync-types` 修正
- **缺少測試** → 呼叫對應 Skill 建立測試腳手架
- **LESSONS.md 過時** → 標記過時教訓，詢問是否移除
