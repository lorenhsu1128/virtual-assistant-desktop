mod commands;
mod file_manager;

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
        ])
        .setup(|app| {
            // 確保設定目錄存在
            let config_dir = file_manager::get_config_dir()?;
            if !config_dir.exists() {
                std::fs::create_dir_all(&config_dir)
                    .map_err(|e| format!("Failed to create config dir: {}", e))?;
            }

            // 設定透明視窗背景（Windows 需要移除陰影以支援透明）
            #[cfg(target_os = "windows")]
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.set_shadow(false);
            }

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
