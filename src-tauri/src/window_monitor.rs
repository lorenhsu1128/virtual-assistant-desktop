use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use tauri::{AppHandle, Emitter};
use windows::Win32::Foundation::{HWND, LPARAM, RECT};
use windows::Win32::UI::WindowsAndMessaging::{
    EnumWindows, GetWindowRect, GetWindowTextLengthW, GetWindowTextW, IsIconic, IsWindowVisible,
};

use crate::types::WindowRect;

/// 輪詢間隔（250ms = 4Hz）
const POLL_INTERVAL: Duration = Duration::from_millis(250);

/// 視窗監控器
///
/// 在獨立執行緒上定期輪詢 Windows API，取得所有可見視窗的位置與大小。
/// 僅在佈局變化時透過 Tauri event 推送更新至前端。
pub struct WindowMonitor {
    latest_rects: Arc<Mutex<Vec<WindowRect>>>,
    running: Arc<AtomicBool>,
}

impl WindowMonitor {
    /// 啟動視窗監控
    ///
    /// - `app_handle`: 用於 emit event 至前端
    /// - `own_hwnd`: 桌寵自身的視窗 handle，排除自身
    pub fn start(app_handle: AppHandle, own_hwnd: isize) -> Self {
        let latest_rects = Arc::new(Mutex::new(Vec::new()));
        let running = Arc::new(AtomicBool::new(true));

        let rects_clone = Arc::clone(&latest_rects);
        let running_clone = Arc::clone(&running);

        thread::spawn(move || {
            let mut last_hash: u64 = 0;

            while running_clone.load(Ordering::Relaxed) {
                let rects = enumerate_windows(own_hwnd);
                let current_hash = hash_window_rects(&rects);

                if current_hash != last_hash {
                    last_hash = current_hash;

                    // 更新快取
                    if let Ok(mut cache) = rects_clone.lock() {
                        *cache = rects.clone();
                    }

                    // 推送 event 至前端
                    let _ = app_handle.emit("window_layout_changed", &rects);
                }

                thread::sleep(POLL_INTERVAL);
            }

            log::info!("[WindowMonitor] Polling thread stopped.");
        });

        Self {
            latest_rects,
            running,
        }
    }

    /// 取得最新的視窗矩形清單
    pub fn get_latest(&self) -> Vec<WindowRect> {
        self.latest_rects
            .lock()
            .map(|cache| cache.clone())
            .unwrap_or_default()
    }

    /// 停止監控
    pub fn stop(&self) {
        self.running.store(false, Ordering::Relaxed);
    }
}

impl Drop for WindowMonitor {
    fn drop(&mut self) {
        self.stop();
    }
}

/// 列舉所有可見視窗
///
/// 過濾規則：
/// - 排除不可見視窗
/// - 排除最小化視窗
/// - 排除零大小視窗
/// - 排除桌寵自身視窗
fn enumerate_windows(own_hwnd: isize) -> Vec<WindowRect> {
    let mut result: Vec<WindowRect> = Vec::new();
    let context = EnumContext {
        own_hwnd,
        windows: &mut result as *mut Vec<WindowRect>,
    };

    unsafe {
        let _ = EnumWindows(
            Some(enum_windows_callback),
            LPARAM(&context as *const EnumContext as isize),
        );
    }

    // Z-order 由 EnumWindows 列舉順序決定（前景在前）
    for (i, rect) in result.iter_mut().enumerate() {
        rect.z_order = i as i32;
    }

    result
}

/// EnumWindows 回呼的上下文
struct EnumContext {
    own_hwnd: isize,
    windows: *mut Vec<WindowRect>,
}

/// EnumWindows 回呼函式
///
/// 對每個視窗進行過濾並收集資訊。
unsafe extern "system" fn enum_windows_callback(hwnd: HWND, lparam: LPARAM) -> windows::core::BOOL {
    let context = &*(lparam.0 as *const EnumContext);

    // 排除自身
    if hwnd.0 as isize == context.own_hwnd {
        return windows::core::BOOL(1);
    }

    // 排除不可見視窗
    if !IsWindowVisible(hwnd).as_bool() {
        return windows::core::BOOL(1);
    }

    // 排除最小化視窗
    if IsIconic(hwnd).as_bool() {
        return windows::core::BOOL(1);
    }

    // 取得視窗矩形
    let mut rect = RECT::default();
    if GetWindowRect(hwnd, &mut rect).is_err() {
        return windows::core::BOOL(1);
    }

    let width = rect.right - rect.left;
    let height = rect.bottom - rect.top;

    // 排除零大小視窗
    if width <= 0 || height <= 0 {
        return windows::core::BOOL(1);
    }

    // 排除超大視窗（可能是桌面或全螢幕背景）
    // 保留寬高各不超過 8000px 的視窗
    if width > 8000 || height > 8000 {
        return windows::core::BOOL(1);
    }

    // 取得視窗標題
    let title = get_window_title(hwnd);

    // 排除沒有標題的視窗（通常是系統隱藏視窗）
    if title.is_empty() {
        return windows::core::BOOL(1);
    }

    let windows = &mut *context.windows;
    windows.push(WindowRect {
        hwnd: hwnd.0 as u64,
        title,
        x: rect.left,
        y: rect.top,
        width,
        height,
        z_order: 0, // 稍後由 enumerate_windows 填入
    });

    windows::core::BOOL(1)
}

/// 取得視窗標題
fn get_window_title(hwnd: HWND) -> String {
    unsafe {
        let len = GetWindowTextLengthW(hwnd);
        if len <= 0 {
            return String::new();
        }

        let mut buffer = vec![0u16; (len + 1) as usize];
        let actual_len = GetWindowTextW(hwnd, &mut buffer);
        if actual_len <= 0 {
            return String::new();
        }

        String::from_utf16_lossy(&buffer[..actual_len as usize])
    }
}

/// 計算視窗清單的 hash（用於差異比對）
fn hash_window_rects(rects: &[WindowRect]) -> u64 {
    let mut hasher = DefaultHasher::new();
    for rect in rects {
        rect.hwnd.hash(&mut hasher);
        rect.x.hash(&mut hasher);
        rect.y.hash(&mut hasher);
        rect.width.hash(&mut hasher);
        rect.height.hash(&mut hasher);
    }
    hasher.finish()
}
