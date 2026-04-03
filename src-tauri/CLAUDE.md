# Rust 後端開發規則

## 模組職責

| 模組 | 職責 | 狀態 |
|------|------|------|
| commands/file_commands.rs | 檔案讀寫、掃描、選擇器 command handlers | ✅ 正常 |
| commands/window_commands.rs | get_window_list, set_window_region, get_display_info | ⚠️ get_window_list 依賴停用的 WindowMonitor，回傳空陣列 |
| window_monitor.rs | EnumWindows 輪詢（⚠️ **停用中** — crash 問題未解決） | ❌ new_inactive() |
| file_manager.rs | config.json / animations.json 讀寫與損毀處理 | ✅ 正常 |
| types.rs | WindowRect, Rect, DisplayInfo 共用型別 | ✅ 正常 |

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

- 使用 `windows-rs` 0.61 crate（注意：API 回傳 `Result<T>` 而非裸值）
- ⚠️ **禁止 EnumWindows callback** — 會導致 access violation crash（見 LESSONS.md）
- 推薦使用 `GetDesktopWindow()` + `GetWindow(GW_CHILD/GW_HWNDNEXT)` 遍歷視窗
- SetWindowRgn 做視窗裁切（遮擋效果），位於 `Graphics::Gdi` 而非 `WindowsAndMessaging`
- Per-Monitor DPI Aware v2 模式
- `BOOL` 使用 `windows::core::BOOL` 而非 `Win32::Foundation::BOOL`

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
