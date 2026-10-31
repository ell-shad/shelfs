//! Types shared with the frontend. `ui/src/bindings.ts` is generated from these
//! by tauri-specta — never hand-edit the TypeScript side.

use serde::{Deserialize, Serialize};
use specta::Type;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "lowercase")]
pub enum BookFormat {
    Pdf,
    Epub,
}

impl BookFormat {
    pub fn as_str(self) -> &'static str {
        match self {
            BookFormat::Pdf => "pdf",
            BookFormat::Epub => "epub",
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "pdf" => Some(BookFormat::Pdf),
            "epub" => Some(BookFormat::Epub),
            _ => None,
        }
    }

    pub fn mime(self) -> &'static str {
        match self {
            BookFormat::Pdf => "application/pdf",
            BookFormat::Epub => "application/epub+zip",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type, Default)]
#[serde(rename_all = "lowercase")]
pub enum Status {
    #[default]
    Want,
    Reading,
    Read,
}

impl Status {
    pub fn as_str(self) -> &'static str {
        match self {
            Status::Want => "want",
            Status::Reading => "reading",
            Status::Read => "read",
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "want" => Some(Status::Want),
            "reading" => Some(Status::Reading),
            "read" => Some(Status::Read),
            _ => None,
        }
    }

    /// Sort weight: books in progress first, then unread, then finished.
    pub fn weight(self) -> i64 {
        match self {
            Status::Reading => 0,
            Status::Want => 1,
            Status::Read => 2,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct Book {
    pub id: i64,
    pub title: String,
    pub author: String,
    pub format: BookFormat,
    pub path: String,
    pub content_hash: String,
    pub pages: i64,
    /// Spine colour, `#rrggbb`.
    pub color: String,
    /// Persisted once at import so the shelf never reshuffles.
    pub height: f64,
    pub depth: f64,
    pub status: Status,
    pub cover_path: Option<String>,
    /// Convenience URL for the webview; not persisted.
    #[serde(default)]
    pub cover_url: Option<String>,
    pub position: i64,
    /// Shelf the reader placed this book on (0-based, counted across cases).
    /// `None` lets the packer decide.
    pub shelf: Option<i64>,
    pub added_at: i64,
    pub last_opened_at: Option<i64>,
    /// 0.0 .. 1.0
    pub progress: f64,
    /// JSON-encoded [`Locator`] (kept as text so unknown future variants survive).
    pub locator: Option<String>,
    pub missing: bool,
    pub encrypted: bool,
    pub language: Option<String>,
    pub size_bytes: i64,
}

impl Book {
    /// Thickness in three.js units, per the prototype formula.
    pub fn thickness(&self) -> f64 {
        (0.14 + self.pages as f64 * 0.00065).clamp(0.16, 0.55)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Type, Default)]
#[serde(rename_all = "camelCase")]
pub struct BookPatch {
    pub title: Option<String>,
    pub author: Option<String>,
    pub pages: Option<i64>,
    pub color: Option<String>,
    pub status: Option<Status>,
}

/// A navigation target that survives re-pagination and font changes.
#[derive(Debug, Clone, Serialize, Deserialize, Type, PartialEq)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum Locator {
    Pdf {
        page: u32,
        /// 0..1 within the page
        offset: f32,
    },
    Epub {
        spine_index: u32,
        href: String,
        /// 0..1 within the chapter
        progress: f32,
        /// Character offset within the chapter's plain text, for search hits.
        text_offset: Option<u32>,
        anchor: Option<TextAnchor>,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, Type, PartialEq)]
pub struct TextAnchor {
    pub quote: String,
    pub prefix: String,
    pub suffix: String,
    /// Character offsets into the chapter's plain text (a stable fallback).
    pub start: u32,
    pub end: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ShelfSlot {
    pub book_id: i64,
    pub case_index: u32,
    pub shelf_index: u32,
    /// Left edge in scene units.
    pub x: f64,
    pub thickness: f64,
    pub height: f64,
    pub depth: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ShelfLayout {
    pub slots: Vec<ShelfSlot>,
    pub case_count: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type, Default)]
#[serde(rename_all = "camelCase")]
pub enum SortKey {
    #[default]
    Manual,
    Title,
    Author,
    Added,
    LastOpened,
    Status,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type, Default)]
#[serde(rename_all = "lowercase")]
pub enum StatusFilter {
    #[default]
    All,
    Want,
    Reading,
    Read,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type, Default)]
#[serde(rename_all = "lowercase")]
pub enum Theme {
    #[default]
    System,
    Light,
    Dark,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type, Default)]
#[serde(rename_all = "lowercase")]
pub enum StorageMode {
    #[default]
    Reference,
    Copy,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type, Default)]
#[serde(rename_all = "lowercase")]
pub enum LibraryView {
    #[default]
    Shelf,
    List,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type, Default)]
#[serde(rename_all = "lowercase")]
pub enum ReaderTheme {
    #[default]
    System,
    Light,
    Sepia,
    Dark,
    Black,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type, Default)]
