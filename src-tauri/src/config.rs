use directories::ProjectDirs;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AppConfig {
    pub theme: String,
    pub hotkey: String,
    pub default_provider: String,
    pub default_model: String,
    pub max_context_chunks: u32,
    pub show_token_count: bool,
    pub hybrid_search: bool,
    pub similarity_threshold: f32,
    // Persisted Spotlight window geometry so the window reopens at the size and
    // position the user last left it. Physical pixels (DPI-independent on
    // restore). `#[serde(default)]` keeps older config files (without these
    // fields) loadable.
    #[serde(default)]
    pub window_width: Option<u32>,
    #[serde(default)]
    pub window_height: Option<u32>,
    #[serde(default)]
    pub window_x: Option<i32>,
    #[serde(default)]
    pub window_y: Option<i32>,
}

impl Default for AppConfig {
    fn default() -> Self {
        Self {
            theme: "dark".to_string(),
            hotkey: "Alt+Space".to_string(),
            default_provider: "gemini".to_string(),
            default_model: "gemini-3-flash-preview".to_string(),
            max_context_chunks: 5,
            show_token_count: true,
            hybrid_search: false,
            similarity_threshold: 0.7,
            window_width: None,
            window_height: None,
            window_x: None,
            window_y: None,
        }
    }
}

/// Load the persisted config, falling back to defaults if it's missing or
/// unreadable.
pub fn load_config() -> AppConfig {
    let path = get_config_path();
    if path.exists() {
        if let Ok(content) = std::fs::read_to_string(&path) {
            if let Ok(config) = serde_json::from_str::<AppConfig>(&content) {
                return config;
            }
        }
    }
    AppConfig::default()
}

/// Persist the config to disk, creating the parent directory if needed.
pub fn save_config(config: &AppConfig) {
    let path = get_config_path();
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    if let Ok(content) = serde_json::to_string_pretty(config) {
        let _ = std::fs::write(&path, content);
    }
}

pub fn get_data_dir() -> PathBuf {
    ProjectDirs::from("com", "omnirecall", "OmniRecall")
        .map(|dirs| dirs.data_dir().to_path_buf())
        .unwrap_or_else(|| PathBuf::from("."))
}

pub fn get_config_path() -> PathBuf {
    get_data_dir().join("config.json")
}

#[allow(dead_code)]
pub fn get_documents_dir() -> PathBuf {
    get_data_dir().join("documents")
}

#[allow(dead_code)]
pub fn get_database_dir() -> PathBuf {
    get_data_dir().join("db")
}
