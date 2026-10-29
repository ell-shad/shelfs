//! EPUB 2 / EPUB 3 parsing: container, OPF, spine, navigation, cover, text
//! extraction and safe resource access.
//!
//! All archive reads are bounded (entry count, uncompressed size, compression
//! ratio) and every function returns `Result` — malformed books must produce an
//! error, never a panic.

use std::collections::HashMap;
use std::fs::File;
use std::io::Read;
use std::path::Path;

use roxmltree::{Document as Xml, Node};
use zip::ZipArchive;

use crate::error::{AppError, AppResult};
use crate::formats::sanitize::{sanitize_chapter, SanitizeOptions};
use crate::formats::{BookFormatHandler, ProbedBook};
use crate::models::{BookFormat, EpubChapterMeta, EpubPackage, TocEntry};
use crate::util::{percent_decode, title_from_filename};

pub const MAX_ENTRIES: usize = 4096;
pub const MAX_TOTAL_UNCOMPRESSED: u64 = 512 * 1024 * 1024;
pub const MAX_ENTRY_UNCOMPRESSED: u64 = 64 * 1024 * 1024;
pub const MAX_RATIO: u64 = 150;
pub const CHARS_PER_PAGE: f64 = 1500.0;

pub struct EpubArchive {
    zip: ZipArchive<File>,
    names: HashMap<String, usize>,
}

fn normalize_zip_name(name: &str) -> String {
    let decoded = percent_decode(name);
    let unified = decoded.replace('\\', "/");
    let trimmed = unified.trim_start_matches('/');
    crate::formats::sanitize::normalize_path(trimmed)
}

impl EpubArchive {
    pub fn open(path: &Path) -> AppResult<Self> {
        let file = File::open(path)?;
        let zip = ZipArchive::new(file)
            .map_err(|e| AppError::Corrupt(format!("{}: {e}", path.display())))?;
        if zip.len() > MAX_ENTRIES {
            return Err(AppError::Format(format!(
                "archive has too many entries ({} > {MAX_ENTRIES})",
                zip.len()
            )));
        }
        Ok(Self {
            zip,
            names: HashMap::new(),
        })
    }

    /// Validate zip-bomb limits before anything is extracted.
    pub fn scan(&mut self) -> AppResult<()> {
        let mut total: u64 = 0;
        let mut names = HashMap::new();
        for index in 0..self.zip.len() {
            let entry = self
                .zip
                .by_index_raw(index)
                .map_err(|e| AppError::Corrupt(format!("archive entry {index}: {e}")))?;
            if entry.is_dir() {
                continue;
            }
            let name = entry
                .name()
                .map_err(|e| AppError::Corrupt(format!("archive entry name: {e}")))?
                .to_string();
            let size = entry.size();
            let compressed = entry.compressed_size();
            if size > MAX_ENTRY_UNCOMPRESSED {
                return Err(AppError::Format(
                    "archive contains an oversized entry".into(),
                ));
            }
            if size > 2 * 1024 * 1024 && compressed > 0 && size / compressed > MAX_RATIO {
                return Err(AppError::Format(
                    "archive compression ratio is suspiciously high".into(),
                ));
            }
            total = total.saturating_add(size);
            if total > MAX_TOTAL_UNCOMPRESSED {
                return Err(AppError::Format("archive expands to too much data".into()));
            }
            names.insert(normalize_zip_name(&name), index);
        }
        self.names = names;
        Ok(())
    }

    pub fn has(&self, name: &str) -> bool {
        self.names.contains_key(&normalize_zip_name(name))
    }

    pub fn read(&mut self, name: &str) -> AppResult<Option<Vec<u8>>> {
        let key = normalize_zip_name(name);
        let Some(index) = self.names.get(&key).copied() else {
            return Ok(None);
        };
        let mut entry = self
            .zip
            .by_index(index)
            .map_err(|e| map_zip_error(e, "reading an archive entry"))?;
        if entry.size() > MAX_ENTRY_UNCOMPRESSED {
            return Err(AppError::Format("archive entry is too large".into()));
        }
        let mut buf = Vec::with_capacity(entry.size().min(1 << 20) as usize);
        entry
            .by_ref()
            .take(MAX_ENTRY_UNCOMPRESSED + 1)
            .read_to_end(&mut buf)?;
        if buf.len() as u64 > MAX_ENTRY_UNCOMPRESSED {
            return Err(AppError::Format("archive entry is too large".into()));
        }
        Ok(Some(buf))
    }