#[serde(rename_all = "lowercase")]
pub enum EpubLayout {
    #[default]
    Paginated,
    Scroll,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type, Default)]
#[serde(rename_all = "lowercase")]
pub enum PdfLayout {
    #[default]
    Continuous,
    Single,
    Spread,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type, Default)]
#[serde(rename_all = "lowercase")]
pub enum TextAlign {
    #[default]
    Justify,
    Left,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type, Default)]
#[serde(rename_all = "lowercase")]
pub enum SpreadMode {
    #[default]
    Auto,
    Never,
    Always,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", default)]
pub struct EpubPrefs {
    pub font_family: String,
    pub font_size: f64,
    pub line_height: f64,
    pub paragraph_spacing: f64,
    /// Page margin in CSS pixels.
    pub margin: f64,
    pub align: TextAlign,
    pub hyphenate: bool,
    pub publisher_styles: bool,
    pub layout: EpubLayout,
    pub spread: SpreadMode,
}

impl Default for EpubPrefs {
    fn default() -> Self {
        Self {
            font_family: "literata".into(),
            font_size: 19.0,
            line_height: 1.6,
            paragraph_spacing: 0.6,
            margin: 64.0,
            align: TextAlign::Justify,
            hyphenate: true,
            publisher_styles: true,
            layout: EpubLayout::Paginated,
            spread: SpreadMode::Auto,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", default)]
pub struct PdfPrefs {
    pub layout: PdfLayout,
    pub night_mode: bool,
    pub zoom: f64,
    pub fit: String,
}

impl Default for PdfPrefs {
    fn default() -> Self {
        Self {
            layout: PdfLayout::Continuous,
            night_mode: false,
            zoom: 1.0,
            fit: "width".into(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", default)]
pub struct ReaderPrefs {
    pub theme: ReaderTheme,
    pub epub: EpubPrefs,
    pub pdf: PdfPrefs,
}

impl Default for ReaderPrefs {
    fn default() -> Self {
        Self {
            theme: ReaderTheme::System,
            epub: EpubPrefs::default(),
            pdf: PdfPrefs::default(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    pub theme: Theme,
    pub performance_mode: bool,
    pub storage_mode: StorageMode,
    pub sort: SortKey,
    pub filter: StatusFilter,
    pub view: LibraryView,
    pub reader: ReaderPrefs,
    /// Detect a slow frame rate and offer performance mode.
    pub suggest_performance: bool,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            theme: Theme::System,
            performance_mode: false,
            storage_mode: StorageMode::Reference,
            sort: SortKey::Manual,
            filter: StatusFilter::All,
            view: LibraryView::Shelf,
            reader: ReaderPrefs::default(),
            suggest_performance: true,
        }
    }
}

impl Settings {
    /// Partial updates never clobber unrelated values.
    pub fn apply(&mut self, patch: &SettingsPatch) {
        if let Some(v) = patch.theme {
            self.theme = v;
        }
        if let Some(v) = patch.performance_mode {
            self.performance_mode = v;
        }
        if let Some(v) = patch.storage_mode {
            self.storage_mode = v;
        }
        if let Some(v) = patch.sort {
            self.sort = v;
        }
        if let Some(v) = patch.filter {
            self.filter = v;
        }
        if let Some(v) = patch.view {
            self.view = v;
        }
        if let Some(v) = patch.suggest_performance {
            self.suggest_performance = v;
        }
        if let Some(v) = patch.reader_theme {
            self.reader.theme = v;
        }
        if let Some(ep) = &patch.epub {
            let e = &mut self.reader.epub;
            if let Some(v) = ep.font_family.as_ref() {
                e.font_family = v.clone();
            }
            if let Some(v) = ep.font_size {
                e.font_size = v.clamp(10.0, 40.0);
            }
            if let Some(v) = ep.line_height {
                e.line_height = v.clamp(1.0, 3.0);
            }
            if let Some(v) = ep.paragraph_spacing {
                e.paragraph_spacing = v.clamp(0.0, 3.0);
            }
            if let Some(v) = ep.margin {
                e.margin = v.clamp(8.0, 240.0);
            }
            if let Some(v) = ep.align {
                e.align = v;
            }
            if let Some(v) = ep.hyphenate {
                e.hyphenate = v;
            }
            if let Some(v) = ep.publisher_styles {
                e.publisher_styles = v;
            }
            if let Some(v) = ep.layout {
                e.layout = v;
            }
            if let Some(v) = ep.spread {
                e.spread = v;
            }
        }
        if let Some(pp) = &patch.pdf {
            let p = &mut self.reader.pdf;
            if let Some(v) = pp.layout {
                p.layout = v;
            }
            if let Some(v) = pp.night_mode {
                p.night_mode = v;
            }
            if let Some(v) = pp.zoom {
                p.zoom = v.clamp(0.25, 6.0);
            }
            if let Some(v) = pp.fit.as_ref() {
                p.fit = v.clone();
            }
        }
    }
}

/// Merging a partial settings patch keeps older settings files forward-compatible.
#[derive(Debug, Clone, Serialize, Deserialize, Type, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct SettingsPatch {
    pub theme: Option<Theme>,
    pub performance_mode: Option<bool>,
    pub storage_mode: Option<StorageMode>,
    pub sort: Option<SortKey>,
    pub filter: Option<StatusFilter>,
    pub view: Option<LibraryView>,
    pub suggest_performance: Option<bool>,
    pub epub: Option<EpubPatch>,
    pub pdf: Option<PdfPatch>,
    pub reader_theme: Option<ReaderTheme>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct EpubPatch {
    pub font_family: Option<String>,
    pub font_size: Option<f64>,
    pub line_height: Option<f64>,
    pub paragraph_spacing: Option<f64>,
    pub margin: Option<f64>,
    pub align: Option<TextAlign>,
    pub hyphenate: Option<bool>,
    pub publisher_styles: Option<bool>,
    pub layout: Option<EpubLayout>,
    pub spread: Option<SpreadMode>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct PdfPatch {
    pub layout: Option<PdfLayout>,
    pub night_mode: Option<bool>,
    pub zoom: Option<f64>,
    pub fit: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct Bookmark {
    pub id: i64,
    pub book_id: i64,
    pub locator: Locator,
    pub page: Option<i64>,
    pub label: String,
    pub created_at: i64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type, Default)]
#[serde(rename_all = "lowercase")]
pub enum HighlightColor {
    #[default]
    Yellow,
    Green,
    Blue,
    Pink,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct Annotation {
    pub id: i64,
    pub book_id: i64,
    pub locator: Locator,
    pub quote: String,
    pub note: String,
    pub color: HighlightColor,
    pub page: Option<i64>,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct NewAnnotation {
    pub locator: Locator,
    pub quote: String,
    pub note: String,
    pub color: HighlightColor,
    pub page: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type, Default)]
#[serde(rename_all = "camelCase")]
pub struct AnnotationPatch {
    pub note: Option<String>,
    pub color: Option<HighlightColor>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct TocEntry {
    pub label: String,
    /// Chapter href within the EPUB; `None` for PDF entries (they use page).
    pub href: Option<String>,
    pub page: Option<u32>,
    pub level: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct EpubChapter {
    pub index: u32,
    pub href: String,
    pub title: String,
    pub html: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct EpubPackage {
    pub base_url: String,
    pub toc: Vec<TocEntry>,
    pub chapters: Vec<EpubChapterMeta>,
    pub rtl: bool,
    pub fixed_layout: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct EpubChapterMeta {
    pub index: u32,
    pub href: String,
    pub title: String,
    /// Estimated characters, used for per-chapter progress.
    pub chars: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ChapterSearchHit {
    pub spine_index: u32,
    pub href: String,
    pub chapter_title: String,
    pub text_offset: u32,
    pub excerpt: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct OpenedBook {
    pub book: Book,
    pub doc_url: String,
    pub epub: Option<EpubPackage>,
    pub locator: Option<Locator>,
    pub pdf_password_required: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ImportProgress {
    pub job_id: String,
    pub done: u32,
    pub total: u32,
    pub current: String,
    pub phase: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ImportFailure {
    pub path: String,
    pub message: String,
    pub kind: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ImportSummary {
    pub imported: Vec<Book>,
    pub failures: Vec<ImportFailure>,
    pub duplicates_skipped: Vec<String>,
    /// PDFs imported without a cover: the UI renders page 1 with pdf.js and
    /// calls `save_pdf_cover` with the PNG bytes.
    pub needs_cover: Vec<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct DuplicateHit {
    pub path: String,
    pub title: String,
    pub existing_book_id: i64,
    pub existing_title: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct DuplicatePolicyArg {
    pub policy: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct LibrarySnapshot {
    pub books: Vec<Book>,
    pub layout: ShelfLayout,
    pub settings: Settings,
    pub total: u32,
    pub by_status: StatusCounts,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type, Default)]
#[serde(rename_all = "camelCase")]
pub struct StatusCounts {
    pub want: u32,
    pub reading: u32,
    pub read: u32,
    pub missing: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct BackupReport {
    pub books: u32,
    pub covers: u32,
    pub path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type, Default)]
#[serde(rename_all = "camelCase")]
pub struct RestoreReport {
    pub books_added: u32,
    pub books_merged: u32,
    pub bookmarks: u32,
    pub annotations: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AppInfo {
    pub version: String,
    pub data_dir: String,
    pub cache_dir: String,
    pub config_dir: String,
    pub db_path: String,
    pub webkit_version: String,
    pub app_id: String,
    /// Base of the bookshelf:// resources, e.g. http://bookshelf.localhost
    pub protocol_base: String,
}
