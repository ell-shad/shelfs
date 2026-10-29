//! EPUB chapter sanitisation and URL rewriting.
//!
//! Chapters are untrusted input. They are streamed through `lol_html`, which
//! removes active content (scripts, frames, forms, event handlers), rewrites
//! resource URLs to this app's `bookshelf://` origin, and blocks `javascript:`
//! and `data:text/html` payloads. The webview additionally runs them in a
//! sandboxed iframe with CSP `connect-src 'none'`.

use lol_html::{element, rewrite_str, RewriteStrSettings};

use crate::error::{AppError, AppResult};

pub const MAX_CHAPTER_BYTES: usize = 8 * 1024 * 1024;

pub struct SanitizeOptions<'a> {
    /// Absolute base of the book, ending in a slash, e.g.
    /// `http://bookshelf.localhost/epub/12/`.
    pub book_base: &'a str,
    /// Chapter href inside the book, e.g. `OEBPS/text/ch1.xhtml`.
    pub chapter_href: &'a str,
    pub publisher_styles: bool,
}

const REMOVE_TAGS: &[&str] = &[
    "script", "iframe", "object", "embed", "base", "form", "input", "button", "textarea", "select",
    "meta", "applet", "frame", "frameset",
];

pub fn sanitize_chapter(html: &str, opts: &SanitizeOptions<'_>) -> AppResult<String> {
    if html.len() > MAX_CHAPTER_BYTES {
        return Err(AppError::Format("chapter is too large".into()));
    }
    let dir = dirname(opts.chapter_href);
    let book_base = opts.book_base.to_string();
    let styles = opts.publisher_styles;

    let out = rewrite_str(
        html,
        RewriteStrSettings::new().append_element_content_handler(element!("*", move |el| {
            let tag = el.tag_name().to_ascii_lowercase();
            if REMOVE_TAGS.contains(&tag.as_str()) {
                el.remove();
                return Ok(());
            }
            if tag == "link" {
                let rel = el
                    .get_attribute("rel")
                    .unwrap_or_default()
                    .to_ascii_lowercase();
                if !styles || !rel.split_whitespace().any(|r| r == "stylesheet") {
                    el.remove();
                    return Ok(());
                }
            }
            if !styles {
                el.remove_attribute("style");
                el.remove_attribute("class");
            }
            // Snapshot attributes before mutating the element.
            let attrs: Vec<(String, String)> = el
                .attributes()
                .iter()
                .map(|a| (a.name().to_string(), a.value().to_string()))
                .collect();
            for (name, value) in attrs {
                let lower = name.to_ascii_lowercase();
                if lower.starts_with("on") {
                    el.remove_attribute(&name);
                    continue;
                }
                if lower == "srcset" || lower == "ping" {
                    el.remove_attribute(&name);
                    continue;
                }
                if lower == "style" && !styles {
                    el.remove_attribute(&name);
                    continue;
                }
                // `xlink:href` and namespaced hrefs end with "href".
                let is_href = lower == "href" || lower.ends_with(":href");
                let is_src = lower == "src" || lower.ends_with(":src");
                if !is_href && !is_src {
                    continue;
                }
                match rewrite_url(&value, &book_base, &dir) {
                    UrlAction::Keep => {}
                    UrlAction::Remove => {
                        el.remove_attribute(&name);
                    }
                    UrlAction::Replace(new_url) => {
                        let _ = el.set_attribute(&name, &new_url);
                    }
                }
            }
            Ok(())
        })),
    )
    .map_err(|e| AppError::Format(format!("could not sanitise chapter: {e}")))?;

    if out.len() > MAX_CHAPTER_BYTES {
        return Err(AppError::Format(
            "chapter is too large after sanitising".into(),
        ));
    }
    Ok(out)
}

enum UrlAction {
    Keep,
    Remove,
    Replace(String),
}

fn rewrite_url(url: &str, book_base: &str, chapter_dir: &str) -> UrlAction {
    let trimmed = url.trim();
    if trimmed.is_empty() {
        return UrlAction::Keep;
    }
    let lower = trimmed.to_ascii_lowercase();
    if lower.starts_with("javascript:") || lower.starts_with("vbscript:") {
        return UrlAction::Remove;
    }
    if lower.starts_with("data:") {
        // Inline images are fine; inline HTML/SVG documents are not a resource
        // we ever need.
        if lower.starts_with("data:image/") {
            return UrlAction::Keep;
        }
        return UrlAction::Remove;
    }
    if lower.starts_with("mailto:") || lower.starts_with("tel:") {
        return UrlAction::Keep;
    }
    if lower.starts_with("http://") || lower.starts_with("https://") {
        // Remote content never loads (CSP blocks it), but keep the URL so the
        // "external link" prompt can offer to open it in the browser.
        return UrlAction::Keep;
    }
    if lower.starts_with("file:") || lower.contains("\\\\") {
        return UrlAction::Remove;
    }
    let absolute = if trimmed.starts_with('#') {
        trimmed.to_string()
    } else if trimmed.starts_with('/') {
        let rest = trimmed.trim_start_matches('/');
        format!(
            "{}{rest}",
            book_base.trim_end_matches('/').to_string() + "/"
        )
    } else {
        let joined = if chapter_dir.is_empty() {
            trimmed.to_string()
        } else {
            format!("{chapter_dir}/{trimmed}")
        };
        let normalized = normalize_path(&joined);
        format!("{book_base}{normalized}")
    };
    UrlAction::Replace(absolute)
}

