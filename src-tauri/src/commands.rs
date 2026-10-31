//! IPC surface. Every command is typed, returns `AppResult<T>` and is exported
//! to TypeScript by tauri-specta (see `ui/src/bindings.ts`).

use std::path::Path;
use std::sync::atomic::Ordering;
use std::sync::Arc;

use tauri::{AppHandle, Emitter, State};

use crate::db::Db;
use crate::error::{AppError, AppResult};
use crate::formats::epub;
use crate::layout;
use crate::library::{self, DuplicatePolicy, Library};
use crate::models::*;
use crate::protocol;
use crate::state::AppState;
use crate::util::{now_ms, FoldedText};

type St<'a> = State<'a, Arc<AppState>>;

fn decorate(book: &mut Book) {
    book.cover_url = book.cover_path.as_ref().map(|_| {
        format!(
            "{}/cover/{}?v={}",
            protocol::base(),
            book.id,
            book.last_opened_at.unwrap_or(book.added_at)
        )
    });
}

fn decorate_all(books: &mut [Book]) {
    for book in books.iter_mut() {
        decorate(book);
    }
}

fn sort_key(s: &str) -> String {
    s.trim().to_lowercase()
}

fn sorted(mut books: Vec<Book>, sort: SortKey) -> Vec<Book> {
    match sort {
        SortKey::Manual => books.sort_by_key(|b| (b.position, b.id)),
        SortKey::Title => books.sort_by(|a, b| {
            sort_key(&a.title)
                .cmp(&sort_key(&b.title))
                .then_with(|| sort_key(&a.author).cmp(&sort_key(&b.author)))
                .then_with(|| a.position.cmp(&b.position))
        }),
        SortKey::Author => books.sort_by(|a, b| {
            sort_key(&a.author)
                .cmp(&sort_key(&b.author))
                .then_with(|| sort_key(&a.title).cmp(&sort_key(&b.title)))
                .then_with(|| a.position.cmp(&b.position))
        }),
        SortKey::Added => books.sort_by(|a, b| {
            b.added_at
                .cmp(&a.added_at)
                .then_with(|| a.position.cmp(&b.position))
        }),
        SortKey::LastOpened => books.sort_by(|a, b| {
            b.last_opened_at
                .unwrap_or(0)
                .cmp(&a.last_opened_at.unwrap_or(0))
                .then_with(|| a.position.cmp(&b.position))
        }),
        SortKey::Status => books.sort_by(|a, b| {
            a.status
                .weight()
                .cmp(&b.status.weight())
                .then_with(|| sort_key(&a.title).cmp(&sort_key(&b.title)))
                .then_with(|| a.position.cmp(&b.position))
        }),
    }
    books
}

fn matches_filter(book: &Book, filter: StatusFilter) -> bool {
    match filter {
        StatusFilter::All => true,
        StatusFilter::Want => book.status == Status::Want,
        StatusFilter::Reading => book.status == Status::Reading,
        StatusFilter::Read => book.status == Status::Read,
    }
}

fn snapshot(state: &AppState) -> AppResult<LibrarySnapshot> {
    let db = state.db();
    let settings = db.load_settings();
    let all = db.list_books()?;
    let counts = db.counts()?;
    let total = all.len() as u32;
    drop(db);

    let mut books: Vec<Book> = all
        .into_iter()
        .filter(|b| matches_filter(b, settings.filter))
        .collect();
    books = sorted(books, settings.sort);
    decorate_all(&mut books);

    let layout_books: Vec<layout::LayoutBook> = books
        .iter()
        .map(|b| layout::LayoutBook {
            id: b.id,
            thickness: b.thickness(),
            height: b.height,
            depth: b.depth,
            shelf: b.shelf.map(|shelf| shelf.max(0) as u32),
        })
        .collect();
    let layout = layout::pack(&layout_books);
    Ok(LibrarySnapshot {
        books,
        layout,
        settings,
        total,
        by_status: counts,
    })
}

// ---------------------------------------------------------------- app info

