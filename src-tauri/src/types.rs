use serde::{Deserialize, Serialize};

/// 視窗矩形資料（傳送至前端）
///
/// 由 window_monitor 產生，透過 IPC 傳送給 TypeScript 側的 CollisionSystem。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowRect {
    /// 視窗 handle
    pub hwnd: u64,
    /// 視窗標題
    pub title: String,
    /// 左上角 X 座標（物理像素）
    pub x: i32,
    /// 左上角 Y 座標（物理像素）
    pub y: i32,
    /// 寬度（物理像素）
    pub width: i32,
    /// 高度（物理像素）
    pub height: i32,
    /// Z-order（數值越小越上層，由 EnumWindows 列舉順序決定）
    pub z_order: i32,
}

/// 矩形（通用，用於 SetWindowRgn 等）
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Rect {
    pub x: i32,
    pub y: i32,
    pub width: i32,
    pub height: i32,
}

/// 螢幕資訊
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DisplayInfo {
    /// 螢幕左上角 X
    pub x: i32,
    /// 螢幕左上角 Y
    pub y: i32,
    /// 寬度
    pub width: i32,
    /// 高度
    pub height: i32,
    /// DPI 縮放比例
    pub scale_factor: f64,
}
