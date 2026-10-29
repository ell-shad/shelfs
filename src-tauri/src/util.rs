use std::time::{SystemTime, UNIX_EPOCH};

pub fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Deterministic 0..1 value derived from a hash, used for stable book
/// dimensions (the same file always produces the same book).
pub fn unit_from_hash(hash: &str, salt: u32) -> f64 {
    let bytes = hash.as_bytes();
    let start = (salt as usize * 4) % bytes.len().max(1);
    let mut acc: u32 = 0x811c_9dc5 ^ salt;
    for (i, b) in bytes.iter().enumerate() {
        if i >= start && i < start + 8 {
            acc = acc.wrapping_mul(16_777_619) ^ u32::from(*b);
        }
    }
    f64::from(acc) / f64::from(u32::MAX)
}

/// Standard base64 (with padding). Used to hand a PDF to pdf.js over IPC: the
/// bytes travel as one string instead of a JSON number array, which keeps a
/// 10 MB book to ~13 MB on the wire rather than ~30 MB. Implemented here so the
/// core takes no extra dependency for 20 lines of code.
pub fn base64_encode(bytes: &[u8]) -> String {
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let b0 = u32::from(chunk[0]);
        let b1 = u32::from(*chunk.get(1).unwrap_or(&0));
        let b2 = u32::from(*chunk.get(2).unwrap_or(&0));
        let triple = (b0 << 16) | (b1 << 8) | b2;
        out.push(char::from(ALPHABET[((triple >> 18) & 0x3f) as usize]));
        out.push(char::from(ALPHABET[((triple >> 12) & 0x3f) as usize]));
        out.push(if chunk.len() > 1 {
            char::from(ALPHABET[((triple >> 6) & 0x3f) as usize])
        } else {
            '='
        });
        out.push(if chunk.len() > 2 {
            char::from(ALPHABET[(triple & 0x3f) as usize])
        } else {
            '='
        });
    }
    out
}

/// Decode `%XX` escapes; invalid sequences are kept verbatim.
pub fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            let hex = std::str::from_utf8(&bytes[i + 1..i + 3]).ok();
            if let Some(value) = hex.and_then(|h| u8::from_str_radix(h, 16).ok()) {
                out.push(value);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).to_string()
}

pub fn is_hex_color(s: &str) -> bool {
    let b = s.as_bytes();
    (b.len() == 7 || b.len() == 4) && b[0] == b'#' && b[1..].iter().all(|c| c.is_ascii_hexdigit())
}

pub fn safe_file_stem(title: &str) -> String {
    let cleaned: String = title
        .chars()
        .map(|c| {
            if c.is_alphanumeric() || c == ' ' || c == '-' || c == '_' || c == '.' {
                c
            } else {
                '_'
            }
        })
        .collect();
    let trimmed = cleaned.trim().trim_matches('.').trim();
    let stem: String = trimmed.chars().take(80).collect();
    if stem.is_empty() {
        "book".to_string()
    } else {
        stem
    }
}

