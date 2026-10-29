//! Cover extraction, downscaling, and spine-colour selection.
//!
//! Covers are decoded with hard limits (untrusted images must not exhaust
//! memory) and written as JPEG into the cache directory. The spine colour is
//! the dominant cover colour adjusted to a mid-tone, saturated value so the
//! gold/cream spine text stays legible.

use std::io::Cursor;
use std::path::{Path, PathBuf};

use image::{imageops::FilterType, DynamicImage, ImageReader, RgbImage};

use crate::error::{AppError, AppResult};
use crate::util::{is_hex_color, unit_from_hash};

pub const MAX_COVER_BYTES: usize = 24 * 1024 * 1024;
pub const COVER_MAX_W: u32 = 900;
pub const COVER_MAX_H: u32 = 1300;

/// Fallback palette from the prototype, used when a book has no usable cover.
pub const PALETTE: [&str; 8] = [
    "#6b4f3a", "#7a3b3b", "#3f5d4a", "#3a4f6b", "#6b5a3a", "#5b3f5d", "#804a2f", "#2f5d62",
];

pub struct StoredCover {
    pub path: PathBuf,
    pub color: String,
}

pub fn palette_color(hash: &str) -> String {
    let idx = (unit_from_hash(hash, 7) * PALETTE.len() as f64) as usize;
    PALETTE[idx.min(PALETTE.len() - 1)].to_string()
}

pub fn store_cover(cache_dir: &Path, key: &str, bytes: &[u8]) -> AppResult<Option<StoredCover>> {
    if bytes.is_empty() || bytes.len() > MAX_COVER_BYTES {
        return Ok(None);
    }
    let reader = ImageReader::new(Cursor::new(bytes))
        .with_guessed_format()
        .map_err(|e| AppError::Format(format!("cover: {e}")))?;
    let mut reader = reader;
    let mut limits = image::Limits::default();
    limits.max_image_width = Some(12_000);
    limits.max_image_height = Some(12_000);
    limits.max_alloc = Some(256 * 1024 * 1024);
    reader.limits(limits);
    let decoded: DynamicImage = match reader.decode() {
        Ok(img) => img,
        Err(err) => {
            tracing::debug!(%err, "cover image could not be decoded");
            return Ok(None);
        }
    };
    let mut rgb: RgbImage = flatten_on_white(decoded);
    if rgb.width() > COVER_MAX_W || rgb.height() > COVER_MAX_H {
        let scale =
            (COVER_MAX_W as f64 / rgb.width() as f64).min(COVER_MAX_H as f64 / rgb.height() as f64);
        let w = ((rgb.width() as f64 * scale).round() as u32).max(1);
        let h = ((rgb.height() as f64 * scale).round() as u32).max(1);
        rgb = image::imageops::resize(&rgb, w, h, FilterType::Triangle);
    }
    let color = dominant_color(&rgb);
    std::fs::create_dir_all(cache_dir)?;
    let path = cache_dir.join(format!("{key}.jpg"));
    let file = std::fs::File::create(&path)?;
    let mut encoder = image::codecs::jpeg::JpegEncoder::new_with_quality(file, 88);
    encoder
        .encode_image(&DynamicImage::ImageRgb8(rgb))
        .map_err(|e| AppError::Format(format!("cover: {e}")))?;
    Ok(Some(StoredCover { path, color }))
}

fn flatten_on_white(img: DynamicImage) -> RgbImage {
    let rgba = img.to_rgba8();
    let mut out = RgbImage::new(rgba.width(), rgba.height());
    for (x, y, px) in rgba.enumerate_pixels() {
        let a = f32::from(px[3]) / 255.0;
        let blend = |c: u8| -> u8 {
            ((f32::from(c) * a) + (255.0 * (1.0 - a)))
                .round()
                .clamp(0.0, 255.0) as u8
        };
        out.put_pixel(x, y, image::Rgb([blend(px[0]), blend(px[1]), blend(px[2])]));
    }
    out
}

/// Weighted average in RGB space, weighting saturated mid-bright pixels most,
/// then normalised to a mid-tone with enough saturation for light text.
pub fn dominant_color(img: &RgbImage) -> String {
    let small = image::imageops::resize(img, 32, 32, FilterType::Triangle);
    let mut total_w = 0.0f64;
    let mut r = 0.0f64;
    let mut g = 0.0f64;
    let mut b = 0.0f64;
    for px in small.pixels() {
        let (h, s, l) = rgb_to_hsl(px[0], px[1], px[2]);
        let _ = h;
        let mid = 1.0 - (2.0 * l - 1.0).abs(); // 1 at mid-lightness
        let w = (0.04 + s * s) * (0.25 + mid);
        total_w += w;
        r += f64::from(px[0]) * w;
        g += f64::from(px[1]) * w;
        b += f64::from(px[2]) * w;
    }
    if total_w < 1e-6 {
        return "#5b4a3a".into();
    }
    let (r, g, b) = (
        (r / total_w).round() as u8,
        (g / total_w).round() as u8,
        (b / total_w).round() as u8,
    );
    adjust_for_spine(r, g, b)
}

