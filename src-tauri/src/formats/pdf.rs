//! PDF metadata via lopdf: page count and document info. Rendering is done by
//! pdf.js in the webview (see docs/DECISIONS.md); Rust never rasterises pages,
//! so no pdfium/MuPDF binary or licence obligations.

use std::path::Path;

use lopdf::{Document, Object};

use crate::error::{AppError, AppResult};
use crate::formats::{BookFormatHandler, ProbedBook};
use crate::models::BookFormat;
use crate::util::title_from_filename;

pub struct PdfHandler;

#[derive(Debug, Clone, Default)]
pub struct PdfInfo {
    pub pages: i64,
    pub title: Option<String>,
    pub author: Option<String>,
    pub encrypted: bool,
}

impl BookFormatHandler for PdfHandler {
    fn format(&self) -> BookFormat {
        BookFormat::Pdf
    }

    fn probe(&self, path: &Path) -> AppResult<ProbedBook> {
        let info = inspect(path)?;
        let fallback_title = title_from_filename(path);
        Ok(ProbedBook {
            title: info
                .title
                .filter(|t| !t.trim().is_empty())
                .unwrap_or(fallback_title),
            author: info.author.unwrap_or_default(),
            language: None,
            pages: info.pages.max(1),
            cover: None,
            encrypted: info.encrypted,
            chapters: Vec::new(),
        })
    }
}

pub fn inspect(path: &Path) -> AppResult<PdfInfo> {
    let bytes = std::fs::read(path)?;
    if !bytes.starts_with(b"%PDF-") {
        return Err(AppError::Corrupt(format!(
            "{} is not a PDF file",
            path.display()
        )));
    }
    let encrypted = contains(&bytes, b"/Encrypt");
    match Document::load_mem(&bytes) {
        Ok(doc) => {
            // The Info entry is usually an indirect reference.
            let info = doc.trailer.get(b"Info").ok().and_then(|obj| {
                let resolved = match obj {
                    Object::Reference(id) => doc.get_object(*id).ok(),
                    other => Some(other),
                };
                resolved.and_then(|o| o.as_dict().ok()).cloned()
            });
            let get = |key: &[u8]| -> Option<String> {
                let dict = info.as_ref()?;
                let obj = dict.get(key).ok()?;
                object_string(obj).filter(|s| !s.trim().is_empty())
            };
            Ok(PdfInfo {
                pages: doc.get_pages().len() as i64,
                title: get(b"Title"),
                author: get(b"Author"),
                encrypted,
            })
        }
        Err(err) if encrypted => {
            // Encrypted documents cannot be opened without the password; the
            // reader asks for it via pdf.js. Import still succeeds so the user
            // can keep the book and unlock it later.
            tracing::info!(?err, "encrypted PDF imported without metadata");
            Ok(PdfInfo {
                pages: 0,
                title: None,
                author: None,
                encrypted: true,
            })
        }
        Err(err) => Err(AppError::Corrupt(format!("{}: {err}", path.display()))),
    }
}

fn contains(haystack: &[u8], needle: &[u8]) -> bool {
    haystack
        .windows(needle.len())
        .any(|window| window == needle)
}

/// PDF strings are either UTF-16BE with a BOM or PDFDocEncoding. We decode the
/// common cases and fall back to a lossy Latin-1 reading.
fn object_string(obj: &Object) -> Option<String> {
    match obj {
        Object::String(bytes, _) => Some(decode_pdf_text(bytes)),
        Object::Name(bytes) => Some(String::from_utf8_lossy(bytes).to_string()),
        _ => None,
    }
}

