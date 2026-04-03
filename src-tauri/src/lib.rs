mod commands;
mod file_manager;
mod system_tray;
mod types;
mod window_monitor;

use raw_window_handle::{HasWindowHandle, RawWindowHandle};
use tauri::Manager;

/// 建立並設定 Tauri 應用程式
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            // 已有實例運行時，將現有視窗帶到前景
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.set_focus();
                let _ = window.unminimize();
            }
        }))
        .invoke_handler(tauri::generate_handler![
            commands::file_commands::read_config,
            commands::file_commands::write_config,
            commands::file_commands::read_animation_meta,
            commands::file_commands::write_animation_meta,
            commands::file_commands::scan_animations,
            commands::file_commands::pick_vrm_file,
            commands::file_commands::pick_animation_folder,
            commands::file_commands::get_config_exists,
            commands::window_commands::get_window_list,
            commands::window_commands::set_window_region,
            commands::window_commands::get_display_info,
        ])
        .setup(|app| {
            // 確保設定目錄存在
            let config_dir = file_manager::get_config_dir()?;
            if !config_dir.exists() {
                std::fs::create_dir_all(&config_dir)
                    .map_err(|e| format!("Failed to create config dir: {}", e))?;
            }

            // 設定透明視窗背景（Windows 需要移除陰影以支援透明）
            // 同時取得 HWND 用於視窗監控過濾
            #[cfg(target_os = "windows")]
            {
                let mut own_hwnd: isize = 0;
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.set_shadow(false);

                    // 取得主視窗 HWND
                    if let Ok(handle) = window.window_handle() {
                        if let RawWindowHandle::Win32(win32) = handle.as_raw() {
                            own_hwnd = win32.hwnd.get();
                        }
                    }
                }

                if own_hwnd == 0 {
                    log::warn!("[setup] Could not obtain main window HWND; window monitor will not filter self");
                }

                // 暫時建立空的 WindowMonitor（除錯用，不啟動輪詢）
                let monitor = window_monitor::WindowMonitor::new_inactive();
                app.manage(monitor);
                log::info!("[setup] WindowMonitor created (inactive for debugging)");
            }

            // 系統托盤
            system_tray::setup_tray(app.handle())?;

            Ok(())
        })
        .run(tauri::generate_context!())
        // 進入點層級：Tauri 啟動失敗無法復原，只能記錄錯誤後退出
        .unwrap_or_else(|e| {
            log::error!("Failed to start Tauri application: {}", e);
            std::process::exit(1);
        });
}