#[tauri::command]
#[specta::specta]
pub fn get_app_info(app: AppHandle, state: St<'_>) -> AppResult<AppInfo> {
    Ok(AppInfo {
        version: env!("CARGO_PKG_VERSION").to_string(),
        data_dir: state.paths.data_dir.to_string_lossy().to_string(),
        cache_dir: state.paths.cache_dir.to_string_lossy().to_string(),
        config_dir: state.paths.config_dir.to_string_lossy().to_string(),
        db_path: state.paths.db_path.to_string_lossy().to_string(),
        webkit_version: tauri::webview_version().unwrap_or_else(|_| "unknown".into()),
        app_id: app.config().identifier.clone(),
        protocol_base: protocol::base().to_string(),
    })
}

#[tauri::command]
#[specta::specta]
pub fn get_library(state: St<'_>) -> AppResult<LibrarySnapshot> {
    snapshot(state.inner().as_ref())
}

#[tauri::command]
#[specta::specta]
pub fn get_settings(state: St<'_>) -> Settings {
    state.settings()
}

#[tauri::command]
#[specta::specta]
pub fn set_settings(app: AppHandle, state: St<'_>, patch: SettingsPatch) -> AppResult<Settings> {
    let mut settings = state.settings();
    settings.apply(&patch);
    state.save_settings(&settings)?;
    let _ = app.emit("settings-changed", &settings);
    Ok(settings)
}

#[tauri::command]
#[specta::specta]
pub fn reset_library_view(state: St<'_>) -> AppResult<Settings> {
    let mut settings = state.settings();
    settings.sort = SortKey::Manual;
    settings.filter = StatusFilter::All;
    settings.view = LibraryView::Shelf;
    state.save_settings(&settings)?;
    Ok(settings)
}

// ------------------------------------------------------------------ import

#[tauri::command]
#[specta::specta]
pub fn check_duplicates(state: St<'_>, paths: Vec<String>) -> AppResult<Vec<DuplicateHit>> {
    let files = library::expand_paths(&paths);
    let db = state.db();
    let mut hits = Vec::new();
    for file in files {
        let Ok((hash, _)) = Library::hash_file(&file) else {
            continue;
        };
        if let Ok(Some(existing)) = db.find_by_hash(&hash) {
            hits.push(DuplicateHit {
                title: crate::util::title_from_filename(&file),
                path: file.to_string_lossy().to_string(),
                existing_book_id: existing.id,
                existing_title: existing.title,
            });
        }
    }
    Ok(hits)
}

#[tauri::command]
#[specta::specta]
pub fn import_files(
    app: AppHandle,
    state: St<'_>,
    paths: Vec<String>,
    policy: String,
) -> AppResult<ImportSummary> {
    if state.importing.swap(true, Ordering::SeqCst) {
        return Err(AppError::Invalid(
            "An import is already running — one moment.".into(),
        ));
    }
    let result = import_files_inner(&app, state.inner().as_ref(), &paths, &policy);
    state.importing.store(false, Ordering::SeqCst);
    let summary = result?;
    let _ = app.emit("library-changed", ());
    Ok(summary)
}