pub fn adjust_for_spine(r: u8, g: u8, b: u8) -> String {
    let (h, mut s, mut l) = rgb_to_hsl(r, g, b);
    // Mid-tone, saturated enough that cream/gold text reads on it.
    l = l.clamp(0.30, 0.56);
    s = s.clamp(0.28, 0.72);
    let (r, g, b) = hsl_to_rgb(h, s, l);
    let hex = format!("#{r:02x}{g:02x}{b:02x}");
    debug_assert!(is_hex_color(&hex));
    hex
}

pub fn rgb_to_hsl(r: u8, g: u8, b: u8) -> (f64, f64, f64) {
    let (rf, gf, bf) = (
        f64::from(r) / 255.0,
        f64::from(g) / 255.0,
        f64::from(b) / 255.0,
    );
    let max = rf.max(gf).max(bf);
    let min = rf.min(gf).min(bf);
    let l = (max + min) / 2.0;
    if (max - min).abs() < f64::EPSILON {
        return (0.0, 0.0, l);
    }
    let d = max - min;
    let s = if l > 0.5 {
        d / (2.0 - max - min)
    } else {
        d / (max + min)
    };
    let h = if (max - rf).abs() < f64::EPSILON {
        ((gf - bf) / d + if gf < bf { 6.0 } else { 0.0 }) * 60.0
    } else if (max - gf).abs() < f64::EPSILON {
        ((bf - rf) / d + 2.0) * 60.0
    } else {
        ((rf - gf) / d + 4.0) * 60.0
    };
    (h, s, l)
}

pub fn hsl_to_rgb(h: f64, s: f64, l: f64) -> (u8, u8, u8) {
    let c = (1.0 - (2.0 * l - 1.0).abs()) * s;
    let hp = (h.rem_euclid(360.0)) / 60.0;
    let x = c * (1.0 - (hp % 2.0 - 1.0).abs());
    let (r1, g1, b1) = match hp as u32 {
        0 => (c, x, 0.0),
        1 => (x, c, 0.0),
        2 => (0.0, c, x),
        3 => (0.0, x, c),
        4 => (x, 0.0, c),
        _ => (c, 0.0, x),
    };
    let m = l - c / 2.0;
    let to_u8 = |v: f64| ((v + m) * 255.0).round().clamp(0.0, 255.0) as u8;
    (to_u8(r1), to_u8(g1), to_u8(b1))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn very_light_cover_becomes_mid_tone() {
        let img = RgbImage::from_pixel(8, 8, image::Rgb([245, 243, 240]));
        let hex = dominant_color(&img);
        let (r, g, b) = hex_to_rgb(&hex);
        let (_, s, l) = rgb_to_hsl(r, g, b);
        assert!((0.29..=0.57).contains(&l), "lightness {l}");
        assert!(s >= 0.27, "saturation {s}");
    }

    #[test]
    fn dark_cover_is_lifted_for_legibility() {
        let img = RgbImage::from_pixel(8, 8, image::Rgb([12, 10, 9]));
        let (r, g, b) = hex_to_rgb(&dominant_color(&img));
        let (_, s, l) = rgb_to_hsl(r, g, b);
        assert!(l >= 0.29, "lightness {l}");
        assert!(s >= 0.27, "saturation {s}");
    }

    #[test]
    fn saturated_cover_keeps_its_hue() {
        let img = RgbImage::from_pixel(8, 8, image::Rgb([190, 40, 45]));
        let hex = dominant_color(&img);
        let (r, g, b) = hex_to_rgb(&hex);
        let (h, _, _) = rgb_to_hsl(r, g, b);
        assert!((h - 358.0).abs() < 6.0 || h < 6.0, "hue {h}");
    }

    #[test]
    fn cover_is_stored_as_jpeg_with_limits() {
        let dir = tempfile::tempdir().unwrap();
        let mut img = RgbImage::new(1200, 1800);
        for (x, y, px) in img.enumerate_pixels_mut() {
            *px = image::Rgb([(x % 255) as u8, (y % 255) as u8, 90]);
        }
        let mut bytes = Vec::new();
        DynamicImage::ImageRgb8(img)
            .write_to(&mut Cursor::new(&mut bytes), image::ImageFormat::Png)
            .unwrap();
        let stored = store_cover(dir.path(), "abc123", &bytes).unwrap().unwrap();
        assert!(stored.path.exists());
        assert!(is_hex_color(&stored.color));
        let decoded = image::open(&stored.path).unwrap();
        assert!(decoded.width() <= COVER_MAX_W);
        assert!(decoded.height() <= COVER_MAX_H);
    }

    #[test]
    fn garbage_cover_bytes_are_ignored() {
        let dir = tempfile::tempdir().unwrap();
        assert!(store_cover(dir.path(), "x", b"not an image")
            .unwrap()
            .is_none());
        assert!(store_cover(dir.path(), "x", &[]).unwrap().is_none());
    }

    #[test]
    fn palette_fallback_is_stable() {
        assert_eq!(palette_color("hash"), palette_color("hash"));
        assert!(is_hex_color(&palette_color("hash")));
    }

    fn hex_to_rgb(hex: &str) -> (u8, u8, u8) {
        let v = u32::from_str_radix(&hex[1..], 16).unwrap();
        (
            ((v >> 16) & 0xff) as u8,
            ((v >> 8) & 0xff) as u8,
            (v & 0xff) as u8,
        )
    }
}
