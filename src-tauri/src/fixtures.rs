//! Programmatic fixtures for tests: tiny EPUBs (EPUB 2 and 3, DRM, zip bomb,
//! RTL, nested TOC, cover) and tiny PDFs. Everything is generated, so no
//! copyrighted book ever needs to be committed.

use std::io::{Cursor, Write};
use std::path::{Path, PathBuf};

use crate::error::AppResult;

pub struct EpubOptions {
    pub title: String,
    pub author: String,
    pub language: String,
    pub chapters: Vec<(String, String)>,
    pub cover: bool,
    pub epub3: bool,
    pub rtl: bool,
    pub fixed_layout: bool,
    pub drm: bool,
    pub zip_bomb: bool,
}

impl Default for EpubOptions {
    fn default() -> Self {
        Self {
            title: "The Test Book".into(),
            author: "Test Author".into(),
            language: "en".into(),
            chapters: vec![
                (
                    "Chapter One".into(),
                    "<h1>Chapter One</h1><p>The <em>quick</em> brown fox jumps over the lazy dog.</p>\
                     <p id=\"note1\">A footnote lives here.</p><img src=\"../images/pic.png\" alt=\"pic\"/>"
                        .into(),
                ),
                (
                    "Chapter Two".into(),
                    "<h1>Chapter Two</h1><p>Second chapter text with the word needle inside.</p>"
                        .into(),
                ),
            ],
            cover: true,
            epub3: true,
            rtl: false,
            fixed_layout: false,
            drm: false,
            zip_bomb: false,
        }
    }
}

fn cover_png() -> Vec<u8> {
    let mut img = image::RgbImage::new(240, 360);
    for (x, y, px) in img.enumerate_pixels_mut() {
        let wave = ((x / 12 + y / 24) % 3) as u8;
        *px = image::Rgb([40 + wave * 20, 70 + wave * 25, 95 + wave * 18]);
    }
    let mut out = Vec::new();
    image::DynamicImage::ImageRgb8(img)
        .write_to(&mut Cursor::new(&mut out), image::ImageFormat::Png)
        .expect("png encode");
    out
}

fn pic_png() -> Vec<u8> {
    let img = image::RgbImage::from_pixel(64, 64, image::Rgb([200, 120, 60]));
    let mut out = Vec::new();
    image::DynamicImage::ImageRgb8(img)
        .write_to(&mut Cursor::new(&mut out), image::ImageFormat::Png)
        .expect("png encode");
    out
}

fn add_file(
    zip: &mut zip::ZipWriter<std::fs::File>,
    name: &str,
    bytes: &[u8],
    stored: bool,
) -> AppResult<()> {
    let method = if stored {
        zip::CompressionMethod::Stored
    } else {
        zip::CompressionMethod::Deflated
    };
    let options: zip::write::SimpleFileOptions = zip::write::SimpleFileOptions::default()
        .compression_method(method)
        .unix_permissions(0o644);
    zip.start_file(name, options)?;
    zip.write_all(bytes)?;
    Ok(())
}