    pub fn read_string(&mut self, name: &str) -> AppResult<Option<String>> {
        Ok(self
            .read(name)?
            .map(|bytes| String::from_utf8_lossy(&bytes).to_string()))
    }
}

fn map_zip_error(err: zip::result::ZipError, what: &str) -> AppError {
    match err {
        zip::result::ZipError::UnsupportedArchive(msg) => {
            if msg == zip::result::ZipError::PASSWORD_REQUIRED
                || msg.to_ascii_lowercase().contains("encrypt")
            {
                AppError::Protected(
                    "This EPUB is encrypted or DRM-protected and cannot be opened.".into(),
                )
            } else {
                AppError::Format(format!("{what}: {msg}"))
            }
        }
        other => AppError::Corrupt(format!("{what}: {other}")),
    }
}

#[derive(Debug, Clone)]
pub struct ManifestItem {
    pub id: String,
    pub href: String,
    pub media_type: String,
    pub properties: String,
}

#[derive(Debug, Clone)]
pub struct SpineItem {
    pub index: u32,
    pub idref: String,
    pub href: String,
    pub media_type: String,
}

#[derive(Debug, Clone)]
pub struct ParsedEpub {
    pub opf_path: String,
    pub opf_dir: String,
    pub title: Option<String>,
    pub author: Option<String>,
    pub language: Option<String>,
    pub manifest: Vec<ManifestItem>,
    pub spine: Vec<SpineItem>,
    pub toc: Vec<TocEntry>,
    pub cover_href: Option<String>,
    pub rtl: bool,
    pub fixed_layout: bool,
}

pub fn open_checked(path: &Path) -> AppResult<EpubArchive> {
    let mut archive = EpubArchive::open(path)?;
    archive.scan()?;
    Ok(archive)
}

pub fn open_book(path: &Path) -> AppResult<(EpubArchive, ParsedEpub)> {
    let mut archive = open_checked(path)?;
    if !archive.has("META-INF/container.xml") {
        return Err(AppError::Corrupt(
            "This file is a zip archive but not a valid EPUB (no META-INF/container.xml)".into(),
        ));
    }
    check_drm(&mut archive)?;
    let parsed = parse_structure(&mut archive)?;
    Ok((archive, parsed))
}

fn check_drm(archive: &mut EpubArchive) -> AppResult<()> {
    if archive.has("META-INF/rights.xml") {
        return Err(AppError::Protected(
            "This EPUB is DRM-protected and cannot be imported.".into(),
        ));
    }
    if let Some(xml) = archive.read_string("META-INF/encryption.xml")? {
        let doc = match Xml::parse(&xml) {
            Ok(d) => d,
            Err(_) => return Ok(()), // unreadable => treat as no DRM; reads will fail later
        };
        for node in doc.descendants().filter(|n| n.is_element()) {
            if node.tag_name().name() != "CipherReference" {
                continue;
            }
            let uri = node
                .attribute("URI")
                .unwrap_or_default()
                .to_ascii_lowercase();
            let is_font = [".ttf", ".otf", ".woff", ".woff2", ".ttc"]
                .iter()
                .any(|ext| uri.ends_with(ext));
            if !is_font && !uri.is_empty() {
                return Err(AppError::Protected(
                    "This EPUB is DRM-protected and cannot be imported.".into(),
                ));
            }
        }
    }
    Ok(())
}

