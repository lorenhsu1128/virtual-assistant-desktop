---
name: add-ipc
description: 同時在 Rust 和 TypeScript 兩側新增 IPC command 或 event，確保型別一致性。
argument-hint: "[type: command|event] [name]"
user-invocable: true
---

根據指定的類型（$ARGUMENTS 第一個參數：command 或 event）和名稱（第二個參數，snake_case），同步建立 IPC 介面的兩側實作。

## 當 type = command 時

### Rust 側

1. 在 `src-tauri/src/commands/` 中找到或建立對應的 `_commands.rs` 檔案
2. 新增 command handler：
   ```rust
   #[command]
   pub async fn {name}({params}) -> Result<{ReturnType}, String> {
       // TODO: 實作
       Ok(result)
   }
   ```
3. 在 `commands/mod.rs` 中確認 pub mod 宣告存在
4. 在 `main.rs` 的 `invoke_handler` 中註冊新 command

### TypeScript 側

5. 在 `src/types/` 中新增或更新共用型別（確保與 Rust struct 一致）
6. 在 `src/bridge/TauriIPC.ts` 中新增 typed wrapper 方法：
   ```typescript
   public async {camelCaseName}(): Promise<{ReturnType}> {
     try {
       return await invoke<{ReturnType}>('{name}');
     } catch (error) {
       console.warn('{name} failed:', error);
       // 依錯誤處理策略回傳 fallback
     }
   }
   ```

### 驗證

7. 執行 `cargo check` 確認 Rust 編譯通過
8. 執行 `npx tsc --noEmit` 確認 TypeScript 型別正確

## 當 type = event 時

### Rust 側

1. 定義 event payload 結構體（或確認已存在）
2. 在適當模組中加入 emit 邏輯：
   ```rust
   app_handle.emit_all("{name}", &payload).map_err(|e| e.to_string())?;
   ```

### TypeScript 側

3. 在 `src/types/` 中新增 payload 型別
4. 在 `src/bridge/TauriIPC.ts` 中新增 listener wrapper：
   ```typescript
   public on{PascalCaseName}(
     callback: (payload: {PayloadType}) => void
   ): UnlistenFn {
     return listen<{PayloadType}>('{name}', (event) => {
       callback(event.payload);
     });
   }
   ```

### 驗證

5. 執行 `cargo check` 和 `npx tsc --noEmit`

---

完成後，列出兩側的型別定義讓使用者確認一致性。
