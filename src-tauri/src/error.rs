//! One error type for everything that crosses the IPC boundary.
//!
//! Commands return `Result<T, AppError>`; the error serialises as a plain
//! human-readable string so the UI can show it verbatim.

use serde::Serialize;

#[derive(Debug, thiserror::Error)]
pub enum AppError {
    #[error("{0}")]
    Invalid(String),
    #[error("File not found: {0}")]
    NotFound(String),
    #[error("Unsupported file type: {0}")]
    Unsupported(String),
    #[error("This file looks corrupt: {0}")]
    Corrupt(String),
    #[error("{0}")]
    Protected(String),
    #[error("Already in your library: {0}")]
    Duplicate(String),
    #[error("Database error: {0}")]
    Db(#[from] rusqlite::Error),
    #[error("File system error: {0}")]
    Io(#[from] std::io::Error),
    #[error("Archive error: {0}")]
    Zip(#[from] zip::result::ZipError),
    #[error("Invalid book file: {0}")]
    Format(String),
}

impl Serialize for AppError {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&self.to_string())
    }
}

impl specta::Type for AppError {
    fn definition(types: &mut specta::Types) -> specta::datatype::DataType {
        <String as specta::Type>::definition(types)
    }
}

pub type AppResult<T> = Result<T, AppError>;

pub trait OptionExt<T> {
    fn or_not_found(self, what: &str) -> AppResult<T>;
}

impl<T> OptionExt<T> for Option<T> {
    fn or_not_found(self, what: &str) -> AppResult<T> {
        self.ok_or_else(|| AppError::NotFound(what.to_string()))
    }
}