fn parse_structure(archive: &mut EpubArchive) -> AppResult<ParsedEpub> {
    let container = archive
        .read_string("META-INF/container.xml")?
        .ok_or_else(|| AppError::Corrupt("missing META-INF/container.xml".into()))?;
    let container_doc =
        Xml::parse(&container).map_err(|e| AppError::Corrupt(format!("container.xml: {e}")))?;
    let opf_path = container_doc
        .descendants()
        .filter(|n| n.is_element() && n.tag_name().name() == "rootfile")
        .find_map(|n| n.attribute("full-path"))
        .map(str::to_string)
        .ok_or_else(|| AppError::Corrupt("container.xml has no rootfile".into()))?;
    let opf_dir = opf_path
        .rfind('/')
        .map(|i| opf_path[..i].to_string())
        .unwrap_or_default();
    let opf = archive
        .read_string(&opf_path)?
        .ok_or_else(|| AppError::Corrupt(format!("missing {opf_path}")))?;
    let doc = Xml::parse(&opf).map_err(|e| AppError::Corrupt(format!("{opf_path}: {e}")))?;

    let mut title = None;
    let mut author = None;
    let mut language = None;
    let mut fixed_layout = false;
    let mut cover_id: Option<String> = None;
    let mut guide_cover: Option<String> = None;

    for node in doc.descendants().filter(|n| n.is_element()) {
        match node.tag_name().name() {
            "title" if title.is_none() => title = Some(text_content(node)),
            "creator" if author.is_none() => {
                let name = text_content(node);
                if !name.is_empty() {
                    author = Some(name);
                }
            }
            "language" if language.is_none() => language = Some(text_content(node)),
            "meta" => {
                if node.attribute("name") == Some("cover") {
                    if let Some(content) = node.attribute("content") {
                        cover_id = Some(content.to_string());
                    }
                }
                if node.attribute("property") == Some("rendition:layout")
                    && text_content(node).trim() == "pre-paginated"
                {
                    fixed_layout = true;
                }
            }
            "reference"
                if node
                    .attribute("type")
                    .is_some_and(|t| t.eq_ignore_ascii_case("cover")) =>
            {
                if let Some(href) = node.attribute("href") {
                    guide_cover = Some(resolve_href(&opf_dir, href));
                }
            }
            _ => {}
        }
    }

    let mut manifest = Vec::new();
    for node in doc
        .descendants()
        .filter(|n| n.is_element() && n.tag_name().name() == "item")
    {
        let (Some(id), Some(href)) = (node.attribute("id"), node.attribute("href")) else {
            continue;
        };
        manifest.push(ManifestItem {
            id: id.to_string(),
            href: resolve_href(&opf_dir, href),
            media_type: node.attribute("media-type").unwrap_or_default().to_string(),
            properties: node.attribute("properties").unwrap_or_default().to_string(),
        });
    }

    let mut rtl = false;
    let mut spine = Vec::new();
    for spine_node in doc
        .descendants()
        .filter(|n| n.is_element() && n.tag_name().name() == "spine")
    {
        if spine_node.attribute("page-progression-direction") == Some("rtl") {
            rtl = true;
        }
        for itemref in spine_node
            .children()
            .filter(|n| n.is_element() && n.tag_name().name() == "itemref")
        {
            let Some(idref) = itemref.attribute("idref") else {
                continue;
            };
            let Some(item) = manifest.iter().find(|m| m.id == idref) else {
                continue;
            };
            // Skip non-document items (audio, video, images in fixed layouts).
            let mt = item.media_type.to_ascii_lowercase();
            if !(mt.is_empty() || mt.contains("xhtml") || mt.contains("html") || mt.contains("svg"))
            {
                continue;
            }
            spine.push(SpineItem {
                index: spine.len() as u32,
                idref: idref.to_string(),
                href: item.href.clone(),
                media_type: item.media_type.clone(),
            });
        }
    }
    if spine.is_empty() {
        // Some broken EPUBs have an empty spine; fall back to all XHTML items.
        for item in &manifest {
            if item.media_type.contains("xhtml") || item.media_type.contains("html") {
                spine.push(SpineItem {
                    index: spine.len() as u32,
                    idref: item.id.clone(),
                    href: item.href.clone(),
                    media_type: item.media_type.clone(),
                });
            }
        }
    }

    // Table of contents: EPUB 3 nav document first, then EPUB 2 NCX.
    let nav_href = manifest
        .iter()
        .find(|m| m.properties.split_whitespace().any(|p| p == "nav"))
        .map(|m| m.href.clone());
    let ncx_href = manifest
        .iter()
        .find(|m| {
            m.media_type
                .eq_ignore_ascii_case("application/x-dtbncx+xml")
        })
        .map(|m| m.href.clone());

    let mut toc = Vec::new();
    if let Some(href) = nav_href {
        if let Ok(Some(nav)) = archive.read_string(&href) {
            toc = parse_nav(&nav, &href);
        }
    }
    if toc.is_empty() {
        if let Some(href) = ncx_href {
            if let Ok(Some(ncx)) = archive.read_string(&href) {
                toc = parse_ncx(&ncx, &href);
            }
        }
    }
    if toc.is_empty() {
        toc = spine
            .iter()
            .map(|s| TocEntry {
                label: format!("Chapter {}", s.index + 1),
                href: Some(s.href.clone()),
                page: None,
                level: 0,
            })
            .collect();
    }

    let cover_href = manifest
        .iter()
        .find(|m| m.properties.split_whitespace().any(|p| p == "cover-image"))
        .map(|m| m.href.clone())
        .or_else(|| {
            cover_id.as_ref().and_then(|id| {
                manifest
                    .iter()
                    .find(|m| &m.id == id)
                    .map(|m| m.href.clone())
            })
        })
        .or_else(|| guide_cover.clone())
        .or_else(|| {
            manifest
                .iter()
                .find(|m| m.media_type.starts_with("image/"))
                .map(|m| m.href.clone())
        });

    Ok(ParsedEpub {
        opf_path,
        opf_dir,
        title: title.filter(|t| !t.trim().is_empty()),
        author: author.filter(|a| !a.trim().is_empty()),
        language,
        manifest,
        spine,
        toc,
        cover_href,
        rtl,
        fixed_layout,
    })
}

