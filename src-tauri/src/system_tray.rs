use tauri::{
    menu::{Menu, MenuItem},
    tray::TrayIconBuilder,
    AppHandle, Emitter, Manager,
};

/// 系統托盤事件（推送至前端）
const TRAY_EVENT_QUIT: &str = "tray_quit";
const TRAY_EVENT_SHOW: &str = "tray_show";
const TRAY_EVENT_SETTINGS: &str = "tray_settings";

/// 建立系統托盤
///
/// 在通知區域建立圖示與右鍵選單。
/// 選單項目透過 Tauri event 通知前端。
pub fn setup_tray(app: &AppHandle) -> Result<(), String> {
    let show_item = MenuItem::with_id(app, "show", "顯示桌寵", true, None::<&str>)
        .map_err(|e| format!("Failed to create show menu item: {}", e))?;
    let settings_item = MenuItem::with_id(app, "settings", "設定", true, None::<&str>)
        .map_err(|e| format!("Failed to create settings menu item: {}", e))?;
    let quit_item = MenuItem::with_id(app, "quit", "結束", true, None::<&str>)
        .map_err(|e| format!("Failed to create quit menu item: {}", e))?;

    let menu = Menu::with_items(app, &[&show_item, &settings_item, &quit_item])
        .map_err(|e| format!("Failed to create tray menu: {}", e))?;

    let _tray = TrayIconBuilder::new()
        .menu(&menu)
        .tooltip("Virtual Assistant Desktop")
        .on_menu_event(move |app, event| {
            match event.id.as_ref() {
                "show" => {
                    // 將主視窗帶到前景
                    if let Some(window) = app.get_webview_window("main") {
                        let _ = window.set_focus();
                        let _ = window.unminimize();
                    }
                    let _ = app.emit(TRAY_EVENT_SHOW, ());
                }
                "settings" => {
                    let _ = app.emit(TRAY_EVENT_SETTINGS, ());
                }
                "quit" => {
                    let _ = app.emit(TRAY_EVENT_QUIT, ());
                    app.exit(0);
                }
                _ => {}
            }
        })
        .build(app)
        .map_err(|e| format!("Failed to build tray icon: {}", e))?;

    Ok(())
}