pub fn write_epub(dir: &Path, opts: &EpubOptions) -> AppResult<PathBuf> {
    let path = dir.join(format!(
        "fixture-{}.epub",
        opts.title.to_lowercase().replace(' ', "-")
    ));
    let file = std::fs::File::create(&path)?;
    let mut zip = zip::ZipWriter::new(file);

    add_file(&mut zip, "mimetype", b"application/epub+zip", true)?;
    let container = r#"<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>"#;
    add_file(
        &mut zip,
        "META-INF/container.xml",
        container.as_bytes(),
        false,
    )?;
    if opts.drm {
        add_file(
            &mut zip,
            "META-INF/rights.xml",
            br#"<?xml version="1.0"?><rights><agreement>drm</agreement></rights>"#,
            false,
        )?;
    }

    let mut manifest = String::new();
    let mut spine = String::new();
    for (i, _) in opts.chapters.iter().enumerate() {
        let n = i + 1;
        manifest.push_str(&format!(
            r#"<item id="ch{n}" href="text/ch{n}.xhtml" media-type="application/xhtml+xml"/>
"#
        ));
        spine.push_str(&format!(
            r#"<itemref idref="ch{n}"/>
"#
        ));
    }
    manifest.push_str(
        r#"<item id="css" href="styles/main.css" media-type="text/css"/>
"#,
    );
    if opts.cover {
        manifest.push_str(
            r#"<item id="cover-image" href="images/cover.png" media-type="image/png" properties="cover-image"/>
"#,
        );
    }
    if opts.epub3 {
        manifest.push_str(
            r#"<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
"#,
        );
    } else {
        manifest.push_str(
            r#"<item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>
"#,
        );
    }

    let direction = if opts.rtl {
        r#" page-progression-direction="rtl""#
    } else {
        ""
    };
    let toc_attr = if opts.epub3 {
        String::new()
    } else {
        r#" toc="ncx""#.to_string()
    };
    let layout_meta = if opts.fixed_layout {
        r#"<meta property="rendition:layout">pre-paginated</meta>"#
    } else {
        ""
    };
    let opf = format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="{version}" unique-identifier="bookid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="bookid">urn:uuid:test-{slug}</dc:identifier>
    <dc:title>{title}</dc:title>
    <dc:creator>{author}</dc:creator>
    <dc:language>{lang}</dc:language>
    <meta name="cover" content="cover-image"/>
    {layout_meta}
  </metadata>
  <manifest>
    {manifest}
  </manifest>
  <spine{direction}{toc_attr}>
    {spine}
  </spine>
</package>"#,
        version = if opts.epub3 { "3.0" } else { "2.0" },
        slug = opts.title.to_lowercase().replace(' ', "-"),
        title = opts.title,
        author = opts.author,
        lang = opts.language,
        layout_meta = layout_meta,
        direction = direction,
        toc_attr = toc_attr,
        manifest = manifest,
        spine = spine,
    );
    add_file(&mut zip, "OEBPS/content.opf", opf.as_bytes(), false)?;

    for (i, (title, body)) in opts.chapters.iter().enumerate() {
        let n = i + 1;
        let html = format!(
            r#"<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml"><head><title>{title}</title>
<link rel="stylesheet" href="../styles/main.css"/><script>alert('evil')</script></head>
<body><section>{body}</section></body></html>"#
        );
        add_file(
            &mut zip,
            &format!("OEBPS/text/ch{n}.xhtml"),
            html.as_bytes(),
            false,
        )?;
    }
    add_file(
        &mut zip,
        "OEBPS/styles/main.css",
        b"body{font-family:serif}h1{font-size:2em}",
        false,
    )?;
    if opts.cover {
        add_file(&mut zip, "OEBPS/images/cover.png", &cover_png(), false)?;
    }
    add_file(&mut zip, "OEBPS/images/pic.png", &pic_png(), false)?;

    if opts.epub3 {
        let mut items = String::new();
        for (i, (title, _)) in opts.chapters.iter().enumerate() {
            let n = i + 1;
            items.push_str(&format!(
                r#"<li><a href="text/ch{n}.xhtml">{title}</a>
                  <ol><li><a href="text/ch{n}.xhtml#note1">{title}, note</a></li></ol></li>
"#
            ));
        }
        let nav = format!(
            r#"<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
<head><title>Contents</title></head><body>
<nav epub:type="toc" id="toc"><h1>Contents</h1><ol>{items}</ol></nav>
</body></html>"#
        );
        add_file(&mut zip, "OEBPS/nav.xhtml", nav.as_bytes(), false)?;
    } else {
        let mut points = String::new();
        for (i, (title, _)) in opts.chapters.iter().enumerate() {
            let n = i + 1;
            points.push_str(&format!(
                r#"<navPoint id="np{n}" playOrder="{n}"><navLabel><text>{title}</text></navLabel>
                   <content src="text/ch{n}.xhtml"/>
                   <navPoint id="np{n}-a" playOrder="{n}"><navLabel><text>{title} note</text></navLabel>
                     <content src="text/ch{n}.xhtml#note1"/></navPoint>
                 </navPoint>"#
            ));
        }
        let ncx = format!(
            r#"<?xml version="1.0" encoding="UTF-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
<head><meta name="dtb:uid" content="urn:uuid:test"/></head><docTitle><text>{title}</text></docTitle>
<navMap>{points}</navMap></ncx>"#,
            title = opts.title
        );
        add_file(&mut zip, "OEBPS/toc.ncx", ncx.as_bytes(), false)?;
    }

    if opts.zip_bomb {
        // 40 MB of zeros compresses to a few kB: a classic zip bomb.
        let zeros = vec![0u8; 40 * 1024 * 1024];
        add_file(&mut zip, "OEBPS/bomb.bin", &zeros, false)?;
    }

    zip.finish()?;
    Ok(path)
}

/// Minimal but structurally valid PDF.
pub fn write_pdf(path: &Path, pages: usize, title: &str) -> AppResult<()> {
    use lopdf::{dictionary, Document, Object, ObjectId};
    let mut doc = Document::with_version("1.5");
    // A page's /Contents must be an indirect object: an inline stream inside a
    // dictionary is not valid PDF and confuses readers.
    let font_id = doc.add_object(dictionary! {
        "Type" => "Font",
        "Subtype" => "Type1",
        "BaseFont" => "Helvetica",
    });
    let pages_id: ObjectId = doc.new_object_id();
    let mut kids: Vec<Object> = Vec::new();
    for index in 0..pages {
        let text = format!(
            "BT /F1 18 Tf 72 760 Td (Page {} of the Bookshelf fixture) Tj ET",
            index + 1
        );
        let content_id = doc.add_object(Object::Stream(lopdf::Stream::new(
            lopdf::Dictionary::new(),
            text.into_bytes(),
        )));
        let page_id = doc.add_object(dictionary! {
            "Type" => "Page",
            "Parent" => pages_id,
            "MediaBox" => vec![
                Object::Integer(0),
                Object::Integer(0),
                Object::Integer(595),
                Object::Integer(842),
            ],
            "Contents" => content_id,
            "Resources" => dictionary! {
                "Font" => dictionary! { "F1" => font_id }
            },
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
        "Author" => Object::string_literal("Fixture Author"),
    });
    doc.trailer.set("Root", catalog_id);
    doc.trailer.set("Info", info_id);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    doc.save(path)?;
    Ok(())
}