fn parse_nav(nav_html: &str, nav_href: &str) -> Vec<TocEntry> {
    let Ok(doc) = Xml::parse(nav_html) else {
        return Vec::new();
    };
    let dir = nav_href.rfind('/').map(|i| &nav_href[..i]).unwrap_or("");
    let Some(nav) = doc
        .descendants()
        .filter(|n| n.is_element() && n.tag_name().name() == "nav")
        .find(|n| {
            n.attribute("type")
                .map(|t| t.split_whitespace().any(|p| p == "toc"))
                .unwrap_or(false)
        })
        .or_else(|| {
            doc.descendants()
                .find(|n| n.is_element() && n.tag_name().name() == "nav")
        })
    else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for a in nav
        .descendants()
        .filter(|n| n.is_element() && n.tag_name().name() == "a")
    {
        let Some(href) = a.attribute("href") else {
            continue;
        };
        let label = text_content(a);
        if label.is_empty() {
            continue;
        }
        let level = a
            .ancestors()
            .filter(|n| n.is_element() && n.tag_name().name() == "ol")
            .count()
            .saturating_sub(1) as u32;
        out.push(TocEntry {
            label,
            href: Some(join_href(dir, href)),
            page: None,
            level,
        });
    }
    out
}

fn parse_ncx(ncx: &str, ncx_href: &str) -> Vec<TocEntry> {
    let Ok(doc) = Xml::parse(ncx) else {
        return Vec::new();
    };
    let dir = ncx_href.rfind('/').map(|i| &ncx_href[..i]).unwrap_or("");
    let mut out = Vec::new();
    if let Some(nav_map) = doc
        .descendants()
        .find(|n| n.is_element() && n.tag_name().name() == "navMap")
    {
        for child in nav_map
            .children()
            .filter(|n| n.is_element() && n.tag_name().name() == "navPoint")
        {
            walk_ncx_points(child, dir, &mut out, 0);
        }
    }
    out
}

fn walk_ncx_points(node: Node<'_, '_>, dir: &str, out: &mut Vec<TocEntry>, depth: u32) {
    let label = node
        .children()
        .find(|n| n.is_element() && n.tag_name().name() == "navLabel")
        .map(text_content)
        .unwrap_or_default();
    let src = node
        .children()
        .find(|n| n.is_element() && n.tag_name().name() == "content")
        .and_then(|n| n.attribute("src"))
        .map(|src| join_href(dir, src));
    if let Some(src) = src {
        if !label.is_empty() {
            out.push(TocEntry {
                label,
                href: Some(src),
                page: None,
                level: depth,
            });
        }
    }
    for child in node
        .children()
        .filter(|n| n.is_element() && n.tag_name().name() == "navPoint")
    {
        walk_ncx_points(child, dir, out, depth + 1);
    }
}

