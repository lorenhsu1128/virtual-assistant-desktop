use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem, Submenu},
    tray::TrayIconBuilder,
    AppHandle, Emitter, Manager,
};

/// 建立系統托盤
///
/// 在通知區域建立圖示與右鍵選單。
/// 選單項目透過 Tauri event（`tray_action`）通知前端，
/// payload 為動作名稱字串。
pub fn setup_tray(app: &AppHandle) -> Result<(), String> {
    let me = |id: &str, label: &str| -> Result<MenuItem<tauri::Wry>, String> {
        MenuItem::with_id(app, id, label, true, None::<&str>)
            .map_err(|e| format!("Failed to create menu item '{}': {}", id, e))
    };
    let sep = || -> Result<PredefinedMenuItem<tauri::Wry>, String> {
        PredefinedMenuItem::separator(app)
            .map_err(|e| format!("Failed to create separator: {}", e))
    };

    // 縮放子選單
    let scale_submenu = Submenu::with_items(
        app,
        "縮放",
        true,
        &[
            &me("scale_50", "50%")?,
            &me("scale_75", "75%")?,
            &me("scale_100", "100%")?,
            &me("scale_125", "125%")?,
            &me("scale_150", "150%")?,
            &me("scale_200", "200%")?,
        ],
    )
    .map_err(|e| format!("Failed to create scale submenu: {}", e))?;

    let menu = Menu::with_items(
        app,
        &[
            &me("show", "顯示桌寵")?,
            &sep()?,
            &scale_submenu,
            &me("toggle_pause", "暫停/恢復自主移動")?,
            &me("toggle_auto_expr", "暫停/恢復自動表情")?,
            &me("toggle_loop", "暫停/恢復動畫循環")?,
            &me("reset_camera", "重置鏡頭角度")?,
            &sep()?,
            &me("change_model", "更換 VRM 模型")?,
            &me("change_anim", "更換動畫資料夾")?,
            &sep()?,
            &me("settings", "設定")?,
            &sep()?,
            &me("quit", "結束")?,
        ],
    )
    .map_err(|e| format!("Failed to create tray menu: {}", e))?;

    let _tray = TrayIconBuilder::new()
        .menu(&menu)
        .tooltip("Virtual Assistant Desktop")
        .on_menu_event(move |app, event| {
            let id = event.id.as_ref();
            match id {
                "show" => {
                    if let Some(window) = app.get_webview_window("main") {
                        let _ = window.set_focus();
                        let _ = window.unminimize();
                    }
                }
                "quit" => {
                    app.exit(0);
                }
                _ => {
                    // 所有其他動作透過統一事件通知前端
                    let _ = app.emit("tray_action", id);
                }
            }
        })
        .build(app)
        .map_err(|e| format!("Failed to build tray icon: {}", e))?;

    Ok(())
}
