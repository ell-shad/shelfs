//! Import pipeline and library maintenance.
//!
//! Rules that hold everywhere in this module:
//! * book files are opened read-only and never modified;
//! * imports are idempotent per content hash (duplicates are reported, not
//!   silently swallowed);
//! * metadata/cover/index failures are reported per file, never as a panic.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

use crate::covers;
use crate::db::{Db, NewBook};
use crate::error::{AppError, AppResult};
use crate::formats;
use crate::models::*;
use crate::paths::AppPaths;
use crate::util::{now_ms, safe_file_stem, unit_from_hash};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DuplicatePolicy {
    Skip,
    Add,
}

impl DuplicatePolicy {
    pub fn parse(s: &str) -> Self {
        if s.eq_ignore_ascii_case("add") {
            DuplicatePolicy::Add
        } else {
            DuplicatePolicy::Skip
        }
    }
}

#[derive(Debug)]
pub struct Imported {
    pub book: Book,
    pub needs_cover: bool,
}

pub struct Library<'a> {
    pub db: &'a Db,
    pub paths: &'a AppPaths,
    copy_mode: bool,
}

impl<'a> Library<'a> {
    pub fn new(db: &'a Db, paths: &'a AppPaths) -> Self {
        Self {
            db,
            paths,
            copy_mode: false,
        }
    }

    pub fn with_copy_mode(mut self, copy: bool) -> Self {
        self.copy_mode = copy;
        self
    }

    pub fn hash_file(path: &Path) -> AppResult<(String, u64)> {
        let mut file = std::fs::File::open(path)?;
        let mut hasher = blake3::Hasher::new();
        let mut buf = vec![0u8; 256 * 1024];
        let mut size: u64 = 0;
        loop {
            let n = file.read(&mut buf)?;
            if n == 0 {
                break;
            }
            hasher.update(&buf[..n]);
            size += n as u64;
        }
        Ok((hasher.finalize().to_hex().to_string(), size))
    }

    pub fn import_file(&self, raw_path: &Path, policy: DuplicatePolicy) -> AppResult<Imported> {
        let path = raw_path
            .canonicalize()
            .map_err(|_| AppError::NotFound(raw_path.display().to_string()))?;
        let meta = std::fs::metadata(&path)?;
        if !meta.is_file() {
            return Err(AppError::Unsupported(format!(
                "{} is not a file",
                path.display()
            )));
        }
        if meta.len() == 0 {
            return Err(AppError::Corrupt("the file is empty".into()));
        }
        let format = formats::sniff(&path)?;
        let (hash, size) = Self::hash_file(&path)?;

        if self.db.find_by_path(&path.to_string_lossy())?.is_some() {
            return Err(AppError::Duplicate(
                path.file_name()
                    .map(|f| f.to_string_lossy().to_string())
                    .unwrap_or_default(),
            ));
        }

        if let Some(existing) = self.db.find_by_hash(&hash)? {
            if policy == DuplicatePolicy::Skip {
                return Err(AppError::Duplicate(existing.title));
            }
        }

        let handler = formats::handler_for(format);
        let probed = handler.probe(&path)?;

        let stored_path = if self.copy_mode {
            self.copy_into_library(&path, &hash, format)?
        } else {
            path.clone()
        };

        let (height, depth) = dimensions_for(&hash);
        let key = &hash[..16.min(hash.len())];
        let stored_cover = match probed.cover.as_deref() {
            Some(bytes) => covers::store_cover(&self.paths.covers_dir, key, bytes)?,
            None => None,
        };
        let color = stored_cover
            .as_ref()
            .map(|c| c.color.clone())
            .unwrap_or_else(|| covers::palette_color(&hash));

        let title = if probed.title.trim().is_empty() {
            crate::util::title_from_filename(&path)
        } else {
            probed.title.trim().to_string()
        };

        let book = self.db.insert_book(&NewBook {
            title,
            author: probed.author.trim().to_string(),
            format,
            path: stored_path.to_string_lossy().to_string(),
            content_hash: hash.clone(),
            pages: probed.pages.max(1),
            color: color.clone(),
            height,
            depth,
            language: probed.language.clone(),
            size_bytes: size as i64,
            encrypted: probed.encrypted,
            cover_path: stored_cover
                .as_ref()
                .map(|c| c.path.to_string_lossy().to_string()),
            status: Status::Want,
        })?;

        if !probed.chapters.is_empty() {
            if let Err(err) = self.db.replace_chapters(book.id, &probed.chapters) {
                tracing::warn!(%err, book_id = book.id, "could not index chapters");
            }
        }

        let needs_cover = format == BookFormat::Pdf && probed.cover.is_none();
        Ok(Imported { book, needs_cover })
    }