fn dirname(href: &str) -> String {
    match href.rfind('/') {
        Some(idx) => href[..idx].to_string(),
        None => String::new(),
    }
}

/// Resolve `.`/`..` segments without touching percent-escapes. Escapes above
/// the book root are clamped, so a hostile href cannot read outside the book.
pub fn normalize_path(path: &str) -> String {
    let mut stack: Vec<&str> = Vec::new();
    for segment in path.split('/') {
        match segment {
            "" | "." => {}
            ".." => {
                stack.pop();
            }
            other => stack.push(other),
        }
    }
    stack.join("/")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn opts<'a>(base: &'a str, href: &'a str) -> SanitizeOptions<'a> {
        SanitizeOptions {
            book_base: base,
            chapter_href: href,
            publisher_styles: true,
        }
    }

    #[test]
    fn strips_active_content() {
        let html = r#"<html><head><script>alert(1)</script><link rel="stylesheet" href="s.css"></head>
            <body onload="alert(2)"><p onclick="x()">Hi <b>there</b></p>
            <iframe src="http://evil.test"></iframe><object data="x"></object>
            <a href="javascript:alert(1)">click</a><img src="data:text/html;base64,AAA"></body></html>"#;
        let out = sanitize_chapter(
            html,
            &opts("http://bookshelf.localhost/epub/1/", "OEBPS/c1.xhtml"),
        )
        .unwrap();
        assert!(!out.contains("<script"));
        assert!(!out.contains("onload"));
        assert!(!out.contains("onclick"));
        assert!(!out.contains("<iframe"));
        assert!(!out.contains("<object"));
        assert!(!out.contains("javascript:"));
        assert!(!out.contains("data:text/html"));
        assert!(out.contains("Hi <b>there</b>"));
        assert!(out.contains("http://bookshelf.localhost/epub/1/OEBPS/s.css"));
    }

    #[test]
    fn rewrites_relative_resources_against_chapter_directory() {
        let html = r#"<body><img src="../images/cover.jpg"><a href="ch2.xhtml#note1">next</a>
            <img src="/root.png"><img src="https://example.org/x.png"></body>"#;
        let out = sanitize_chapter(
            html,
            &opts("http://bookshelf.localhost/epub/7/", "OEBPS/text/ch1.xhtml"),
        )
        .unwrap();
        assert!(out.contains("http://bookshelf.localhost/epub/7/OEBPS/images/cover.jpg"));
        assert!(out.contains("http://bookshelf.localhost/epub/7/OEBPS/text/ch2.xhtml#note1"));
        assert!(out.contains("http://bookshelf.localhost/epub/7/root.png"));
        assert!(out.contains("https://example.org/x.png"));
    }

    #[test]
    fn traversal_cannot_escape_book_root() {
        let out = normalize_path("../../../etc/passwd");
        assert_eq!(out, "etc/passwd");
        let html = r#"<img src="../../../../secret.png">"#;
        let out = sanitize_chapter(
            html,
            &opts("http://bookshelf.localhost/epub/2/", "OEBPS/ch1.xhtml"),
        )
        .unwrap();
        assert!(out.contains("http://bookshelf.localhost/epub/2/secret.png"));
    }

    #[test]
    fn publisher_styles_can_be_disabled() {
        let html = r#"<head><link rel="stylesheet" href="style.css"></head>
            <body><p class="x" style="color:red">text</p></body>"#;
        let mut o = opts("http://bookshelf.localhost/epub/1/", "c1.xhtml");
        o.publisher_styles = false;
        let out = sanitize_chapter(html, &o).unwrap();
        assert!(!out.contains("style.css"));
        assert!(!out.contains("style=\"color:red\""));
        assert!(out.contains("text"));
    }

    #[test]
    fn keeps_inline_data_images_and_anchor_links() {
        let html = r##"<img src="data:image/png;base64,AAA"><a href="#n1">note</a>"##;
        let out = sanitize_chapter(
            html,
            &opts("http://bookshelf.localhost/epub/1/", "c1.xhtml"),
        )
        .unwrap();
        assert!(out.contains("data:image/png"));
        assert!(out.contains("href=\"#n1\""));
    }

    #[test]
    fn oversized_chapters_are_rejected() {
        let big = "x".repeat(MAX_CHAPTER_BYTES + 1);
        assert!(sanitize_chapter(&big, &opts("http://b/", "c.xhtml")).is_err());
    }
}