/// Human title from a file name when the file has no metadata.
pub fn title_from_filename(path: &std::path::Path) -> String {
    path.file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| "Untitled".into())
        .replace(['_', '-'], " ")
        .split_whitespace()
        .map(|w| {
            let mut chars = w.chars();
            match chars.next() {
                Some(first) => first.to_uppercase().collect::<String>() + chars.as_str(),
                None => String::new(),
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

/// Count UTF-16 code units, matching JavaScript string offsets.
pub fn utf16_len(s: &str) -> u32 {
    s.encode_utf16().count() as u32
}

/// Position (in UTF-16 code units) of a byte offset inside `s`.
pub fn utf16_offset_of_byte(s: &str, byte: usize) -> u32 {
    let end = byte.min(s.len());
    s[..end].encode_utf16().count() as u32
}

/// Case-insensitive substring search that reports UTF-16 offsets in the
/// original string. Lower-casing can change the number of chars (e.g. `İ`),
/// so we keep a mapping from lower-cased char index to original char index.
#[derive(Debug, Clone)]
pub struct FoldedText {
    folded: String,
    /// For each char index in `folded`, the char index in the original text.
    map: Vec<usize>,
    original: String,
}

impl FoldedText {
    pub fn new(original: &str) -> Self {
        let mut folded = String::with_capacity(original.len());
        let mut map = Vec::with_capacity(original.len());
        for (i, ch) in original.char_indices() {
            for lower in ch.to_lowercase() {
                folded.push(lower);
                map.push(i);
            }
        }
        Self {
            folded,
            map,
            original: original.to_string(),
        }
    }

    pub fn original(&self) -> &str {
        &self.original
    }

    /// Find all occurrences of `needle` (matched case-insensitively).
    /// Returns (utf16_start, utf16_end) pairs in the original string.
    pub fn find_all(&self, needle: &str) -> Vec<(u32, u32)> {
        let needle_folded: String = needle.chars().flat_map(|c| c.to_lowercase()).collect();
        if needle_folded.is_empty() {
            return Vec::new();
        }
        let needle_chars = needle_folded.chars().count();
        let hay = &self.folded;
        let mut out = Vec::new();
        let mut from = 0usize;
        while let Some(pos) = hay[from..].find(&needle_folded) {
            let start_byte = from + pos;
            let end_byte = start_byte + needle_folded.len();
            // `map` is indexed by char in the folded string, not by byte.
            let start_char = hay[..start_byte].chars().count();
            let end_char = start_char + needle_chars;
            let orig_start = self
                .map
                .get(start_char)
                .copied()
                .unwrap_or(self.original.len());
            let orig_end = self
                .map
                .get(end_char)
                .copied()
                .unwrap_or(self.original.len());
            out.push((
                utf16_offset_of_byte(&self.original, orig_start),
                utf16_offset_of_byte(&self.original, orig_end),
            ));
            from = end_byte;
            if out.len() > 10_000 {
                break;
            }
        }
        out
    }
}

/// Slice a string around a UTF-16 offset, clamped to char boundaries.
pub fn excerpt_around(text: &str, utf16_offset: u32, needle_len: u32, radius: u32) -> String {
    let start_units = utf16_offset.saturating_sub(radius);
    let end_units = utf16_offset + needle_len + radius;
    let mut consumed = 0u32;
    let mut start_byte = text.len();
    let mut end_byte = text.len();
    for (i, ch) in text.char_indices() {
        let units = ch.len_utf16() as u32;
        if consumed + units > start_units && start_byte == text.len() {
            start_byte = i;
        }
        consumed += units;
        if consumed >= end_units {
            end_byte = i + ch.len_utf8();
            break;
        }
    }
    if start_byte == text.len() {
        start_byte = 0;
    }
    let slice = &text[start_byte..end_byte.max(start_byte)];
    let trimmed = slice.split_whitespace().collect::<Vec<_>>().join(" ");
    if start_byte > 0 {
        format!("…{trimmed}")
    } else {
        trimmed
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base64_matches_known_vectors() {
        assert_eq!(base64_encode(b""), "");
        assert_eq!(base64_encode(b"f"), "Zg==");
        assert_eq!(base64_encode(b"fo"), "Zm8=");
        assert_eq!(base64_encode(b"foo"), "Zm9v");
        assert_eq!(base64_encode(b"foobar"), "Zm9vYmFy");
        assert_eq!(base64_encode(&[0xff, 0xfe, 0xfd]), "//79");
    }

    #[test]
    fn folds_with_expanding_lowercase() {
        let f = FoldedText::new("İstanbul BÜCHER");
        let hits = f.find_all("bücher");
        assert_eq!(hits.len(), 1);
        let (s, e) = hits[0];
        let units: Vec<u16> = "İstanbul BÜCHER".encode_utf16().collect();
        assert_eq!(
            String::from_utf16(&units[s as usize..e as usize]).unwrap(),
            "BÜCHER"
        );
        // İ lower-cases to two code points, so the char mapping is non-trivial.
        assert_eq!(s, 9);
    }

    #[test]
    fn finds_astral_characters_in_utf16_offsets() {
        let text = "a🎉b needLE c";
        let f = FoldedText::new(text);
        let hits = f.find_all("needle");
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].0, 5); // a(1) + emoji(2) + b(1) + space(1)
    }

    #[test]
    fn excerpt_is_safe_at_boundaries() {
        let text = "The quick brown fox jumps over the lazy dog";
        let e = excerpt_around(text, 4, 5, 6);
        assert!(e.contains("quick"));
        let all = excerpt_around(text, 0, 3, 100);
        assert!(all.starts_with("The quick"));
    }

    #[test]
    fn titles_from_filenames() {
        use std::path::Path;
        assert_eq!(
            title_from_filename(Path::new("/tmp/the_hobbit-1977.pdf")),
            "The Hobbit 1977"
        );
    }

    #[test]
    fn percent_decoding_is_forgiving() {
        assert_eq!(percent_decode("a%20b.xhtml"), "a b.xhtml");
        assert_eq!(percent_decode("100%25"), "100%");
        assert_eq!(percent_decode("bad%zz%"), "bad%zz%");
        assert_eq!(percent_decode("caf%C3%A9"), "café");
    }

    #[test]
    fn colors_validate() {
        assert!(is_hex_color("#aabbcc"));
        assert!(!is_hex_color("#xyz"));
        assert!(!is_hex_color("aabbcc"));
    }

    #[test]
    fn dimension_units_are_deterministic() {
        let a = unit_from_hash("abc123", 0);
        assert_eq!(a, unit_from_hash("abc123", 0));
        assert!((0.0..=1.0).contains(&a));
    }
}
