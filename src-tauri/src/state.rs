use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex, MutexGuard};

use crate::db::Db;
use crate::error::AppResult;
use crate::formats::epub::EpubArchive;
use crate::models::Settings;
use crate::paths::AppPaths;

/// Last few EPUB archives opened through the custom protocol, so rendering a
/// chapter does not re-open and re-scan the zip for every image.
pub struct CachedArchive {
    pub book_id: i64,
    pub mtime: u64,
    pub archive: Arc<Mutex<EpubArchive>>,
}

pub struct AppState {
    db: Mutex<Db>,
    pub paths: AppPaths,
    pub archives: Mutex<Vec<CachedArchive>>,
    pub importing: AtomicBool,
    pub pending: Mutex<Vec<String>>,
    pub watcher: Mutex<Option<notify::RecommendedWatcher>>,
}

impl AppState {
    pub fn new(paths: AppPaths) -> AppResult<Arc<Self>> {
        let db = Db::open(&paths.db_path)?;
        Ok(Arc::new(Self {
            db: Mutex::new(db),
            paths,
            archives: Mutex::new(Vec::new()),
            importing: AtomicBool::new(false),
            pending: Mutex::new(Vec::new()),
            watcher: Mutex::new(None),
        }))
    }

    /// Poisoning only happens if a command panicked while holding the lock; the
    /// connection itself is still usable, so recover instead of taking the app
    /// down.
    pub fn db(&self) -> MutexGuard<'_, Db> {
        self.db.lock().unwrap_or_else(|e| e.into_inner())
    }

    pub fn settings(&self) -> Settings {
        self.db().load_settings()
    }

    pub fn save_settings(&self, settings: &Settings) -> AppResult<()> {
        self.db().save_settings(settings)?;
        // Mirror to XDG_CONFIG_HOME so the file can be inspected/edited and is
        // included in backups of dotfiles.
        if let Ok(json) = serde_json::to_string_pretty(settings) {
            if let Err(err) = std::fs::write(&self.paths.config_file, json) {
                tracing::debug!(%err, "could not mirror settings to config dir");
            }
        }
        Ok(())
    }

    pub fn archive_cache(&self) -> MutexGuard<'_, Vec<CachedArchive>> {
        self.archives.lock().unwrap_or_else(|e| e.into_inner())
    }
}
