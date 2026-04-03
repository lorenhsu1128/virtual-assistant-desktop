---
name: ipc-bridge
description: 新增或修改 Tauri IPC 通訊介面，同時在 Rust 和 TypeScript 兩側建立 typed command 或 event，確保型別一致。
---

## IPC 介面開發流程

### 使用時機

- 新增前端呼叫 Rust 的 Command
- 新增 Rust 推送至前端的 Event
- 修改現有 IPC 介面的參數或回傳型別

### 參考定義

IPC 介面定義於 SPEC.md 第 6.5 節。開發前先確認規格書中的定義。

### 新增 Command 流程

**第 1 步：Rust 側 — 實作 handler**

```rust
// src-tauri/src/commands/{category}_commands.rs

#[command]
pub async fn {command_name}({params}) -> Result<{ReturnType}, String> {
    // 實作
}
```

**第 2 步：Rust 側 — 註冊**

在 `main.rs` 的 `invoke_handler` 中加入新 command。

**第 3 步：TypeScript 側 — types/ 定義共用型別**

```typescript
// src/types/{name}.ts
export interface {TypeName} {
  // 與 Rust struct 欄位完全對應
  // Rust snake_case → TS camelCase（Tauri 自動轉換）
}
```

**第 4 步：TypeScript 側 — TauriIPC wrapper**

```typescript
// src/bridge/TauriIPC.ts

/**
 * {功能描述}
 * @returns {回傳描述}
 */
public async {commandName}(): Promise<{ReturnType}> {
  try {
    return await invoke<{ReturnType}>('{command_name}');
  } catch (error) {
    // 依錯誤處理策略處理
    console.warn('{command_name} failed:', error);
    return this.{fallbackStrategy};
  }
}
```

### 新增 Event 流程

**第 1 步：Rust 側 — 定義 payload 並 emit**

```rust
// 在適當位置 emit event
app_handle.emit_all("{event_name}", payload)
    .map_err(|e| e.to_string())?;
```

**第 2 步：TypeScript 側 — TauriIPC listener wrapper**

```typescript
// src/bridge/TauriIPC.ts

/**
 * 監聽 {event 描述}
 * @param callback - 收到事件時的回呼函式
 * @returns 取消監聽的函式
 */
public onEventName(
  callback: (payload: {PayloadType}) => void
): UnlistenFn {
  return listen<{PayloadType}>('{event_name}', (event) => {
    callback(event.payload);
  });
}
```

### 錯誤處理策略對照表

| Command | 失敗時處理 |
|---------|-----------|
| get_window_list | 回傳上一次快取資料 |
| read_config | 回傳預設值，記錄 WARN |
| write_config | 記憶體保留，重試 3 次後通知使用者 |
| scan_animations | 回傳空陣列，記錄 WARN |
| pick_file | 回傳 null（使用者取消是正常操作） |
| get_microphone_level | 回傳 0.0 |
| set_window_region | 記錄 ERROR，不中斷運行 |

### 型別對應規則

| Rust 型別 | TypeScript 型別 | 備註 |
|-----------|----------------|------|
| `String` | `string` | |
| `i32` / `u32` | `number` | |
| `f32` / `f64` | `number` | |
| `bool` | `boolean` | |
| `Vec<T>` | `T[]` | |
| `Option<T>` | `T \| null` | |
| `Result<T, String>` | `Promise<T>` | 錯誤由 TauriIPC 統一捕捉 |
| `struct` fields | 自動 snake_case → camelCase | Tauri serde 設定 |

### 驗收標準

- [ ] Rust 和 TypeScript 兩側型別完全對應
- [ ] TauriIPC 中有 typed wrapper，其他模組不直接呼叫 invoke
- [ ] 錯誤處理策略已按對照表實作
- [ ] `cargo build` + `tsc --noEmit` 均通過
- [ ] 有整合測試 `tests/integration/TauriIPC.test.ts`