    fn copy_into_library(
        &self,
        source: &Path,
        hash: &str,
        format: BookFormat,
    ) -> AppResult<PathBuf> {
        std::fs::create_dir_all(&self.paths.books_dir)?;
        let name = format!("{hash}.{}", format.as_str());
        let dest = self.paths.books_dir.join(name);
        if dest.exists() {
            return Ok(dest);
        }
        let partial = dest.with_extension("part");
        std::fs::copy(source, &partial)?;
        std::fs::rename(&partial, &dest)?;
        Ok(dest)
    }

    /// Check every book's path, then try to find moved files by hash in the
    /// directories we already know about.
    pub fn recover_missing(&self) -> AppResult<Vec<i64>> {
        let books = self.db.list_books()?;
        let mut recovered = Vec::new();
        let mut by_dir: HashMap<PathBuf, Vec<&Book>> = HashMap::new();
        for book in &books {
            let p = Path::new(&book.path);
            if p.exists() {
                if book.missing {
                    self.db.set_missing(book.id, false)?;
                }
                continue;
            }
            if let Some(parent) = p.parent() {
                by_dir.entry(parent.to_path_buf()).or_default().push(book);
            }
        }
        for (dir, missing_books) in by_dir {
            if !dir.is_dir() {
                for book in missing_books {
                    self.db.set_missing(book.id, true)?;
                }
                continue;
            }
            let mut candidates: Vec<PathBuf> = Vec::new();
            if let Ok(entries) = std::fs::read_dir(&dir) {
                for entry in entries.flatten() {
                    let p = entry.path();
                    if p.is_file() {
                        candidates.push(p);
                    }
                    if candidates.len() >= 400 {
                        break;
                    }
                }
            }
            let mut hashes: HashMap<String, PathBuf> = HashMap::new();
            for candidate in candidates {
                if candidate == Path::new("/") {
                    continue;
                }
                if let Ok((hash, _)) = Self::hash_file(&candidate) {
                    hashes.entry(hash).or_insert(candidate);
                }
            }
            for book in missing_books {
                if let Some(found) = hashes.get(&book.content_hash) {
                    tracing::info!(book_id = book.id, ?found, "relinked moved book");
                    self.db
                        .set_path(book.id, &found.to_string_lossy(), book.size_bytes)?;
                    recovered.push(book.id);
                } else {
                    self.db.set_missing(book.id, true)?;
                }
            }
        }
        Ok(recovered)
    }

    pub fn relink(&self, book_id: i64, new_path: &Path) -> AppResult<Book> {
        let book = self.db.get_book(book_id)?;
        let path = new_path
            .canonicalize()
            .map_err(|_| AppError::NotFound(new_path.display().to_string()))?;
        let (hash, size) = Self::hash_file(&path)?;
        if hash != book.content_hash {
            return Err(AppError::Invalid(
                "That file is a different book (content hash does not match).".into(),
            ));
        }
        self.db
            .set_path(book.id, &path.to_string_lossy(), size as i64)?;
        self.db.get_book(book_id)
    }

