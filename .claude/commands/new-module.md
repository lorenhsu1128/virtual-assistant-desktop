---
name: new-module
description: 建立新模組的完整腳手架，包含原始碼、型別定義、測試檔案。支援 Rust / TypeScript / Svelte 三種層級。
argument-hint: "[layer: rust|ts|svelte] [name]"
user-invocable: true
---

根據指定的層級（$ARGUMENTS 的第一個參數）和名稱（第二個參數），建立完整的模組腳手架。

## 當 layer = rust 時

建立以下檔案：

1. `src-tauri/src/{name}.rs` — 功能模組（如果是獨立功能）
2. `src-tauri/src/commands/{name}_commands.rs` — Command handler
3. 更新 `src-tauri/src/commands/mod.rs` — 加入 `pub mod {name}_commands;`
4. 更新 `src-tauri/src/main.rs` — 在 invoke_handler 中註冊新 commands

每個檔案必須包含：
- 完整 rustdoc 註解
- 所有 command 回傳 `Result<T, String>`
- 無 `unwrap()`

完成後執行 `cargo check` 確認編譯通過。

## 當 layer = ts 時

先詢問使用者模組所屬目錄（core / animation / expression / behavior / interaction）。

建立以下檔案：

1. `src/{category}/{Name}.ts` — 模組主檔案，包含 class 定義和 JSDoc
2. `src/types/{name}.ts` — 共用型別定義（如果需要新型別）
3. `tests/unit/{Name}.test.ts` — Vitest 測試檔案（含基礎 describe/it 結構）

每個檔案必須包含：
- 完整 JSDoc 註解
- 依賴透過建構子注入
- 嚴格模式相容（無 any）

完成後執行 `npx tsc --noEmit` 確認型別檢查通過。

## 當 layer = svelte 時

建立以下檔案：

1. `src-settings/pages/{Name}Page.svelte` — 設定頁面元件

包含基礎結構：script（含 onMount）、HTML 模板、style。

完成後提醒使用者需要在 App.svelte 中加入導航項目。
