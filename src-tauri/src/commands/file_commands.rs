use crate::file_manager;
use tauri::command;
use tauri_plugin_dialog::DialogExt;

/// 檢查 config.json 是否存在
#[command]
pub async fn get_config_exists() -> Result<bool, String> {
    let config_dir = file_manager::get_config_dir()?;
    Ok(config_dir.join("config.json").exists())
}

/// 讀取 config.json
///
/// 若檔案不存在回傳預設值，若損毀則自動備份並重建。
#[command]
pub async fn read_config() -> Result<file_manager::AppConfig, String> {
    file_manager::read_config_file()
}

/// 寫入 config.json
#[command]
pub async fn write_config(config: file_manager::AppConfig) -> Result<(), String> {
    file_manager::write_config_file(&config)
}

/// 讀取 animations.json
#[command]
pub async fn read_animation_meta() -> Result<file_manager::AnimationMeta, String> {
    file_manager::read_animation_meta_file()
}

/// 寫入 animations.json
#[command]
pub async fn write_animation_meta(meta: file_manager::AnimationMeta) -> Result<(), String> {
    file_manager::write_animation_meta_file(&meta)
}

/// 掃描動畫資料夾並同步 metadata
///
/// 掃描指定路徑下所有 .vrma 檔案，與現有 animations.json 合併後寫回。
/// 新發現的檔案預設歸類為 action。
#[command]
pub async fn scan_animations(folder_path: String) -> Result<file_manager::AnimationMeta, String> {
    let scanned_files = file_manager::scan_vrma_files(&folder_path)?;
    let existing = file_manager::read_animation_meta_file()?;
    let synced = file_manager::sync_animation_meta(&folder_path, &existing, &scanned_files);

    file_manager::write_animation_meta_file(&synced)?;
    Ok(synced)
}

/// 開啟檔案選擇器選取 VRM 模型
#[command]
pub async fn pick_vrm_file(app: tauri::AppHandle) -> Result<Option<String>, String> {
    let file = app
        .dialog()
        .file()
        .add_filter("VRM Model", &["vrm"])
        .set_title("選擇 VRM 模型")
        .blocking_pick_file();

    match file {
        Some(path) => Ok(Some(path.to_string())),
        None => Ok(None),
    }
}

/// 開啟資料夾選擇器選取動畫資料夾
#[command]
pub async fn pick_animation_folder(app: tauri::AppHandle) -> Result<Option<String>, String> {
    let folder = app
        .dialog()
        .file()
        .set_title("選擇動畫資料夾")
        .blocking_pick_folder();

    match folder {
        Some(path) => Ok(Some(path.to_string())),
        None => Ok(None),
    }
}
