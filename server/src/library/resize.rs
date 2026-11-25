//! Ported from Navidrome (GPL-3.0), © the Navidrome authors.
//!
//! Resizing a cover (`core/artwork/resize.go`, `animation.go`, `processor.go`): the picture fitted into a square of
//! the size asked for (never enlarged), or centered on a transparent square canvas, scaled with Catmull-Rom, written as
//! PNG (a PNG source, or a square) or JPEG at `CoverArtQuality`. Navidrome's limits hold: at most `MaxImageSize`
//! bytes read (default 20 MB) and 64 Mi pixels declared, checked before anything is decoded (decompression bombs).
//!
//! The bytes are this server's encoders', not Go's: the same dimensions, format and validators, other pixels at the
//! edges of the scaling and another JPEG encoder.

use std::io::Cursor;

use image::codecs::jpeg::JpegEncoder;
use image::codecs::png::PngEncoder;
use image::imageops::FilterType;
use image::{ImageEncoder, ImageFormat, ImageReader, RgbaImage};

/// `maxImagePixels`.
pub const MAX_PIXELS: u64 = 64 << 20;

/// What a resize gives.
#[derive(Debug, PartialEq)]
pub enum Resized {
    /// New bytes.
    Bytes(Vec<u8>),
    /// The original bytes, as Navidrome serves them when the picture is within the size, animated, or cannot be
    /// read.
    Original,
    /// Navidrome's to make: an animated GIF (ffmpeg turns it into an animated WebP), or a size that leaves nothing.
    Navidromes(&'static str),
}

/// `isAnimatedGIF`: more than one image descriptor.
pub fn is_animated_gif(data: &[u8]) -> bool {
    if !data.starts_with(b"GIF") {
        return false;
    }
    let mut pos = 13usize;
    if pos >= data.len() {
        return false;
    }
    if data.len() > 10 && data[10] & 0x80 != 0 {
        pos += 3 * (1 << ((data[10] & 0x07) + 1));
    }
    let skip_blocks = |mut pos: usize| {
        while pos < data.len() {
            let size = data[pos] as usize;
            pos += 1;
            if size == 0 {
                break;
            }
            pos += size;
        }
        pos
    };
    let mut frames = 0;
    while pos < data.len() {
        match data[pos] {
            0x2C => {
                frames += 1;
                if frames > 1 {
                    return true;
                }
                pos += 1;
                if pos + 8 >= data.len() {
                    return false;
                }
                pos += 8;
                let packed = data[pos];
                pos += 1;
                if packed & 0x80 != 0 {
                    pos += 3 * (1 << ((packed & 0x07) + 1));
                }
                pos += 1;
                pos = skip_blocks(pos);
            }
            0x21 => {
                pos += 1;
                if pos >= data.len() {
                    return false;
                }
                pos += 1;
                pos = skip_blocks(pos);
            }
            _ => return false,
        }
    }
    false
}

/// `isAnimatedWebP`: an `ANMF` chunk anywhere.
pub fn is_animated_webp(data: &[u8]) -> bool {
    data.len() >= 12 && data.starts_with(b"RIFF") && &data[8..12] == b"WEBP" && data[12..].windows(4).any(|w| w == b"ANMF")
}

/// `isAnimatedPNG`: an `acTL` chunk.
pub fn is_animated_png(data: &[u8]) -> bool {
    if !data.starts_with(b"\x89PNG\r\n\x1a\n") {
        return false;
    }
    let mut pos: u64 = 8;
    let len = data.len() as u64;
    while pos + 8 <= len {
        let at = pos as usize;
        let chunk = u64::from(u32::from_be_bytes(data[at..at + 4].try_into().expect("four bytes")));
        if &data[at + 4..at + 8] == b"acTL" {
            return true;
        }
        pos += 12 + chunk;
    }
    false
}

/// The format Go's `image.DecodeConfig` names, for the four Navidrome reads.
fn format_of(data: &[u8]) -> Option<ImageFormat> {
    match image::guess_format(data).ok()? {
        format @ (ImageFormat::Jpeg | ImageFormat::Png | ImageFormat::Gif | ImageFormat::WebP) => Some(format),
        _ => None,
    }
}

/// Whether a square canvas of this size stays within the pixel cap.
pub fn square_fits(size: u32) -> bool {
    u64::from(size) * u64::from(size) <= MAX_PIXELS
}

/// `resizeImageData` without WebP encoding (Navidrome's when `EnableWebPEncoding` is on).
pub fn resize(data: &[u8], size: u32, square: bool, quality: u8) -> Resized {
    if is_animated_gif(data) {
        return Resized::Navidromes("an animated GIF, which Navidrome turns into an animated WebP");
    }
    if is_animated_webp(data) || is_animated_png(data) {
        return Resized::Original;
    }
    // decodeCapped: the declared size first; anything Go would not decode is served as it is
    let Some(format) = format_of(data) else { return Resized::Original };
    let Ok(reader) = ImageReader::with_format(Cursor::new(data), format).into_dimensions() else { return Resized::Original };
    let (width, height) = reader;
    if width == 0 || height == 0 || u64::from(width) * u64::from(height) > MAX_PIXELS {
        return Resized::Original;
    }
    let original = width.max(height);
    let size = size.min(original);
    if original <= size && !square {
        return Resized::Original;
    }
    // a square canvas is size × size, whatever the picture's own area: one of extreme shape (65535 × 1) would ask
    // for gigabytes (Navidrome allocates it, and may run out of memory); bounded as the picture is, the original is
    // served instead
    if square && !square_fits(size) {
        return Resized::Original;
    }
    // aspect fit, truncated as Go's int(float64(…))
    let scale = f64::from(size) / f64::from(original);
    let (fit_w, fit_h) = ((f64::from(width) * scale) as u32, (f64::from(height) * scale) as u32);
    if fit_w == 0 || fit_h == 0 {
        return Resized::Navidromes("a size that scales the picture to nothing");
    }
    let mut limits = image::Limits::default();
    limits.max_image_width = Some(width);
    limits.max_image_height = Some(height);
    limits.max_alloc = Some(MAX_PIXELS * 4 + (64 << 20));
    let mut reader = ImageReader::with_format(Cursor::new(data), format);
    reader.limits(limits);
    let Ok(decoded) = reader.decode() else { return Resized::Original };
    let scaled = image::imageops::resize(&decoded.to_rgba8(), fit_w, fit_h, FilterType::CatmullRom);
    let canvas = if square {
        let mut canvas = RgbaImage::new(size, size);
        image::imageops::replace(&mut canvas, &scaled, i64::from((size - fit_w) / 2), i64::from((size - fit_h) / 2));
        canvas
    } else {
        scaled
    };
    let mut out = Vec::new();
    let written = if format == ImageFormat::Png || square {
        PngEncoder::new(&mut out).write_image(&canvas, canvas.width(), canvas.height(), image::ExtendedColorType::Rgba8)
    } else {
        let rgb = image::DynamicImage::ImageRgba8(canvas).to_rgb8();
        JpegEncoder::new_with_quality(&mut out, quality.clamp(1, 100)).write_image(&rgb, rgb.width(), rgb.height(), image::ExtendedColorType::Rgb8)
    };
    match written {
        Ok(()) => Resized::Bytes(out),
        Err(_) => Resized::Original,
    }
}

/// The dimensions of a picture's bytes, for tests.
#[cfg(test)]
fn dimensions(data: &[u8]) -> (u32, u32) {
    ImageReader::new(Cursor::new(data)).with_guessed_format().unwrap().into_dimensions().unwrap()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn picture(format: ImageFormat, width: u32, height: u32) -> Vec<u8> {
        let img = RgbaImage::from_fn(width, height, |x, y| image::Rgba([(x * 7) as u8, (y * 5) as u8, 90, 255]));
        let mut out = Cursor::new(Vec::new());
        match format {
            ImageFormat::Jpeg => image::DynamicImage::ImageRgba8(img).to_rgb8().write_to(&mut out, format).unwrap(),
            _ => img.write_to(&mut out, format).unwrap(),
        }
        out.into_inner()
    }

    #[test]
    fn a_cover_is_fitted_as_navidrome_fits_it() {
        let jpeg = picture(ImageFormat::Jpeg, 800, 600);
        let Resized::Bytes(small) = resize(&jpeg, 300, false, 75) else { panic!("resized") };
        assert!(small.starts_with(&[0xFF, 0xD8, 0xFF]), "a JPEG stays a JPEG");
        assert_eq!(dimensions(&small), (300, 225));
        // square: centered on a transparent canvas, always PNG
        let Resized::Bytes(square) = resize(&jpeg, 300, true, 75) else { panic!("resized") };
        assert!(square.starts_with(b"\x89PNG"));
        assert_eq!(dimensions(&square), (300, 300));
        // a PNG stays a PNG; truncation as Go's int()
        let png = picture(ImageFormat::Png, 333, 100);
        let Resized::Bytes(fitted) = resize(&png, 100, false, 75) else { panic!("resized") };
        assert!(fitted.starts_with(b"\x89PNG"));
        assert_eq!(dimensions(&fitted), (100, 30));
        // never enlarged: within the size, the original
        assert_eq!(resize(&jpeg, 800, false, 75), Resized::Original);
        assert_eq!(resize(&jpeg, 2000, false, 75), Resized::Original);
        // square at a size above the picture: the picture's size
        let Resized::Bytes(clamped) = resize(&jpeg, 2000, true, 75) else { panic!("resized") };
        assert_eq!(dimensions(&clamped), (800, 800));
        // a GIF is written as JPEG
        let gif = picture(ImageFormat::Gif, 64, 64);
        let Resized::Bytes(from_gif) = resize(&gif, 32, false, 75) else { panic!("resized") };
        assert!(from_gif.starts_with(&[0xFF, 0xD8, 0xFF]));
    }

    #[test]
    fn what_navidrome_leaves_as_it_is() {
        assert_eq!(resize(b"not a picture", 100, false, 75), Resized::Original);
        assert_eq!(resize(&picture(ImageFormat::Png, 10, 1000)[..60], 100, false, 75), Resized::Original, "cut short");
        // a declared canvas over the pixel cap is never decoded
        let mut bomb = picture(ImageFormat::Png, 1, 1);
        bomb[16..24].copy_from_slice(&[0, 0, 0x40, 0, 0, 0, 0x40, 0]); // 16384 × 16384 in the IHDR
        assert_eq!(resize(&bomb, 100, false, 75), Resized::Original);
        assert!(matches!(resize(&picture(ImageFormat::Jpeg, 1000, 1), 10, false, 75), Resized::Navidromes(_)), "scaled to nothing");
        // a picture within the pixel cap whose square canvas is not: 9000 × 1 asked for as a 9000 square would be
        // 81 M pixels (324 MB); the original instead, nothing allocated
        let thin = picture(ImageFormat::Png, 9000, 1);
        assert_eq!(resize(&thin, 9000, true, 75), Resized::Original);
        assert_eq!(resize(&thin, 20_000, true, 75), Resized::Original, "the size clamped to the picture's, still too big a square");
        assert!(square_fits(8192), "8192 × 8192 is the cap itself");
        assert!(!square_fits(8193));
        assert!(!square_fits(65_535));
    }

    #[test]
    fn animations_are_found_as_navidrome_finds_them() {
        // two image descriptors after an extension block
        let mut gif = b"GIF89a\x01\x00\x01\x00\x00\x00\x00".to_vec();
        for _ in 0..2 {
            gif.extend_from_slice(b"\x21\xF9\x04\x00\x00\x00\x00\x00");
            gif.extend_from_slice(b"\x2C\x00\x00\x00\x00\x01\x00\x01\x00\x00\x02\x02\x44\x01\x00");
        }
        gif.push(0x3B);
        assert!(is_animated_gif(&gif));
        assert!(!is_animated_gif(&picture(ImageFormat::Gif, 4, 4)));
        assert!(matches!(resize(&gif, 1, false, 75), Resized::Navidromes(_)));
        assert!(is_animated_webp(b"RIFF\0\0\0\0WEBPVP8X....ANMF...."));
        assert!(!is_animated_webp(b"RIFF\0\0\0\0WEBPVP8 ...."));
        let mut apng = picture(ImageFormat::Png, 2, 2);
        assert!(!is_animated_png(&apng));
        apng.splice(33..33, *b"\0\0\0\x08acTL\0\0\0\x02\0\0\0\0CRC!");
        assert!(is_animated_png(&apng));
        assert_eq!(resize(&apng, 1, false, 75), Resized::Original);
    }
}