fn import_files_inner(
    app: &AppHandle,
    state: &AppState,
    paths: &[String],
    policy: &str,
) -> AppResult<ImportSummary> {
    let files = library::expand_paths(paths);
    let total = files.len() as u32;
    let job_id = format!("import-{}", now_ms());
    let settings = state.settings();
    let copy = settings.storage_mode == StorageMode::Copy;
    // Use a dedicated connection: the UI keeps reading the library while a
    // large book is hashed and parsed.
    let db = Db::open(&state.paths.db_path)?;
    let lib = Library::new(&db, &state.paths).with_copy_mode(copy);

    let mut summary = ImportSummary {
        imported: Vec::new(),
        failures: Vec::new(),
        duplicates_skipped: Vec::new(),
        needs_cover: Vec::new(),
    };

    for (index, file) in files.iter().enumerate() {
        let name = file
            .file_name()
            .map(|f| f.to_string_lossy().to_string())
            .unwrap_or_default();
        let _ = app.emit(
            "import-progress",
            ImportProgress {
                job_id: job_id.clone(),
                done: index as u32,
                total,
                current: name,
                phase: "reading".into(),
            },
        );
        match lib.import_file(file, DuplicatePolicy::parse(policy)) {
            Ok(imported) => {
                let mut book = imported.book;
                decorate(&mut book);
                if imported.needs_cover {
                    summary.needs_cover.push(book.id);
                }
                summary.imported.push(book);
                let _ = app.emit("library-changed", ());
            }
            Err(AppError::Duplicate(title)) => {
                summary
                    .duplicates_skipped
                    .push(format!("{title} — {}", file.display()));
            }
            Err(err) => {
                summary.failures.push(ImportFailure {
                    path: file.to_string_lossy().to_string(),
                    message: err.to_string(),
                    kind: failure_kind(&err).to_string(),
                });
            }
        }
        let _ = app.emit(
            "import-progress",
            ImportProgress {
                job_id: job_id.clone(),
                done: index as u32 + 1,
                total,
                current: String::new(),
                phase: "done".into(),
            },
        );
    }
    Ok(summary)
}

fn failure_kind(err: &AppError) -> &'static str {
    match err {
        AppError::Duplicate(_) => "duplicate",
        AppError::Protected(_) => "protected",
        AppError::Corrupt(_) => "corrupt",
        AppError::Unsupported(_) => "unsupported",
        AppError::NotFound(_) => "missing",
        _ => "error",
    }
}

#[tauri::command]
#[specta::specta]
pub fn save_pdf_cover(
    app: AppHandle,
    state: St<'_>,
    book_id: i64,
    png: Vec<u8>,
) -> AppResult<Book> {
    let db = state.db();
    let book = db.get_book(book_id)?;
    let key = &book.content_hash[..book.content_hash.len().min(16)];
    let stored = crate::covers::store_cover(&state.paths.covers_dir, key, &png)?
        .ok_or_else(|| AppError::Format("could not decode the rendered cover".into()))?;
    db.set_cover(book_id, &stored.path.to_string_lossy(), &stored.color)?;
    let mut book = db.get_book(book_id)?;
    decorate(&mut book);
    drop(db);
    let _ = app.emit("library-changed", ());
    Ok(book)
}

#[tauri::command]
#[specta::specta]
pub fn set_book_pages(state: St<'_>, book_id: i64, pages: i64) -> AppResult<()> {
    state.db().set_pages(book_id, pages)
}

// ------------------------------------------------------------------- books

#[tauri::command]
#[specta::specta]
pub fn update_book(
    app: AppHandle,
    state: St<'_>,
    book_id: i64,
    patch: BookPatch,
) -> AppResult<Book> {
    let mut book = state.db().update_book(book_id, &patch)?;
    decorate(&mut book);
    let _ = app.emit("library-changed", ());
    Ok(book)
}

