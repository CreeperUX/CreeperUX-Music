//! Authenticator codes as the apps make them (RFC 6238 TOTP): HMAC-SHA1 over 30-second steps, 6 digits. The fork's
//! `core/twofactor/totp.go` and `qr.go`.
//!
//! Ported from the CreeperUX fork of Navidrome (GPL-3.0).

use base64::Engine;
use hmac::{Hmac, KeyInit, Mac};
use sha1::Sha1;
use subtle::ConstantTimeEq;

/// Names the account in authenticator apps.
pub const ISSUER: &str = "Sonus";

const PERIOD: i64 = 30;
const DIGITS: usize = 6;
/// Steps either side of now that are accepted too: the phone's clock and the server's drift apart.
const SKEW: i64 = 1;

const BASE32: &[u8; 32] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

fn base32_encode(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len().div_ceil(5) * 8);
    let (mut buffer, mut bits) = (0u32, 0u32);
    for byte in bytes {
        buffer = buffer << 8 | *byte as u32;
        bits += 8;
        while bits >= 5 {
            bits -= 5;
            out.push(BASE32[(buffer >> bits & 31) as usize] as char);
        }
    }
    if bits > 0 {
        out.push(BASE32[(buffer << (5 - bits) & 31) as usize] as char);
    }
    out
}

/// Base32 without padding, in any case (the fork decodes `strings.ToUpper(secret)`).
fn base32_decode(text: &str) -> Option<Vec<u8>> {
    let mut out = Vec::with_capacity(text.len() * 5 / 8);
    let (mut buffer, mut bits) = (0u32, 0u32);
    for c in text.bytes() {
        let value = BASE32.iter().position(|b| *b == c.to_ascii_uppercase())? as u32;
        buffer = buffer << 5 | value;
        bits += 5;
        if bits >= 8 {
            bits -= 8;
            out.push((buffer >> bits) as u8);
        }
    }
    // what is left must be padding bits, all zero, and a length base32 can have
    if buffer & ((1 << bits) - 1) != 0 || matches!(text.len() % 8, 1 | 3 | 6) {
        return None;
    }
    Some(out)
}

/// A new authenticator secret, base32 as the apps take it (160 bits, RFC 4226's recommendation).
pub fn new_secret() -> Result<String, getrandom::Error> {
    let mut bytes = [0u8; 20];
    getrandom::fill(&mut bytes)?;
    Ok(base32_encode(&bytes))
}

/// The code for one time step.
fn code_at(key: &[u8], step: i64) -> String {
    let mut mac = <Hmac<Sha1> as KeyInit>::new_from_slice(key).expect("HMAC takes a key of any length");
    mac.update(&(step as u64).to_be_bytes());
    let sum = mac.finalize().into_bytes();
    let offset = (sum[sum.len() - 1] & 0x0f) as usize;
    let value = u32::from_be_bytes([sum[offset], sum[offset + 1], sum[offset + 2], sum[offset + 3]]) & 0x7fff_ffff;
    format!("{:0width$}", value % 1_000_000, width = DIGITS)
}

/// The code an authenticator app shows for the secret at `unix` seconds. None: the secret is not base32.
pub fn code(secret: &str, unix: i64) -> Option<String> {
    Some(code_at(&base32_decode(secret)?, unix.div_euclid(PERIOD)))
}

/// What people type around the digits is dropped ("123 456").
pub fn normalize(code: &str) -> String {
    code.trim().chars().filter(|c| *c != ' ' && *c != '-').collect()
}

/// The time step the code belongs to, now or one step either side; None when it belongs to none.
pub fn match_step(secret: &str, code: &str, unix: i64) -> Option<i64> {
    let code = normalize(code);
    if code.len() != DIGITS {
        return None;
    }
    let key = base32_decode(secret)?;
    let current = unix.div_euclid(PERIOD);
    (-SKEW..=SKEW).map(|d| current + d).find(|step| bool::from(code_at(&key, *step).as_bytes().ct_eq(code.as_bytes())))
}

/// The `otpauth://` link a QR code carries to an authenticator app, as the fork's `URI` writes it (Go's
/// `url.PathEscape` and `url.Values.Encode`, its parameters in alphabetical order).
pub fn uri(issuer: &str, account: &str, secret: &str) -> String {
    format!(
        "otpauth://totp/{}?algorithm=SHA1&digits={DIGITS}&issuer={}&period={PERIOD}&secret={}",
        path_escape(&format!("{issuer}:{account}")),
        query_escape(issuer),
        query_escape(secret)
    )
}

fn escape(text: &str, keep: &[u8], space: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for byte in text.bytes() {
        if byte.is_ascii_alphanumeric() || b"-_.~".contains(&byte) || keep.contains(&byte) {
            out.push(byte as char);
        } else if byte == b' ' {
            out.push_str(space);
        } else {
            out.push_str(&format!("%{byte:02X}"));
        }
    }
    out
}

/// Go's `url.PathEscape`: a path segment, where `$&+=:@` stay as they are.
fn path_escape(text: &str) -> String {
    escape(text, b"$&+=:@", "%20")
}

/// Go's `url.QueryEscape`.
fn query_escape(text: &str) -> String {
    escape(text, b"", "+")
}