    pub fn remove(&self, book_id: i64) -> AppResult<()> {
        let book = self.db.get_book(book_id)?;
        let path = PathBuf::from(&book.path);
        // Only ever delete a copy this app created itself.
        if path.starts_with(&self.paths.books_dir) && path.exists() {
            let _ = std::fs::remove_file(&path);
        }
        if let Some(cover) = book.cover_path.as_ref() {
            let cover_path = PathBuf::from(cover);
            if cover_path.starts_with(&self.paths.covers_dir) {
                let _ = std::fs::remove_file(cover_path);
            }
        }
        self.db.delete_book(book_id)?;
        Ok(())
    }

    pub fn backup(&self, dest: &Path) -> AppResult<BackupReport> {
        let payload = self.db.export_payload()?;
        let books = self.db.list_books()?;
        let file = std::fs::File::create(dest)?;
        let mut zip = zip::ZipWriter::new(file);
        let options: zip::write::SimpleFileOptions = zip::write::SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Deflated)
            .unix_permissions(0o644);
        zip.start_file("library.json", options)?;
        zip.write_all(serde_json::to_string_pretty(&payload).unwrap().as_bytes())?;
        let mut covers_written = 0u32;
        for book in &books {
            let Some(cover) = book.cover_path.as_ref() else {
                continue;
            };
            if let Ok(bytes) = std::fs::read(cover) {
                zip.start_file(format!("covers/{}.jpg", book.content_hash), options)?;
                zip.write_all(&bytes)?;
                covers_written += 1;
            }
        }
        zip.finish()?;
        Ok(BackupReport {
            books: books.len() as u32,
            covers: covers_written,
            path: dest.to_string_lossy().to_string(),
        })
    }

    pub fn restore(&self, src: &Path) -> AppResult<RestoreReport> {
        let file = std::fs::File::open(src)?;
        let mut zip = zip::ZipArchive::new(file)
            .map_err(|e| AppError::Corrupt(format!("backup archive: {e}")))?;
        let mut payload = String::new();
        {
            let mut entry = zip
                .by_name("library.json")
                .map_err(|_| AppError::Invalid("That backup has no library.json".into()))?;
            entry
                .by_ref()
                .take(64 * 1024 * 1024)
                .read_to_string(&mut payload)?;
        }
        let value: serde_json::Value = serde_json::from_str(&payload)
            .map_err(|e| AppError::Corrupt(format!("backup JSON: {e}")))?;
        let books: Vec<Book> =
            serde_json::from_value(value.get("books").cloned().unwrap_or_default())
                .unwrap_or_default();
        let bookmarks: Vec<Bookmark> =
            serde_json::from_value(value.get("bookmarks").cloned().unwrap_or_default())
                .unwrap_or_default();
        let annotations: Vec<Annotation> =
            serde_json::from_value(value.get("annotations").cloned().unwrap_or_default())
                .unwrap_or_default();

        let mut report = RestoreReport::default();
        let mut id_map: HashMap<i64, i64> = HashMap::new();
        let mut cover_entries: HashMap<String, ()> = HashMap::new();
        for name in zip.file_names().flatten() {
            if name.starts_with("covers/") {
                cover_entries.insert(name.to_string(), ());
            }
        }

        for book in books {
            if let Some(existing) = self.db.find_by_hash(&book.content_hash)? {
                id_map.insert(book.id, existing.id);
                report.books_merged += 1;
                continue;
            }
            let cover_name = format!("covers/{}.jpg", book.content_hash);
            let mut cover_path = None;
            let mut color = if crate::util::is_hex_color(&book.color) {
                book.color.clone()
            } else {
                covers::palette_color(&book.content_hash)
            };
            if cover_entries.contains_key(&cover_name) {
                if let Ok(mut entry) = zip.by_name(&cover_name) {
                    let mut bytes = Vec::new();
                    let _ = entry
                        .by_ref()
                        .take(16 * 1024 * 1024)
                        .read_to_end(&mut bytes);
                    if let Ok(Some(stored)) = covers::store_cover(
                        &self.paths.covers_dir,
                        &book.content_hash[..16.min(book.content_hash.len())],
                        &bytes,
                    ) {
                        color = stored.color;
                        cover_path = Some(stored.path.to_string_lossy().to_string());
                    }
                }
            }
            let exists = Path::new(&book.path).exists();
            let new = self.db.insert_book(&NewBook {
                title: book.title.clone(),
                author: book.author.clone(),
                format: book.format,
                path: book.path.clone(),
                content_hash: book.content_hash.clone(),
                pages: book.pages.max(1),
                color,
                height: book.height,
                depth: book.depth,
                language: book.language.clone(),
                size_bytes: book.size_bytes,
                encrypted: book.encrypted,
                cover_path,
                status: book.status,
            })?;
            self.db.set_restored_state(
                new.id,
                book.progress,
                book.locator.as_deref(),
                book.last_opened_at,
            )?;
            if !exists {
                self.db.set_missing(new.id, true)?;
            }
            id_map.insert(book.id, new.id);
            report.books_added += 1;
        }

        for bm in bookmarks {
            if let Some(new_id) = id_map.get(&bm.book_id) {
                self.db
                    .add_bookmark(*new_id, &bm.locator, &bm.label, bm.page)?;
                report.bookmarks += 1;
            }
        }
        for ann in annotations {
            if let Some(new_id) = id_map.get(&ann.book_id) {
                self.db.add_annotation(
                    *new_id,
                    &NewAnnotation {
                        locator: ann.locator,
                        quote: ann.quote,
                        note: ann.note,
                        color: ann.color,
                        page: ann.page,
                    },
                )?;
                report.annotations += 1;
            }
        }
        Ok(report)
    }
}

