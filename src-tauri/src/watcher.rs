//! Watches the folders our books live in so a file moved or deleted outside
//! the app flips the book into its "missing" state without a manual rescan.
//!
//! Events are debounced; the watcher never touches book files.

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::mpsc;
use std::sync::Arc;
use std::time::{Duration, Instant};

use notify::{RecursiveMode, Watcher};
use tauri::{AppHandle, Emitter};

use crate::db::Db;
use crate::error::AppResult;
use crate::state::AppState;

pub fn start(state: Arc<AppState>, app: AppHandle) -> AppResult<()> {
    let dirs = watched_dirs(&state);
    let (tx, rx) = mpsc::channel();
    let mut watcher = notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
        if let Ok(event) = res {
            let _ = tx.send(event);
        }
    })
    .map_err(|e| crate::error::AppError::Invalid(format!("file watcher: {e}")))?;
    for dir in &dirs {
        // A folder can vanish between listing and watching; ignore that.
        if let Err(err) = watcher.watch(dir, RecursiveMode::NonRecursive) {
            tracing::debug!(%err, dir = %dir.display(), "could not watch folder");
        }
    }
    // Dropping the previous watcher closes its channel, ending the old worker.
    *state.watcher.lock().unwrap_or_else(|e| e.into_inner()) = Some(watcher);

    let worker_paths = state.paths.clone();
    std::thread::Builder::new()
        .name("bookshelf-watch".into())
        .spawn(move || {
            let mut last_emit = Instant::now() - Duration::from_secs(1);
            while let Ok(first) = rx.recv() {
                let mut paths: Vec<PathBuf> = first.paths;
                let deadline = Instant::now() + Duration::from_millis(400);
                loop {
                    let remaining = deadline.saturating_duration_since(Instant::now());
                    if remaining.is_zero() {
                        break;
                    }
                    match rx.recv_timeout(remaining) {
                        Ok(event) => paths.extend(event.paths),
                        Err(_) => break,
                    }
                }
                let Ok(db) = Db::open(&worker_paths.db_path) else {
                    continue;
                };
                let Ok(books) = db.list_books() else {
                    continue;
                };
                let touched: HashSet<&Path> = paths.iter().map(PathBuf::as_path).collect();
                let mut changed = false;
                for book in books {
                    let book_path = Path::new(&book.path);
                    let relevant = touched.contains(book_path)
                        || book_path
                            .parent()
                            .map(|p| touched.iter().any(|t| t.parent() == Some(p)))
                            .unwrap_or(false);
                    if !relevant {
                        continue;
                    }
                    let exists = book_path.exists();
                    if exists == book.missing {
                        let _ = db.set_missing(book.id, !exists);
                        changed = true;
                        tracing::info!(book_id = book.id, exists, "book file changed on disk");
                    }
                }
                if changed && last_emit.elapsed() > Duration::from_millis(400) {
                    let _ = app.emit("library-changed", ());
                    last_emit = Instant::now();
                }
            }
        })?;
    Ok(())
}

/// Folders worth watching: the parents of the books we know about, bounded so
/// we never watch a whole home directory tree.
fn watched_dirs(state: &AppState) -> Vec<PathBuf> {
    let mut dirs: HashSet<PathBuf> = HashSet::new();
    if let Ok(books) = state.db().list_books() {
        for book in books {
            if let Some(parent) = Path::new(&book.path).parent() {
                if parent.is_dir() {
                    dirs.insert(parent.to_path_buf());
                }
            }
        }
    }
    dirs.into_iter().take(48).collect()
}