/// The link as a QR code for authenticator apps to scan: a PNG in a `data:` URL (the fork draws level M, six pixels a
/// module, with the quiet zone around it; the pixels are not Go's byte for byte, the code they carry is).
pub fn qr_code(uri: &str) -> Result<String, String> {
    const SCALE: usize = 6;
    const QUIET: usize = 4;
    let code = qrcode::QrCode::with_error_correction_level(uri.as_bytes(), qrcode::EcLevel::M).map_err(|e| e.to_string())?;
    let modules = code.width();
    let colors = code.to_colors();
    let size = (modules + 2 * QUIET) * SCALE;
    // one bit a pixel, 1 is white; rows are padded to whole bytes
    let stride = size.div_ceil(8);
    let mut pixels = vec![0xffu8; stride * size];
    for (index, color) in colors.iter().enumerate() {
        if *color != qrcode::Color::Dark {
            continue;
        }
        let (x0, y0) = ((index % modules + QUIET) * SCALE, (index / modules + QUIET) * SCALE);
        for y in y0..y0 + SCALE {
            for x in x0..x0 + SCALE {
                pixels[y * stride + x / 8] &= !(0x80 >> (x % 8));
            }
        }
    }
    let mut file = Vec::new();
    {
        let mut encoder = png::Encoder::new(&mut file, size as u32, size as u32);
        encoder.set_color(png::ColorType::Grayscale);
        encoder.set_depth(png::BitDepth::One);
        let mut writer = encoder.write_header().map_err(|e| e.to_string())?;
        writer.write_image_data(&pixels).map_err(|e| e.to_string())?;
    }
    Ok(format!("data:image/png;base64,{}", base64::engine::general_purpose::STANDARD.encode(file)))
}

#[cfg(test)]
mod tests {
    use super::*;

    // RFC 6238, appendix B: the SHA-1 secret "12345678901234567890", its 8-digit codes cut to the 6 apps show
    fn rfc_secret() -> String {
        base32_encode(b"12345678901234567890")
    }

    #[test]
    fn codes_match_the_rfcs_test_vectors() {
        let secret = rfc_secret();
        assert_eq!(secret, "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ");
        for (unix, want) in
            [(59, "287082"), (1111111109, "081804"), (1111111111, "050471"), (1234567890, "005924"), (2000000000, "279037"), (20000000000, "353130")]
        {
            assert_eq!(code(&secret, unix).as_deref(), Some(want), "{unix}");
        }
        assert_eq!(code(&secret.to_lowercase(), 59).as_deref(), Some("287082"), "the secret in any case");
        assert_eq!(code("not base32!", 59), None);
    }

    #[test]
    fn the_step_before_and_after_now_are_accepted_not_two_away() {
        let (secret, now) = (rfc_secret(), 1_800_000_000);
        for (offset, ok) in [(-60, false), (-30, true), (0, true), (30, true), (60, false)] {
            let c = code(&secret, now + offset).unwrap();
            assert_eq!(match_step(&secret, &c, now).is_some(), ok, "{offset}");
        }
        let c = code(&secret, now + 30).unwrap();
        assert_eq!(match_step(&secret, &c, now), Some(now / 30 + 1), "the step it belongs to");
    }

    #[test]
    fn digits_are_taken_as_people_type_them() {
        let (secret, now) = (rfc_secret(), 1_800_000_000);
        let c = code(&secret, now).unwrap();
        assert!(match_step(&secret, &format!("{} {}", &c[..3], &c[3..]), now).is_some());
        assert!(match_step(&secret, &format!(" {}-{} ", &c[..3], &c[3..]), now).is_some());
        assert_eq!(match_step(&secret, "12345", now), None);
        assert_eq!(match_step(&secret, "abcdef", now), None);
        assert_eq!(match_step(&secret, "", now), None);
        assert_eq!(match_step("not base32!", &c, now), None);
    }

    #[test]
    fn base32_round_trips_and_refuses_what_is_not_base32() {
        for bytes in [&b""[..], b"f", b"fo", b"foo", b"foob", b"fooba", b"foobar"] {
            assert_eq!(base32_decode(&base32_encode(bytes)).as_deref(), Some(bytes));
        }
        assert_eq!(base32_encode(b"foobar"), "MZXW6YTBOI", "RFC 4648, without padding");
        assert_eq!(base32_decode("MZXW6YTBOI======"), None, "no padding, as the fork decodes");
        assert_eq!(base32_decode("M"), None);
        assert_eq!(base32_decode("MZ1"), None);
        let secret = new_secret().unwrap();
        assert_eq!((secret.len(), base32_decode(&secret).map(|b| b.len())), (32, Some(20)));
    }

    #[test]
    fn the_link_is_what_authenticator_apps_read() {
        assert_eq!(uri("Sonus", "alice", "ABC"), "otpauth://totp/Sonus:alice?algorithm=SHA1&digits=6&issuer=Sonus&period=30&secret=ABC");
        // Go: URI("Sonus", "林 夕/雨", "ABC")
        assert_eq!(
            uri("Sonus", "林 夕/雨", "ABC"),
            "otpauth://totp/Sonus:%E6%9E%97%20%E5%A4%95%2F%E9%9B%A8?algorithm=SHA1&digits=6&issuer=Sonus&period=30&secret=ABC"
        );
    }

    #[test]
    fn the_qr_code_is_a_png_of_the_link() {
        let image = qr_code(&uri("Sonus", "alice", &rfc_secret())).unwrap();
        let data = image.strip_prefix("data:image/png;base64,").expect("a data: URL");
        let file = base64::engine::general_purpose::STANDARD.decode(data).unwrap();
        assert_eq!(&file[..8], b"\x89PNG\r\n\x1a\n");
        // square, six pixels a module with four modules of quiet zone around
        let width = u32::from_be_bytes([file[16], file[17], file[18], file[19]]);
        let height = u32::from_be_bytes([file[20], file[21], file[22], file[23]]);
        assert_eq!(width, height);
        assert_eq!(width % 6, 0);
        assert!(((21 + 8) * 6..=(177 + 8) * 6).contains(&width));
        assert!(file.len() < 8192, "small enough for a JSON answer: {}", file.len());
    }
}
