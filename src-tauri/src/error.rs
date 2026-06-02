use serde::Serialize;
use thiserror::Error;

#[derive(Debug, Error)]
#[allow(dead_code)] // RateLimited / Unknown are reserved for future use
pub enum AppError {
    #[error("Network error: {0}")]
    Network(String),

    #[error("API error: {0}")]
    Api(String),

    #[error("Invalid API key")]
    InvalidApiKey,

    #[error("Rate limited")]
    RateLimited,

    #[error("File error: {0}")]
    File(String),

    #[error("Database error: {0}")]
    Database(String),

    #[error("Configuration error: {0}")]
    Config(String),

    #[error("Unknown error: {0}")]
    Unknown(String),
}

impl Serialize for AppError {
    fn serialize<S>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        serializer.serialize_str(&self.to_string())
    }
}

impl From<reqwest::Error> for AppError {
    fn from(err: reqwest::Error) -> Self {
        if err.is_timeout() {
            return AppError::Network("Request timed out".to_string());
        }
        if err.is_connect() {
            return AppError::Network("Could not connect to the provider".to_string());
        }
        AppError::Network(err.to_string())
    }
}

impl AppError {
    /// Map a provider HTTP status to a specific error variant so the UI can
    /// react (rate-limit vs auth vs generic). `context` is a human label like
    /// "OpenAI".
    pub fn for_status(status: u16, context: &str, body: &str) -> AppError {
        match status {
            401 | 403 => AppError::InvalidApiKey,
            429 => AppError::RateLimited,
            _ => AppError::Api(format!("{} error {}: {}", context, status, body)),
        }
    }
}

impl From<std::io::Error> for AppError {
    fn from(err: std::io::Error) -> Self {
        AppError::File(err.to_string())
    }
}

impl From<serde_json::Error> for AppError {
    fn from(err: serde_json::Error) -> Self {
        AppError::Config(err.to_string())
    }
}

pub type Result<T> = std::result::Result<T, AppError>;
