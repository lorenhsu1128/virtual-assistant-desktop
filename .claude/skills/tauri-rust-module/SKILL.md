---
name: tauri-rust-module
description: 在 src-tauri/src/ 新增 Rust 後端模組。用於建立 Tauri command handler、系統功能模組、Windows API 封裝等 Rust 側開發任務。
---

## 新增 Rust 模組流程

### 使用時機

- 新增 Tauri command（前端呼叫 Rust 的函式）
- 新增系統功能模組（視窗感知、檔案管理、音訊擷取等）
- 封裝 Windows API 呼叫

### 輸入需求

- 模組名稱（snake_case）
- 模組職責描述
- 需要的 Tauri commands 清單（名稱 + 參數 + 回傳）

### 步驟

1. **建立模組檔案**
   - 功能模組 → `src-tauri/src/{module_name}.rs`
   - Command handler → `src-tauri/src/commands/{module_name}_commands.rs`

2. **在 mod.rs 中註冊**
   - 在 `src-tauri/src/commands/mod.rs` 加入 `pub mod {module_name}_commands;`

3. **在 main.rs 中註冊 commands**
   ```rust
   .invoke_handler(tauri::generate_handler![
       // ...existing commands...
       commands::{module_name}_commands::{command_name},
   ])
   ```

4. **實作 command handler**
   ```rust
   use tauri::command;

   /// {功能描述}
   ///
   /// # 參數
   /// - `{param}`: {描述}
   ///
   /// # 回傳
   /// {回傳描述}
   ///
   /// # 錯誤
   /// {錯誤描述}
   #[command]
   pub async fn {command_name}({params}) -> Result<{ReturnType}, String> {
       // 實作邏輯，使用 ? 傳遞錯誤
       let result = do_something().map_err(|e| e.to_string())?;
       Ok(result)
   }
   ```

5. **同步更新前端型別**
   - 在 `src/types/` 新增或更新對應的 TypeScript interface
   - 在 `src/bridge/TauriIPC.ts` 新增 typed wrapper

6. **執行驗證**
   ```bash
   cargo check
   cargo clippy -- -D warnings
   cargo test
   ```

### 驗收標準

- [ ] `cargo build` 編譯通過
- [ ] `cargo clippy -- -D warnings` 零警告
- [ ] 在 main.rs 中正確註冊所有新 commands
- [ ] 所有 command 回傳 `Result<T, String>`
- [ ] 無 `unwrap()`，全部使用 `?` 或 `match`
- [ ] 有完整 rustdoc 註解（含參數、回傳、錯誤說明）
- [ ] 前端 types/ 和 TauriIPC.ts 已同步更新
- [ ] 不包含任何 3D 渲染邏輯
