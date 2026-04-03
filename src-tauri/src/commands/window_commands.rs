use tauri::{command, AppHandle, Manager};
use windows::Win32::Foundation::{HWND, RECT};
use windows::Win32::Graphics::Gdi::{
    CombineRgn, CreateRectRgn, DeleteObject, SetWindowRgn, RGN_DIFF,
};

use crate::types::{DisplayInfo, Rect, WindowRect};
use crate::window_monitor::WindowMonitor;

/// 取得當前可見視窗清單
///
/// 從 WindowMonitor 的快取讀取，不阻塞主執行緒。
/// 回傳按 Z-order 排序的視窗矩形清單。
#[command]
pub async fn get_window_list(
    state: tauri::State<'_, WindowMonitor>,
) -> Result<Vec<WindowRect>, String> {
    Ok(state.get_latest())
}

/// 設定桌寵視窗的裁切區域（遮擋效果）
///
/// 接收要排除的矩形列表（視窗本地座標），
/// 用 SetWindowRgn 裁切視窗形狀。
/// 傳入空列表時重置為完整視窗。
#[command]
pub async fn set_window_region(
    app: AppHandle,
    exclude_rects: Vec<Rect>,
) -> Result<(), String> {
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| "Main window not found".to_string())?;

    // 取得視窗的原生 HWND
    let hwnd = get_window_hwnd(&window)?;

    unsafe {
        if exclude_rects.is_empty() {
            // 重置為完整視窗（移除 region 限制）
            let _ = SetWindowRgn(hwnd, None, true);
            return Ok(());
        }

        // 取得視窗大小以建立完整 region
        let mut window_rect = RECT::default();
        windows::Win32::UI::WindowsAndMessaging::GetWindowRect(hwnd, &mut window_rect)
            .map_err(|e| format!("Failed to get window rect: {}", e))?;

        let w = window_rect.right - window_rect.left;
        let h = window_rect.bottom - window_rect.top;

        // 建立完整視窗 region
        let full_region = CreateRectRgn(0, 0, w, h);
        if full_region.is_invalid() {
            return Err("Failed to create full window region".to_string());
        }

        // 對每個排除矩形做 RGN_DIFF
        for rect in &exclude_rects {
            let exclude = CreateRectRgn(
                rect.x,
                rect.y,
                rect.x + rect.width,
                rect.y + rect.height,
            );
            if !exclude.is_invalid() {
                let _ = CombineRgn(
                    Some(full_region),
                    Some(full_region),
                    Some(exclude),
                    RGN_DIFF,
                );
                let _ = DeleteObject(exclude.into());
            }
        }

        // 套用 region（SetWindowRgn 取得 region 所有權，不需手動刪除）
        let _ = SetWindowRgn(hwnd, Some(full_region), true);
    }

    Ok(())
}

/// 取得螢幕資訊
///
/// 回傳所有螢幕的位置、大小與 DPI 縮放比例。
#[command]
pub async fn get_display_info(app: AppHandle) -> Result<Vec<DisplayInfo>, String> {
    let monitors = app
        .available_monitors()
        .map_err(|e| format!("Failed to get monitors: {}", e))?;

    let mut displays = Vec::new();
    for monitor in monitors {
        let pos = monitor.position();
        let size = monitor.size();
        let scale = monitor.scale_factor();

        displays.push(DisplayInfo {
            x: pos.x,
            y: pos.y,
            width: size.width as i32,
            height: size.height as i32,
            scale_factor: scale,
        });
    }

    Ok(displays)
}

/// 從 Tauri WebviewWindow 取得原生 HWND
fn get_window_hwnd(window: &tauri::WebviewWindow) -> Result<HWND, String> {
    use raw_window_handle::{HasWindowHandle, RawWindowHandle};

    let handle = window
        .window_handle()
        .map_err(|e| format!("Failed to get window handle: {}", e))?;

    let raw = handle.as_raw();

    match raw {
        RawWindowHandle::Win32(win32) => {
            let hwnd_ptr = win32.hwnd.get();
            Ok(HWND(hwnd_ptr as *mut _))
        }
        _ => Err("Not a Win32 window".to_string()),
    }
}
