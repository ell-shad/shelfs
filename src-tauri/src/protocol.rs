//! `bookshelf://` resource protocol.
//!
//! Serves three things, and only for books registered in the database:
//!   /pdf/<book id>              the PDF bytes, for pdf.js
//!   /epub/<book id>/<entry>     one zip entry (chapter, image, CSS, font)
//!   /cover/<book id>            the extracted cover JPEG
//!
//! Entries are canonicalised before lookup (no `..`, no absolute paths) so a
//! hostile EPUB cannot reach outside its own archive.

use std::path::Path;
use std::sync::Arc;
use std::time::UNIX_EPOCH;

use tauri::http::{header, Request, Response, StatusCode};
use tauri::{AppHandle, Manager, Runtime};

use crate::error::{AppError, AppResult};
use crate::formats::epub::{self, EpubArchive};
use crate::models::BookFormat;
use crate::state::{AppState, CachedArchive};
use crate::util::percent_decode;

/// Where the webview can reach the protocol. WebKitGTK (and WebView2) map
/// custom schemes to `http://<scheme>.localhost`, macOS keeps the scheme.
pub fn base() -> &'static str {
    if cfg!(target_os = "macos") {
        "bookshelf://localhost"
    } else {
        "http://bookshelf.localhost"
    }
}

pub fn register<R: Runtime>(builder: tauri::Builder<R>) -> tauri::Builder<R> {
    builder.register_asynchronous_uri_scheme_protocol("bookshelf", |ctx, request, responder| {
        let app = ctx.app_handle().clone();
        // Reading a PDF or a chapter may block on disk: never do it on the
        // IPC/UI thread.
        std::thread::spawn(move || {
            let response = respond(&app, &request);
            responder.respond(response);
        });
    })
}

fn respond<R: Runtime>(app: &AppHandle<R>, request: &Request<Vec<u8>>) -> Response<Vec<u8>> {
    if request.method() == tauri::http::Method::OPTIONS {
        return Response::builder()
            .status(StatusCode::NO_CONTENT)
            .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
            .header(header::ACCESS_CONTROL_ALLOW_HEADERS, "*")
            .body(Vec::new())
            .unwrap_or_else(|_| empty(StatusCode::INTERNAL_SERVER_ERROR));
    }
    let state = app.state::<Arc<AppState>>();
    match route(state.inner(), request.uri().path()) {
        Ok(Some((body, mime))) => bytes_response(StatusCode::OK, &mime, body),
        Ok(None) => empty(StatusCode::NOT_FOUND),
        Err(err) => {
            tracing::warn!(%err, path = request.uri().path(), "protocol request failed");
            match err {
                AppError::NotFound(_) => empty(StatusCode::NOT_FOUND),
                AppError::Protected(_) => empty(StatusCode::FORBIDDEN),
                _ => empty(StatusCode::INTERNAL_SERVER_ERROR),
            }
        }
    }
}

fn route(state: &AppState, raw_path: &str) -> AppResult<Option<(Vec<u8>, String)>> {
    let path = percent_decode(raw_path);
    let path = path.trim_start_matches('/');
    let mut parts = path.splitn(3, '/');
    let kind = parts.next().unwrap_or_default();
    let id: i64 = match parts.next().and_then(|s| s.parse().ok()) {
        Some(id) => id,
        None => return Ok(None),
    };
    let rest = parts.next().unwrap_or_default();

    let book = {
        let db = state.db();
        match db.get_book(id) {
            Ok(book) => book,
            Err(_) => return Ok(None),
        }
    };

    match kind {
        "pdf" => {
            if book.format != BookFormat::Pdf {
                return Ok(None);
            }
            let bytes = std::fs::read(&book.path)?;
            Ok(Some((bytes, "application/pdf".into())))
        }
        "cover" => {
            let Some(cover) = book.cover_path.as_ref() else {
                return Ok(None);
            };
            if !Path::new(cover).exists() {
                return Ok(None);
            }
            let bytes = std::fs::read(cover)?;
            Ok(Some((bytes, "image/jpeg".into())))
        }
        "epub" => {
            if book.format != BookFormat::Epub || rest.is_empty() {
                return Ok(None);
            }
            let entry = entry_path(rest);
            if entry.is_empty() {
                return Ok(None);
            }
            let mtime = std::fs::metadata(&book.path)
                .and_then(|m| m.modified())
                .ok()
                .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                .map(|d| d.as_secs())
                .unwrap_or(0);
            let archive = cached_archive(state, id, mtime, &book.path)?;
            let mut guard = archive.lock().unwrap_or_else(|e| e.into_inner());
            let found = epub::read_resource(&mut guard, &entry, id)?;
            Ok(found)
        }
        _ => Ok(None),
    }
}

/// Book-relative, canonical entry name; anything escaping the root is refused.
fn entry_path(rest: &str) -> String {
    let normalized = crate::formats::sanitize::normalize_path(rest);
    if normalized.contains('\0') || normalized.starts_with("..") {
        return String::new();
    }
    normalized
}

fn cached_archive(
    state: &AppState,
    id: i64,
    mtime: u64,
    path: &str,
) -> AppResult<Arc<std::sync::Mutex<EpubArchive>>> {
    let mut cache = state.archive_cache();
    if let Some(entry) = cache.iter().find(|e| e.book_id == id && e.mtime == mtime) {
        return Ok(entry.archive.clone());
    }
    let mut archive = EpubArchive::open(Path::new(path))?;
    archive.scan()?;
    let shared = Arc::new(std::sync::Mutex::new(archive));
    cache.retain(|e| e.book_id != id);
    cache.insert(
        0,
        CachedArchive {
            book_id: id,
            mtime,
            archive: shared.clone(),
        },
    );
    cache.truncate(3);
    Ok(shared)
}

fn bytes_response(status: StatusCode, mime: &str, body: Vec<u8>) -> Response<Vec<u8>> {
    Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, mime)
        .header(header::CONTENT_LENGTH, body.len().to_string())
        .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
        .header(header::X_CONTENT_TYPE_OPTIONS, "nosniff")
        .header(header::CACHE_CONTROL, "no-store")
        .header(
            "Content-Security-Policy",
            "default-src 'none'; img-src data:; style-src 'unsafe-inline'",
        )
        .body(body)
        .unwrap_or_else(|_| empty(StatusCode::INTERNAL_SERVER_ERROR))
}

fn empty(status: StatusCode) -> Response<Vec<u8>> {
    Response::builder()
        .status(status)
        .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
        .body(Vec::new())
        .unwrap_or_else(|_| Response::new(Vec::new()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn entry_paths_cannot_escape_the_book() {
        assert_eq!(entry_path("../secret"), "secret");
        assert_eq!(entry_path("OEBPS/../../etc/passwd"), "etc/passwd");
        assert_eq!(entry_path("OEBPS/text/ch1.xhtml"), "OEBPS/text/ch1.xhtml");
        assert_eq!(entry_path(""), "");
    }

    #[test]
    fn base_is_a_fetchable_origin() {
        assert!(base().starts_with("http") || base().starts_with("bookshelf"));
        assert!(!base().ends_with('/'));
    }
}