#[tauri::command]
#[specta::specta]
pub fn remove_book(app: AppHandle, state: St<'_>, book_id: i64) -> AppResult<()> {
    Library::new(&state.db(), &state.paths).remove(book_id)?;
    let _ = app.emit("library-changed", ());
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub fn move_book(app: AppHandle, state: St<'_>, book_id: i64, target_index: i64) -> AppResult<()> {
    state.db().reorder(book_id, target_index)?;
    let _ = app.emit("library-changed", ());
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub fn set_book_shelf(
    app: AppHandle,
    state: St<'_>,
    book_id: i64,
    shelf: Option<i64>,
) -> AppResult<()> {
    state.db().set_book_shelf(book_id, shelf)?;
    let _ = app.emit("library-changed", ());
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub fn relink_book(app: AppHandle, state: St<'_>, book_id: i64, path: String) -> AppResult<Book> {
    let mut book = Library::new(&state.db(), &state.paths).relink(book_id, Path::new(&path))?;
    decorate(&mut book);
    let _ = app.emit("library-changed", ());
    Ok(book)
}

#[tauri::command]
#[specta::specta]
pub fn refresh_missing(app: AppHandle, state: St<'_>) -> AppResult<Vec<i64>> {
    let recovered = Library::new(&state.db(), &state.paths).recover_missing()?;
    let _ = app.emit("library-changed", ());
    Ok(recovered)
}

#[tauri::command]
#[specta::specta]
pub fn search_library(state: St<'_>, query: String) -> AppResult<Vec<i64>> {
    let q = query.trim();
    if q.is_empty() {
        return Ok(Vec::new());
    }
    let books = state.db().list_books()?;
    let mut ids: Vec<i64> = Vec::new();
    for book in books {
        let haystack = format!("{} {}", book.title, book.author);
        if !FoldedText::new(&haystack).find_all(q).is_empty() {
            ids.push(book.id);
        }
    }
    Ok(ids)
}

// ------------------------------------------------------------------ reader

#[tauri::command]
#[specta::specta]
pub fn open_book(app: AppHandle, state: St<'_>, book_id: i64) -> AppResult<OpenedBook> {
    let db = state.db();
    let book = db.get_book(book_id)?;
    if !Path::new(&book.path).exists() {
        db.set_missing(book_id, true)?;
        return Err(AppError::NotFound(format!(
            "The file for “{}” is missing. Relink it from the book card.",
            book.title
        )));
    }
    let book = db.mark_opened(book_id)?;
    db.start_session(book_id)?;
    let locator = book.decode_locator();
    let settings = db.load_settings();
    let char_counts = db.chapter_char_counts(book_id)?;
    drop(db);

    let mut book = book;
    decorate(&mut book);
    let base = protocol::base();
    let (doc_url, epub_package) = match book.format {
        BookFormat::Pdf => (format!("{base}/pdf/{}", book.id), None),
        BookFormat::Epub => {
            let package_base = format!("{base}/epub/{}/", book.id);
            let package = epub::package(Path::new(&book.path), &package_base, &char_counts)?;
            (
                format!(
                    "{base}/epub/{}/{}",
                    book.id,
                    package
                        .chapters
                        .first()
                        .map(|c| c.href.as_str())
                        .unwrap_or("")
                ),
                Some(package),
            )
        }
    };
    let password_required = book.encrypted;
    let _ = app.emit("library-changed", ());
    let _ = settings; // reader prefs are read by the reader itself
    Ok(OpenedBook {
        book,
        doc_url,
        epub: epub_package,
        locator,
        pdf_password_required: password_required,
    })
}

#[tauri::command]
#[specta::specta]
pub fn close_book(state: St<'_>, book_id: i64) -> AppResult<()> {
    state.db().end_session(book_id)
}

#[tauri::command]
#[specta::specta]
pub fn save_progress(
    state: St<'_>,
    book_id: i64,
    locator: Locator,
    progress: f64,
) -> AppResult<()> {
    state.db().save_progress(book_id, &locator, progress)
}

#[tauri::command]
#[specta::specta]
pub fn get_chapter(state: St<'_>, book_id: i64, href: String) -> AppResult<String> {
    let db = state.db();
    let book = db.get_book(book_id)?;
    let publisher_styles = db.load_settings().reader.epub.publisher_styles;
    drop(db);
    if book.format != BookFormat::Epub {
        return Err(AppError::Invalid("Not an EPUB".into()));
    }
    epub::chapter_html(Path::new(&book.path), &href, book_id, publisher_styles)
}

/// The PDF's bytes, base64-encoded, for pdf.js.
///
/// pdf.js fetches its document from a worker, and WebKitGTK does not route a
/// worker's `fetch` to the app's custom scheme, so the `bookshelf://` URL the
/// protocol module also serves is not reachable from it. Passing the bytes over
/// IPC keeps the reader working, stays inside the sandbox and needs no CORS or
/// range-request support. The trade-off (one copy of the file in memory) is
/// recorded in docs/DECISIONS.md.
#[tauri::command]
#[specta::specta]
pub fn pdf_bytes(state: St<'_>, book_id: i64) -> AppResult<String> {
    let db = state.db();
    let book = db.get_book(book_id)?;
    drop(db);
    if book.format != BookFormat::Pdf {
        return Err(AppError::Invalid("Not a PDF".into()));
    }
    let bytes = std::fs::read(&book.path)?;
    Ok(crate::util::base64_encode(&bytes))
}

#[tauri::command]
#[specta::specta]
pub fn get_epub_package(state: St<'_>, book_id: i64) -> AppResult<EpubPackage> {
    let db = state.db();
    let book = db.get_book(book_id)?;
    if book.format != BookFormat::Epub {
        return Err(AppError::Invalid("Not an EPUB".into()));
    }
    let counts = db.chapter_char_counts(book_id)?;
    drop(db);
    let base = format!("{}/epub/{}/", protocol::base(), book_id);
    epub::package(Path::new(&book.path), &base, &counts)
}

#[tauri::command]
#[specta::specta]
pub fn search_book(
    state: St<'_>,
    book_id: i64,
    query: String,
    limit: Option<u32>,
) -> AppResult<Vec<ChapterSearchHit>> {
    state
        .db()
        .search_chapters(book_id, &query, limit.unwrap_or(200) as usize)
}

// --------------------------------------------------------------- bookmarks

#[tauri::command]
#[specta::specta]
pub fn list_bookmarks(state: St<'_>, book_id: i64) -> AppResult<Vec<Bookmark>> {
    state.db().list_bookmarks(book_id)
}

#[tauri::command]
#[specta::specta]
pub fn add_bookmark(
    state: St<'_>,
    book_id: i64,
    locator: Locator,
    label: Option<String>,
    page: Option<i64>,
) -> AppResult<Bookmark> {
    state
        .db()
        .add_bookmark(book_id, &locator, label.as_deref().unwrap_or(""), page)
}

#[tauri::command]
#[specta::specta]
pub fn remove_bookmark(state: St<'_>, bookmark_id: i64) -> AppResult<()> {
    state.db().remove_bookmark(bookmark_id)
}

#[tauri::command]
#[specta::specta]
pub fn rename_bookmark(state: St<'_>, bookmark_id: i64, label: String) -> AppResult<()> {
    state.db().set_bookmark_label(bookmark_id, &label)
}

// ------------------------------------------------------------- annotations

#[tauri::command]
#[specta::specta]
pub fn list_annotations(state: St<'_>, book_id: i64) -> AppResult<Vec<Annotation>> {
    state.db().list_annotations(book_id)
}

#[tauri::command]
#[specta::specta]
pub fn add_annotation(
    state: St<'_>,
    book_id: i64,
    annotation: NewAnnotation,
) -> AppResult<Annotation> {
    state.db().add_annotation(book_id, &annotation)
}

#[tauri::command]
#[specta::specta]
pub fn update_annotation(
    state: St<'_>,
    annotation_id: i64,
    patch: AnnotationPatch,
) -> AppResult<Annotation> {
    state.db().update_annotation(annotation_id, &patch)
}

#[tauri::command]
#[specta::specta]
pub fn remove_annotation(state: St<'_>, annotation_id: i64) -> AppResult<()> {
    state.db().remove_annotation(annotation_id)
}

#[tauri::command]
#[specta::specta]
pub fn export_annotations(state: St<'_>, book_id: i64, format: String) -> AppResult<String> {
    let db = state.db();
    let book = db.get_book(book_id)?;
    let bookmarks = db.list_bookmarks(book_id)?;
    let annotations = db.list_annotations(book_id)?;
    drop(db);
    if format.eq_ignore_ascii_case("json") {
        let payload = serde_json::json!({
            "app": "bookshelf",
            "format": 1,
            "exportedAt": now_ms(),
            "book": {
                "title": book.title,
                "author": book.author,
                "format": book.format.as_str(),
                "contentHash": book.content_hash,
            },
            "bookmarks": bookmarks,
            "annotations": annotations,
        });
        return Ok(serde_json::to_string_pretty(&payload).unwrap_or_default());
    }
    let mut out = String::new();
    out.push_str(&format!("# {}\n\n", book.title));
    if !book.author.trim().is_empty() {
        out.push_str(&format!("*by {}*\n\n", book.author));
    }
    if !annotations.is_empty() {
        out.push_str("## Highlights & notes\n\n");
        for a in &annotations {
            let place = match &a.locator {
                Locator::Pdf { page, .. } => format!("page {page}"),
                Locator::Epub { href, .. } => href.clone(),
            };
            out.push_str(&format!("> {}\n\n", a.quote.replace('\n', " ")));
            if !a.note.trim().is_empty() {
                out.push_str(&format!("{}\n\n", a.note.trim()));
            }
            out.push_str(&format!("— {place}, {}\n\n", a.color_str()));
        }
    }
    if !bookmarks.is_empty() {
        out.push_str("## Bookmarks\n\n");
        for b in &bookmarks {
            let place = match &b.locator {
                Locator::Pdf { page, .. } => format!("page {page}"),
                Locator::Epub { href, progress, .. } => {
                    format!("{href} ({:.0}%)", progress * 100.0)
                }
            };
            let label = if b.label.trim().is_empty() {
                "Bookmark"
            } else {
                b.label.trim()
            };
            out.push_str(&format!("- {label} — {place}\n"));
        }
    }
    Ok(out)
}

trait AnnotationColorName {
    fn color_str(&self) -> &'static str;
}

impl AnnotationColorName for Annotation {
    fn color_str(&self) -> &'static str {
        crate::db::color_str(self.color)
    }
}

/// Writes an export chosen by the user. Restricted to text-ish extensions and
/// bounded size so a compromised renderer cannot use it as a general file
/// writer.
#[tauri::command]
#[specta::specta]
pub fn write_export_file(path: String, contents: String) -> AppResult<()> {
    let target = Path::new(&path);
    let ok_ext = target
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| {
            matches!(
                e.to_ascii_lowercase().as_str(),
                "md" | "markdown" | "json" | "txt"
            )
        })
        .unwrap_or(false);
    if !ok_ext {
        return Err(AppError::Invalid(
            "Exports must be .md or .json files".into(),
        ));
    }
    if contents.len() > 32 * 1024 * 1024 {
        return Err(AppError::Invalid("Export is too large".into()));
    }
    if let Some(parent) = target.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(target, contents)?;
    Ok(())
}

// ----------------------------------------------------------- backup/restore

#[tauri::command]
#[specta::specta]
pub fn backup_library(state: St<'_>, path: String) -> AppResult<BackupReport> {
    let target = Path::new(&path);
    if !target
        .extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| e.eq_ignore_ascii_case("zip"))
    {
        return Err(AppError::Invalid(
            "Choose a .zip file for the backup".into(),
        ));
    }
    Library::new(&state.db(), &state.paths).backup(target)
}