fn text_content(node: Node<'_, '_>) -> String {
    let mut out = String::new();
    for descendant in node.descendants() {
        if descendant.is_text() {
            if let Some(text) = descendant.text() {
                out.push_str(text);
            }
        }
    }
    out.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn join_href(dir: &str, href: &str) -> String {
    if dir.is_empty() {
        href.to_string()
    } else {
        format!("{dir}/{href}")
    }
}

/// Resolve an OPF-relative href into a book-relative, normalised path.
pub fn resolve_href(opf_dir: &str, href: &str) -> String {
    let clean = href.split(['#', '?']).next().unwrap_or(href);
    let joined = if opf_dir.is_empty() {
        clean.to_string()
    } else {
        format!("{opf_dir}/{clean}")
    };
    normalize_zip_name(&joined)
}

pub fn spine_href(parsed: &ParsedEpub, href: &str) -> Option<u32> {
    let target = normalize_zip_name(href);
    parsed
        .spine
        .iter()
        .find(|s| normalize_zip_name(&s.href) == target)
        .map(|s| s.index)
}

pub fn chapter_title(parsed: &ParsedEpub, spine: &SpineItem) -> String {
    let target = normalize_zip_name(&spine.href);
    for entry in &parsed.toc {
        if let Some(href) = entry.href.as_ref() {
            if normalize_zip_name(href) == target && !entry.label.trim().is_empty() {
                return entry.label.clone();
            }
        }
    }
    format!("Chapter {}", spine.index + 1)
}

pub struct EpubHandler;

impl BookFormatHandler for EpubHandler {
    fn format(&self) -> BookFormat {
        BookFormat::Epub
    }

    fn probe(&self, path: &Path) -> AppResult<ProbedBook> {
        let (mut archive, parsed) = open_book(path)?;
        let mut chapters = Vec::new();
        let mut chars_total: usize = 0;
        for spine in &parsed.spine {
            let html = archive.read_string(&spine.href)?.unwrap_or_default();
            let text = html_to_text(&html);
            chars_total += text.chars().count();
            chapters.push((
                spine.index,
                spine.href.clone(),
                chapter_title(&parsed, spine),
                text,
            ));
        }
        let cover = parsed
            .cover_href
            .as_ref()
            .and_then(|href| read_cover(&mut archive, &parsed, href).ok().flatten());
        let pages = ((chars_total as f64 / CHARS_PER_PAGE).round() as i64).max(1);
        Ok(ProbedBook {
            title: parsed
                .title
                .clone()
                .unwrap_or_else(|| title_from_filename(path)),
            author: parsed.author.clone().unwrap_or_default(),
            language: parsed.language.clone(),
            pages: pages.min(20_000),
            cover,
            encrypted: false,
            chapters,
        })
    }
}

/// Cover bytes: either the image itself, or the first image referenced by a
/// cover XHTML page (EPUB 2 guide style).
pub fn read_cover(
    archive: &mut EpubArchive,
    parsed: &ParsedEpub,
    href: &str,
) -> AppResult<Option<Vec<u8>>> {
    if let Some(bytes) = archive.read(href)? {
        let is_image = parsed
            .manifest
            .iter()
            .find(|m| m.href == href)
            .map(|m| m.media_type.starts_with("image/"))
            .unwrap_or_else(|| {
                let lower = href.to_ascii_lowercase();
                [".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp", ".svg"]
                    .iter()
                    .any(|ext| lower.ends_with(ext))
            });
        if is_image {
            return Ok(Some(bytes));
        }
        let html = String::from_utf8_lossy(&bytes).to_string();
        if let Some(img_href) = first_image_href(&html) {
            let dir = href.rfind('/').map(|i| &href[..i]).unwrap_or("");
            let target = normalize_zip_name(&format!("{dir}/{img_href}"));
            return archive.read(&target);
        }
    }
    Ok(None)
}

fn first_image_href(html: &str) -> Option<String> {
    let doc = Xml::parse(html).ok()?;
    for node in doc.descendants().filter(|n| n.is_element()) {
        let name = node.tag_name().name();
        if name == "img" {
            if let Some(src) = node.attribute("src") {
                return Some(src.split(['#', '?']).next().unwrap_or(src).to_string());
            }
        }
        if name == "image" {
            if let Some(href) = node.attribute("href") {
                return Some(href.split(['#', '?']).next().unwrap_or(href).to_string());
            }
        }
    }
    None
}

pub fn package(
    path: &Path,
    base_url: &str,
    char_counts: &HashMap<String, u32>,
) -> AppResult<EpubPackage> {
    let (_archive, parsed) = open_book(path)?;
    let chapters = parsed
        .spine
        .iter()
        .map(|s| EpubChapterMeta {
            index: s.index,
            href: s.href.clone(),
            title: chapter_title(&parsed, s),
            chars: char_counts
                .get(&normalize_zip_name(&s.href))
                .copied()
                .unwrap_or(0),
        })
        .collect();
    Ok(EpubPackage {
        base_url: format!("{base_url}{}", parsed.opf_dir),
        toc: parsed.toc,
        chapters,
        rtl: parsed.rtl,
        fixed_layout: parsed.fixed_layout,
    })
}

pub fn chapter_html(
    path: &Path,
    href: &str,
    book_id: i64,
    publisher_styles: bool,
) -> AppResult<String> {
    let mut archive = open_checked(path)?;
    let html = archive
        .read_string(href)?
        .ok_or_else(|| AppError::NotFound(format!("chapter {href}")))?;
    let base = format!("{}/epub/{book_id}/", crate::protocol::base());
    sanitize_chapter(
        &html,
        &SanitizeOptions {
            book_base: &base,
            chapter_href: href,
            publisher_styles,
        },
    )
}

pub fn resource(path: &Path, name: &str, book_id: i64) -> AppResult<Option<(Vec<u8>, String)>> {
    let mut archive = open_checked(path)?;
    read_resource(&mut archive, name, book_id)
}

/// Read one entry for the webview. XHTML is always sanitised, even when it is
/// requested directly rather than through `get_chapter`.
pub fn read_resource(
    archive: &mut EpubArchive,
    name: &str,
    book_id: i64,
) -> AppResult<Option<(Vec<u8>, String)>> {
    let Some(bytes) = archive.read(name)? else {
        return Ok(None);
    };
    let mime = mime_for(name);
    if mime == "application/xhtml+xml" {
        let text = String::from_utf8_lossy(&bytes).to_string();
        let base = format!("{}/epub/{book_id}/", crate::protocol::base());
        let sanitized = sanitize_chapter(
            &text,
            &SanitizeOptions {
                book_base: &base,
                chapter_href: name,
                publisher_styles: true,
            },
        )?;
        return Ok(Some((
            sanitized.into_bytes(),
            "text/html; charset=utf-8".into(),
        )));
    }
    Ok(Some((bytes, mime)))
}

pub fn mime_for(name: &str) -> String {
    let lower = name.to_ascii_lowercase();
    let ext = lower.rsplit('.').next().unwrap_or("");
    let mime = match ext {
        "xhtml" | "html" | "htm" => "application/xhtml+xml",
        "css" => "text/css",
        "js" => "text/javascript",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "svg" => "image/svg+xml",
        "bmp" => "image/bmp",
        "ttf" => "font/ttf",
        "otf" => "font/otf",
        "woff" => "font/woff",
        "woff2" => "font/woff2",
        "mp3" => "audio/mpeg",
        "mp4" => "video/mp4",
        "xml" | "opf" | "ncx" => "application/xml",
        "json" => "application/json",
        _ => "application/octet-stream",
    };
    mime.to_string()
}

/// Extract readable text from chapter XHTML. Prefers a real XML parse; falls
/// back to a tag stripper for malformed files.
pub fn html_to_text(html: &str) -> String {
    if let Ok(doc) = Xml::parse(html) {
        let mut out = String::new();
        let root = doc.root_element();
        walk_text(root, &mut out);
        let normalized = normalize_text(&out);
        if !normalized.is_empty() {
            return normalized;
        }
    }
    normalize_text(&strip_tags(html))
}

fn walk_text(node: Node<'_, '_>, out: &mut String) {
    for child in node.children() {
        if child.is_text() {
            if let Some(text) = child.text() {
                out.push_str(text);
            }
        } else if child.is_element() {
            let name = child.tag_name().name().to_ascii_lowercase();
            if matches!(name.as_str(), "script" | "style" | "head" | "svg" | "math") {
                continue;
            }
            let block = matches!(
                name.as_str(),
                "p" | "div"
                    | "br"
                    | "li"
                    | "tr"
                    | "h1"
                    | "h2"
                    | "h3"
                    | "h4"
                    | "h5"
                    | "h6"
                    | "blockquote"
                    | "section"
                    | "article"
                    | "pre"
                    | "td"
                    | "th"
                    | "figcaption"
            );
            if block {
                out.push('\n');
            }
            walk_text(child, out);
            if block {
                out.push('\n');
            }
        }
    }
}

fn strip_tags(html: &str) -> String {
    let mut out = String::with_capacity(html.len() / 2);
    let mut chars = html.chars().peekable();
    let mut skipping = false;
    while let Some(ch) = chars.next() {
        if ch == '<' {
            let mut tag = String::new();
            for c in chars.by_ref() {
                if c == '>' {
                    break;
                }
                tag.push(c);
            }
            let lower = tag.to_ascii_lowercase();
            if lower.starts_with("script") || lower.starts_with("style") {
                skipping = true;
            }
            if lower.starts_with("/script") || lower.starts_with("/style") {
                skipping = false;
            }
            // Block-ish tags become newlines.
            if matches!(
                lower.trim_start_matches('/').split_whitespace().next(),
                Some("p" | "div" | "br" | "li" | "h1" | "h2" | "h3" | "h4" | "tr")
            ) {
                out.push('\n');
            }
            continue;
        }
        if !skipping {
            out.push(ch);
        }
    }
    out.replace("&nbsp;", " ")
        .replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
}

fn normalize_text(raw: &str) -> String {
    let mut lines: Vec<String> = Vec::new();
    for line in raw.split('\n') {
        let collapsed = line.split_whitespace().collect::<Vec<_>>().join(" ");
        if !collapsed.is_empty() {
            lines.push(collapsed);
        }
    }
    lines.join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolves_opf_relative_hrefs() {
        assert_eq!(
            resolve_href("OEBPS", "text/ch1.xhtml#frag"),
            "OEBPS/text/ch1.xhtml"
        );
        assert_eq!(resolve_href("", "ch1.xhtml"), "ch1.xhtml");
        assert_eq!(resolve_href("OEBPS", "../images/a.png"), "images/a.png");
        assert_eq!(resolve_href("OEBPS", "a%20b.xhtml"), "OEBPS/a b.xhtml");
    }

    #[test]
    fn extracts_text_and_skips_scripts() {
        let html = r#"<html><head><style>p{color:red}</style><script>evil()</script></head>
            <body><h1>Chapter One</h1><p>The <em>quick</em> brown fox.</p><p>Second &#8212; paragraph.</p></body></html>"#;
        let text = html_to_text(html);
        assert!(text.contains("Chapter One"));
        assert!(text.contains("The quick brown fox."));
        assert!(text.contains("Second — paragraph."));
        assert!(!text.contains("evil"));
        assert!(!text.contains("color:red"));
    }

    #[test]
    fn strips_tags_when_xml_is_malformed() {
        let html = "<html><body><p>Broken <b>book</p><script>x()</script><p>still readable";
        let text = html_to_text(html);
        assert!(text.contains("Broken"));
        assert!(text.contains("still readable"));
        assert!(!text.contains("x()"));
    }

    #[test]
    fn mime_types_are_sensible() {
        assert_eq!(mime_for("a/b/img.PNG"), "image/png");
        assert_eq!(mime_for("c.xhtml"), "application/xhtml+xml");
        assert_eq!(mime_for("blob"), "application/octet-stream");
    }
}