pub fn dimensions_for(hash: &str) -> (f64, f64) {
    let height = 1.15 + 0.45 * unit_from_hash(hash, 1);
    let depth = 0.85 + 0.13 * unit_from_hash(hash, 2);
    (height, depth)
}

/// Expand directories into the book files they contain, depth-limited.
pub fn expand_paths(inputs: &[String]) -> Vec<PathBuf> {
    let mut out = Vec::new();
    for input in inputs {
        let path = PathBuf::from(input);
        if path.is_dir() {
            walk_dir(&path, 0, &mut out);
        } else {
            out.push(path);
        }
        if out.len() >= 5000 {
            break;
        }
    }
    out.sort();
    out.dedup();
    out
}

fn walk_dir(dir: &Path, depth: u32, out: &mut Vec<PathBuf>) {
    if depth > 4 || out.len() >= 5000 {
        return;
    }
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            walk_dir(&path, depth + 1, out);
        } else if is_book_path(&path) {
            out.push(path);
        }
    }
}

fn is_book_path(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| e.eq_ignore_ascii_case("pdf") || e.eq_ignore_ascii_case("epub"))
}

pub fn guess_title(path: &Path) -> String {
    safe_file_stem(&crate::util::title_from_filename(path))
}

pub fn backup_path_suggestion(dir: &Path) -> PathBuf {
    let stamp = now_ms() / 1000;
    dir.join(format!("bookshelf-backup-{stamp}.zip"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fixtures::{write_epub, write_pdf, EpubOptions};

    fn setup() -> (tempfile::TempDir, AppPaths, Db) {
        let dir = tempfile::tempdir().unwrap();
        let paths = AppPaths::with_root(dir.path());
        paths.ensure().unwrap();
        let db = Db::open(&paths.db_path).unwrap();
        (dir, paths, db)
    }

    #[test]
    fn imports_epub_metadata_cover_and_text() {
        let (dir, paths, db) = setup();
        let epub = write_epub(dir.path(), &EpubOptions::default()).unwrap();
        let lib = Library::new(&db, &paths);
        let imported = lib.import_file(&epub, DuplicatePolicy::Skip).unwrap();
        assert_eq!(imported.book.title, "The Test Book");
        assert_eq!(imported.book.author, "Test Author");
        assert_eq!(imported.book.format, BookFormat::Epub);
        assert!(imported.book.pages >= 1);
        assert!(imported.book.cover_path.as_ref().unwrap().ends_with(".jpg"));
        assert!(crate::util::is_hex_color(&imported.book.color));
        assert!(imported.book.height >= 1.15 && imported.book.height <= 1.6);
        assert!(imported.book.depth >= 0.85 && imported.book.depth <= 0.98);
        assert!(!imported.needs_cover);
        // Chapter text is searchable.
        let hits = db.search_chapters(imported.book.id, "needle", 10).unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].spine_index, 1);
    }

    #[test]
    fn duplicate_is_reported_and_can_be_forced() {
        let (dir, paths, db) = setup();
        let epub = write_epub(dir.path(), &EpubOptions::default()).unwrap();
        let lib = Library::new(&db, &paths);
        lib.import_file(&epub, DuplicatePolicy::Skip).unwrap();
        let err = lib.import_file(&epub, DuplicatePolicy::Skip).unwrap_err();
        assert!(matches!(err, AppError::Duplicate(_)));
        // Same content from another path is allowed when the user says so.
        let copy = dir.path().join("second-copy.epub");
        std::fs::copy(&epub, &copy).unwrap();
        let again = lib.import_file(&copy, DuplicatePolicy::Add).unwrap();
        assert_eq!(again.book.title, "The Test Book");
        assert_eq!(db.list_books().unwrap().len(), 2);
        // The same absolute path can never be added twice.
        let err = lib.import_file(&epub, DuplicatePolicy::Add).unwrap_err();
        assert!(matches!(err, AppError::Duplicate(_)));
    }

    #[test]
    fn drm_epub_is_rejected_with_a_clear_error() {
        let (dir, paths, db) = setup();
        let epub = write_epub(
            dir.path(),
            &EpubOptions {
                drm: true,
                title: "Locked Book".into(),
                ..Default::default()
            },
        )
        .unwrap();
        let lib = Library::new(&db, &paths);
        let err = lib.import_file(&epub, DuplicatePolicy::Skip).unwrap_err();
        assert!(err.to_string().contains("DRM"), "{err}");
        assert!(db.list_books().unwrap().is_empty());
    }

    #[test]
    fn zip_bomb_is_rejected() {
        let (dir, paths, db) = setup();
        let epub = write_epub(
            dir.path(),
            &EpubOptions {
                zip_bomb: true,
                title: "Bomb".into(),
                ..Default::default()
            },
        )
        .unwrap();
        let lib = Library::new(&db, &paths);
        let err = lib.import_file(&epub, DuplicatePolicy::Skip).unwrap_err();
        assert!(
            format!("{err}").contains("compression") || format!("{err}").contains("large"),
            "{err}"
        );
    }

    #[test]
    fn copy_mode_stores_a_copy_and_removal_deletes_only_the_copy() {
        let (dir, paths, db) = setup();
        let pdf = dir.path().join("my book.pdf");
        write_pdf(&pdf, 2, "Copied Book").unwrap();
        let lib = Library::new(&db, &paths).with_copy_mode(true);
        let imported = lib.import_file(&pdf, DuplicatePolicy::Skip).unwrap();
        let stored = PathBuf::from(&imported.book.path);
        assert!(stored.starts_with(&paths.books_dir));
        assert!(stored.exists());
        assert!(pdf.exists(), "the original must be untouched");
        lib.remove(imported.book.id).unwrap();
        assert!(!stored.exists());
        assert!(pdf.exists(), "removal must never delete the user's file");
    }

    #[test]
    fn pdf_import_requests_a_cover() {
        let (dir, paths, db) = setup();
        let pdf = dir.path().join("novel.pdf");
        write_pdf(&pdf, 12, "Novel").unwrap();
        let lib = Library::new(&db, &paths);
        let imported = lib.import_file(&pdf, DuplicatePolicy::Skip).unwrap();
        assert!(imported.needs_cover);
        assert_eq!(imported.book.pages, 12);
        assert!(imported.book.cover_path.is_none());
        assert!(crate::util::is_hex_color(&imported.book.color));
    }

    #[test]
    fn relink_requires_matching_content() {
        let (dir, paths, db) = setup();
        let pdf = dir.path().join("book.pdf");
        write_pdf(&pdf, 1, "Relink Me").unwrap();
        let lib = Library::new(&db, &paths);
        let book = lib.import_file(&pdf, DuplicatePolicy::Skip).unwrap().book;
        let moved = dir.path().join("moved.pdf");
        std::fs::rename(&pdf, &moved).unwrap();
        assert!(lib.recover_missing().unwrap().contains(&book.id));
        assert!(!db.get_book(book.id).unwrap().missing);

        let other = dir.path().join("other.pdf");
        write_pdf(&other, 2, "Different").unwrap();
        assert!(lib.relink(book.id, &other).is_err());
        assert!(lib.relink(book.id, &moved).is_ok());
    }

    #[test]
    fn missing_book_is_flagged_when_path_disappears() {
        let (dir, paths, db) = setup();
        let pdf = dir.path().join("gone.pdf");
        write_pdf(&pdf, 1, "Gone").unwrap();
        let lib = Library::new(&db, &paths);
        let book = lib.import_file(&pdf, DuplicatePolicy::Skip).unwrap().book;
        std::fs::remove_file(&pdf).unwrap();
        lib.recover_missing().unwrap();
        assert!(db.get_book(book.id).unwrap().missing);
    }

    #[test]
    fn backup_and_restore_roundtrip() {
        let (dir, paths, db) = setup();
        let epub = write_epub(dir.path(), &EpubOptions::default()).unwrap();
        let lib = Library::new(&db, &paths);
        let book = lib.import_file(&epub, DuplicatePolicy::Skip).unwrap().book;
        db.add_bookmark(
            book.id,
            &Locator::Epub {
                spine_index: 0,
                href: "OEBPS/text/ch1.xhtml".into(),
                progress: 0.1,
                text_offset: None,
                anchor: None,
            },
            "Start",
            None,
        )
        .unwrap();
        db.save_progress(
            book.id,
            &Locator::Epub {
                spine_index: 1,
                href: "OEBPS/text/ch2.xhtml".into(),
                progress: 0.5,
                text_offset: None,
                anchor: None,
            },
            0.5,
        )
        .unwrap();
        let backup = dir.path().join("backup.zip");
        let report = lib.backup(&backup).unwrap();
        assert_eq!(report.books, 1);
        assert!(backup.exists());

        let (dir2, paths2, db2) = setup();
        let restored = Library::new(&db2, &paths2).restore(&backup).unwrap();
        assert_eq!(restored.books_added, 1);
        assert_eq!(restored.bookmarks, 1);
        let restored_books = db2.list_books().unwrap();
        assert_eq!(restored_books.len(), 1);
        assert!((restored_books[0].progress - 0.5).abs() < 1e-6);
        assert!(restored_books[0].cover_path.is_some());
        // Restoring the same backup again merges rather than duplicates.
        let twice = Library::new(&db2, &paths2).restore(&backup).unwrap();
        assert_eq!(twice.books_merged, 1);
        assert_eq!(db2.list_books().unwrap().len(), 1);
        let _ = dir2;
    }

    #[test]
    fn expand_paths_finds_books_in_folders() {
        let dir = tempfile::tempdir().unwrap();
        let nested = dir.path().join("a/b");
        std::fs::create_dir_all(&nested).unwrap();
        write_pdf(&nested.join("one.pdf"), 1, "One").unwrap();
        write_epub(dir.path(), &EpubOptions::default()).unwrap();
        std::fs::write(dir.path().join("notes.txt"), b"hi").unwrap();
        let found = expand_paths(&[dir.path().to_string_lossy().to_string()]);
        assert_eq!(found.len(), 2);
    }
}
