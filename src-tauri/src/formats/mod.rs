//! Format layer. Everything format-specific sits behind [`BookFormatHandler`]
//! so CBZ/MOBI/DjVu can be added later without touching the library code.

pub mod epub;
pub mod pdf;
pub mod sanitize;

use std::path::Path;

use crate::error::AppResult;
use crate::models::BookFormat;

#[derive(Debug, Clone)]
pub struct ProbedBook {
    pub title: String,
    pub author: String,
    pub language: Option<String>,
    pub pages: i64,
    /// Raw cover image bytes, if the file has one.
    pub cover: Option<Vec<u8>>,
    pub encrypted: bool,
    /// (spine index, href, title, plain text) — used for full-text search.
    pub chapters: Vec<(u32, String, String, String)>,
}

pub trait BookFormatHandler: Send + Sync {
    fn format(&self) -> BookFormat;
    /// Read metadata, cover and searchable text. Must never panic on malformed
    /// input and must not modify the file.
    fn probe(&self, path: &Path) -> AppResult<ProbedBook>;
}

pub fn handler_for(format: BookFormat) -> &'static dyn BookFormatHandler {
    static PDF: pdf::PdfHandler = pdf::PdfHandler;
    static EPUB: epub::EpubHandler = epub::EpubHandler;
    match format {
        BookFormat::Pdf => &PDF,
        BookFormat::Epub => &EPUB,
    }
}

/// Identify a book by content first, then by extension. Book files arrive
/// untrusted, so the extension is never trusted on its own.
pub fn sniff(path: &Path) -> AppResult<BookFormat> {
    let mut file = std::fs::File::open(path)?;
    let mut head = [0u8; 8];
    use std::io::Read;
    let n = file.read(&mut head)?;
    let head = &head[..n];
    if head.starts_with(b"%PDF-") {
        return Ok(BookFormat::Pdf);
    }
    let has_ext = |ext: &str| {
        path.extension()
            .and_then(|e| e.to_str())
            .is_some_and(|e| e.eq_ignore_ascii_case(ext))
    };
    if head.starts_with(b"PK\x03\x04") {
        // Both EPUB and CBZ are zips; only EPUB is supported in v1.
        if has_ext("epub") {
            return Ok(BookFormat::Epub);
        }
        return Err(crate::error::AppError::Unsupported(
            "Only PDF and EPUB files are supported".into(),
        ));
    }
    if has_ext("epub") {
        return Err(crate::error::AppError::Corrupt(format!(
            "{} is not a valid EPUB archive",
            path.display()
        )));
    }
    Err(crate::error::AppError::Unsupported(format!(
        "{}",
        path.display()
    )))
}
