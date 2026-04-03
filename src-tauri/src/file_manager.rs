use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;

/// 應用程式設定
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppConfig {
    pub vrm_model_path: Option<String>,
    pub animation_folder_path: Option<String>,
    pub window_position: Position,
    pub window_size: Size,
    pub scale: f64,
    pub mic_enabled: bool,
    pub camera_enabled: bool,
    pub target_fps: u32,
    pub power_save_mode: bool,
    pub autonomous_movement_paused: bool,
    #[serde(default = "default_true")]
    pub animation_loop_enabled: bool,
    #[serde(default = "default_true")]
    pub auto_expression_enabled: bool,
    #[serde(default)]
    pub allowed_auto_expressions: Vec<String>,
}

fn default_true() -> bool {
    true
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Position {
    pub x: f64,
    pub y: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Size {
    pub width: f64,
    pub height: f64,
}

/// 動畫條目
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AnimationEntry {
    pub file_name: String,
    pub display_name: String,
    pub category: String,
    pub r#loop: bool,
    pub weight: f64,
}

/// 動畫 metadata
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AnimationMeta {
    pub folder_path: String,
    pub entries: Vec<AnimationEntry>,
}

impl Default for AppConfig {
    fn default() -> Self {
        Self {
            vrm_model_path: None,
            animation_folder_path: None,
            window_position: Position { x: 0.0, y: 0.0 },
            window_size: Size {
                width: 400.0,
                height: 600.0,
            },
            scale: 1.0,
            mic_enabled: false,
            camera_enabled: false,
            target_fps: 30,
            power_save_mode: false,
            autonomous_movement_paused: false,
            animation_loop_enabled: true,
            auto_expression_enabled: true,
            allowed_auto_expressions: Vec::new(),
        }
    }
}

/// 取得設定目錄路徑 (~/.virtual-assistant-desktop/)
pub fn get_config_dir() -> Result<PathBuf, String> {
    dirs::home_dir()
        .map(|home| home.join(".virtual-assistant-desktop"))
        .ok_or_else(|| "Cannot determine home directory".to_string())
}

/// 取得 config.json 路徑
fn get_config_path() -> Result<PathBuf, String> {
    Ok(get_config_dir()?.join("config.json"))
}

/// 取得 animations.json 路徑
fn get_animation_meta_path() -> Result<PathBuf, String> {
    Ok(get_config_dir()?.join("animations.json"))
}

/// 讀取 config.json，損毀時自動備份並重建
pub fn read_config_file() -> Result<AppConfig, String> {
    let path = get_config_path()?;

    if !path.exists() {
        return Ok(AppConfig::default());
    }

    let content = fs::read_to_string(&path)
        .map_err(|e| format!("Failed to read config.json: {}", e))?;

    match serde_json::from_str::<AppConfig>(&content) {
        Ok(config) => Ok(config),
        Err(e) => {
            // 設定檔損毀：備份並重建
            log::warn!("config.json is corrupted: {}. Backing up and recreating.", e);
            let backup_path = get_config_dir()?.join("config.json.bak");
            let _ = fs::copy(&path, &backup_path);

            let default_config = AppConfig::default();
            write_config_file(&default_config)?;
            Ok(default_config)
        }
    }
}

/// 寫入 config.json
pub fn write_config_file(config: &AppConfig) -> Result<(), String> {
    let path = get_config_path()?;
    let dir = get_config_dir()?;

    if !dir.exists() {
        fs::create_dir_all(&dir)
            .map_err(|e| format!("Failed to create config dir: {}", e))?;
    }

    let content = serde_json::to_string_pretty(config)
        .map_err(|e| format!("Failed to serialize config: {}", e))?;

    fs::write(&path, content)
        .map_err(|e| format!("Failed to write config.json: {}", e))
}

/// 讀取 animations.json
pub fn read_animation_meta_file() -> Result<AnimationMeta, String> {
    let path = get_animation_meta_path()?;

    if !path.exists() {
        return Ok(AnimationMeta::default());
    }

    let content = fs::read_to_string(&path)
        .map_err(|e| format!("Failed to read animations.json: {}", e))?;

    serde_json::from_str(&content)
        .map_err(|e| format!("Failed to parse animations.json: {}", e))
}

/// 寫入 animations.json
pub fn write_animation_meta_file(meta: &AnimationMeta) -> Result<(), String> {
    let path = get_animation_meta_path()?;
    let dir = get_config_dir()?;

    if !dir.exists() {
        fs::create_dir_all(&dir)
            .map_err(|e| format!("Failed to create config dir: {}", e))?;
    }

    let content = serde_json::to_string_pretty(meta)
        .map_err(|e| format!("Failed to serialize animations.json: {}", e))?;

    fs::write(&path, content)
        .map_err(|e| format!("Failed to write animations.json: {}", e))
}

/// 掃描指定資料夾內的 .vrma 檔案
pub fn scan_vrma_files(folder_path: &str) -> Result<Vec<String>, String> {
    let path = PathBuf::from(folder_path);

    if !path.exists() || !path.is_dir() {
        return Err(format!("Animation folder does not exist: {}", folder_path));
    }

    let mut files = Vec::new();

    let entries = fs::read_dir(&path)
        .map_err(|e| format!("Failed to read animation folder: {}", e))?;

    for entry in entries {
        let entry = entry
            .map_err(|e| format!("Failed to read directory entry: {}", e))?;
        let file_path = entry.path();

        if let Some(ext) = file_path.extension() {
            if ext.eq_ignore_ascii_case("vrma") {
                if let Some(name) = file_path.file_name() {
                    files.push(name.to_string_lossy().to_string());
                }
            }
        }
    }

    files.sort();
    Ok(files)
}

/// 同步掃描結果與現有 metadata
///
/// - 新發現的 .vrma 預設歸類為 action
/// - 已不存在的條目移除
pub fn sync_animation_meta(
    folder_path: &str,
    existing: &AnimationMeta,
    scanned_files: &[String],
) -> AnimationMeta {
    let mut entries = Vec::new();

    for file_name in scanned_files {
        // 嘗試沿用既有設定
        if let Some(existing_entry) = existing.entries.iter().find(|e| &e.file_name == file_name) {
            entries.push(existing_entry.clone());
        } else {
            // 新檔案，預設歸類為 action
            let display_name = file_name
                .strip_suffix(".vrma")
                .or_else(|| file_name.strip_suffix(".VRMA"))
                .unwrap_or(file_name)
                .to_string();

            entries.push(AnimationEntry {
                file_name: file_name.clone(),
                display_name,
                category: "action".to_string(),
                r#loop: false,
                weight: 1.0,
            });
        }
    }

    AnimationMeta {
        folder_path: folder_path.to_string(),
        entries,
    }
}
