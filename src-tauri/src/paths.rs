//! XDG layout. Every path the app writes to lives under one of these roots.
//!
//! data   -> SQLite database, optional imported book copies
//! cache  -> extracted covers, PDF thumbnails, exports
//! config -> settings.json (kept in sync with the DB for portability)

use std::path::{Path, PathBuf};

use directories::BaseDirs;

use crate::error::AppResult;

#[derive(Debug, Clone)]
pub struct AppPaths {
    pub data_dir: PathBuf,
    pub cache_dir: PathBuf,
    pub config_dir: PathBuf,
    pub db_path: PathBuf,
    pub covers_dir: PathBuf,
    pub books_dir: PathBuf,
    pub thumbs_dir: PathBuf,
    pub config_file: PathBuf,
}

impl AppPaths {
    pub fn discover() -> AppResult<Self> {
        let base = BaseDirs::new()
            .ok_or_else(|| crate::error::AppError::Invalid("No home directory".into()))?;
        let data = base.data_dir().join("bookshelf");
        let cache = base.cache_dir().join("bookshelf");
        let config = base.config_dir().join("bookshelf");
        Ok(Self::from_roots(data, cache, config))
    }

    /// Test/portable helper: all roots below one directory.
    pub fn with_root(root: &Path) -> Self {
        Self::from_roots(root.join("data"), root.join("cache"), root.join("config"))
    }

    fn from_roots(data_dir: PathBuf, cache_dir: PathBuf, config_dir: PathBuf) -> Self {
        Self {
            db_path: data_dir.join("library.sqlite3"),
            covers_dir: cache_dir.join("covers"),
            books_dir: data_dir.join("books"),
            thumbs_dir: cache_dir.join("thumbs"),
            config_file: config_dir.join("settings.json"),
            data_dir,
            cache_dir,
            config_dir,
        }
    }

    pub fn ensure(&self) -> AppResult<()> {
        for dir in [
            &self.data_dir,
            &self.cache_dir,
            &self.config_dir,
            &self.covers_dir,
            &self.books_dir,
            &self.thumbs_dir,
        ] {
            std::fs::create_dir_all(dir)?;
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn xdg_layout_is_flat_and_predictable() {
        let root = tempfile::tempdir().unwrap();
        let p = AppPaths::with_root(root.path());
        assert!(p.db_path.ends_with("data/library.sqlite3"));
        assert!(p.covers_dir.ends_with("cache/covers"));
        assert!(p.config_file.ends_with("config/settings.json"));
        p.ensure().unwrap();
        assert!(p.db_path.parent().unwrap().is_dir());
    }
}
