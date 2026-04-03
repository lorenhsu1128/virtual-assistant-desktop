# Rust 後端開發規則

## 模組職責

| 模組 | 職責 | 執行緒 |
|------|------|--------|
| commands/ | Tauri command handlers，參數轉換 + 呼叫下層邏輯 | 主執行緒 |
| window_monitor.rs | EnumWindows 輪詢，差異比對，推送 event | 獨立執行緒 |
| file_manager.rs | config.json / animations.json 讀寫與損毀處理 | 主執行緒 |
| system_tray.rs | 托盤圖示與右鍵選單，透過 event 通知前端 | 主執行緒 |
| audio_capture.rs | 麥克風擷取（v0.4 預留） | 獨立執行緒 |
| single_instance.rs | Named mutex 單實例鎖定 | 啟動時 |

## Command 實作模板

```rust
use tauri::command;

/// 取得當前可見視窗清單
///
/// 過濾不可見、最小化、桌寵自身視窗。
/// 回傳按 Z-order 排序的視窗矩形清單。
#[command]
pub async fn get_window_list() -> Result<Vec<WindowRect>, String> {
    // 實作邏輯
    Ok(result)
}
```

所有 command 必須：
- 回傳 `Result<T, String>`
- 有完整 rustdoc 註解
- 在 main.rs 的 Tauri builder 中註冊

## Windows API 使用

- 使用 `windows-rs` crate，避免直接 unsafe FFI
- EnumWindows + GetWindowRect + GetWindowInfo 取得視窗資訊
- SetWindowRgn 做視窗裁切（遮擋效果）
- Per-Monitor DPI Aware v2 模式

## 檔案管理

- 設定目錄：`~/.virtual-assistant-desktop/`
- config.json 損毀 → 備份為 .bak → 預設值重建 → 記錄 WARN
- animations.json 同步 → 掃描結果與現有設定合併
- 日誌保留 7 天，單檔上限 10MB

## 禁止清單

- ❌ 任何 3D 渲染相關邏輯
- ❌ `unwrap()` — 全部使用 `?` 或 `match`
- ❌ 阻塞主執行緒的 Windows API 呼叫
- ❌ `panic!` 在 command handler 中（必須回傳 Err）
- ❌ 硬編碼路徑（使用 tauri::api::path 取得系統目錄）