pub fn decode_pdf_text(bytes: &[u8]) -> String {
    if bytes.len() >= 2 && bytes[0] == 0xFE && bytes[1] == 0xFF {
        let units: Vec<u16> = bytes[2..]
            .chunks_exact(2)
            .map(|c| u16::from_be_bytes([c[0], c[1]]))
            .collect();
        String::from_utf16_lossy(&units)
    } else if bytes.len() >= 3 && bytes[0] == 0xEF && bytes[1] == 0xBB && bytes[2] == 0xBF {
        String::from_utf8_lossy(&bytes[3..]).to_string()
    } else {
        // PDFDocEncoding is close enough to Latin-1 for the metadata we show.
        bytes.iter().map(|b| *b as char).collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use lopdf::dictionary;

    /// Build a one-page PDF in a temp dir without any copyrighted content.
    pub fn make_pdf(path: &Path, pages: usize, title: &str) -> AppResult<()> {
        use lopdf::ObjectId;
        let mut doc = Document::with_version("1.5");
        let pages_id: ObjectId = doc.new_object_id();
        let mut kids: Vec<Object> = Vec::new();
        for _ in 0..pages {
            let page_id = doc.add_object(dictionary! {
                "Type" => "Page",
                "Parent" => pages_id,
                "MediaBox" => vec![
                    Object::Integer(0),
                    Object::Integer(0),
                    Object::Integer(595),
                    Object::Integer(842),
                ],
                "Contents" => Object::Stream(lopdf::Stream::new(
                    lopdf::Dictionary::new(),
                    b"BT /F1 12 Tf 72 720 Td (Hello) Tj ET".to_vec(),
                )),
            });
            kids.push(Object::Reference(page_id));
        }
        doc.objects.insert(
            pages_id,
            Object::Dictionary(dictionary! {
                "Type" => "Pages",
                "Kids" => kids,
                "Count" => pages as i64,
            }),
        );
        let catalog_id = doc.add_object(dictionary! {
            "Type" => "Catalog",
            "Pages" => pages_id,
        });
        let info_id = doc.add_object(dictionary! {
            "Title" => Object::string_literal(title),
            "Author" => Object::string_literal("Test Author"),
        });
        doc.trailer.set("Root", catalog_id);
        doc.trailer.set("Info", info_id);
        doc.save(path)?;
        Ok(())
    }

    #[test]
    fn reads_page_count_and_info() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("fixture.pdf");
        make_pdf(&path, 3, "A Test Book").unwrap();
        let info = inspect(&path).unwrap();
        assert_eq!(info.pages, 3);
        assert_eq!(info.title.as_deref(), Some("A Test Book"));
        assert_eq!(info.author.as_deref(), Some("Test Author"));
        assert!(!info.encrypted);

        let probed = PdfHandler.probe(&path).unwrap();
        assert_eq!(probed.title, "A Test Book");
        assert!(probed.cover.is_none());
    }

    #[test]
    fn rejects_non_pdf_bytes() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("nope.pdf");
        std::fs::write(&path, b"not a pdf at all").unwrap();
        assert!(inspect(&path).is_err());
    }

    #[test]
    fn encrypted_flag_is_detected_and_import_survives() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("locked.pdf");
        // A file with a valid header and an /Encrypt marker: lopdf cannot open
        // it, but we must import it as locked rather than crash or fail.
        std::fs::write(
            &path,
            b"%PDF-1.7\n1 0 obj << /Type /Catalog >> endobj\ntrailer << /Encrypt 9 0 R >>\n%%EOF\n",
        )
        .unwrap();
        let info = inspect(&path).unwrap();
        assert!(info.encrypted);
        assert_eq!(info.pages, 0);
        let probed = PdfHandler.probe(&path).unwrap();
        assert!(probed.encrypted);
        assert_eq!(probed.title, "Locked");
    }

    #[test]
    fn decodes_utf16_and_latin1_strings() {
        assert_eq!(decode_pdf_text(&[0xFE, 0xFF, 0x00, 0x41]), "A");
        assert_eq!(decode_pdf_text(b"Plain"), "Plain");
        // PDFDocEncoding is single-byte Latin-1 for the accented range.
        assert_eq!(decode_pdf_text(&[b'C', b'a', b'f', 0xE9]), "Café");
    }
}