#[tauri::command]
#[specta::specta]
pub fn restore_library(app: AppHandle, state: St<'_>, path: String) -> AppResult<RestoreReport> {
    let report = Library::new(&state.db(), &state.paths).restore(Path::new(&path))?;
    let _ = app.emit("library-changed", ());
    Ok(report)
}

// -------------------------------------------------------------------- misc

#[tauri::command]
#[specta::specta]
pub fn take_pending_files(state: St<'_>) -> Vec<String> {
    let mut pending = state.pending.lock().unwrap_or_else(|e| e.into_inner());
    std::mem::take(&mut *pending)
}

#[tauri::command]
#[specta::specta]
pub fn open_external(url: String) -> AppResult<()> {
    let lower = url.to_ascii_lowercase();
    if !(lower.starts_with("http://")
        || lower.starts_with("https://")
        || lower.starts_with("mailto:"))
    {
        return Err(AppError::Invalid(
            "Only http(s) and mailto links can be opened".into(),
        ));
    }
    #[cfg(target_os = "linux")]
    {
        std::process::Command::new("xdg-open")
            .arg(&url)
            .spawn()
            .map_err(|e| AppError::Invalid(format!("xdg-open: {e}")))?;
        Ok(())
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = url;
        Err(AppError::Invalid(
            "Opening links is only wired up for Linux".into(),
        ))
    }
}
