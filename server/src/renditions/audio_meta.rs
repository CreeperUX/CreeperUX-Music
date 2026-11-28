//! Pure Rust audio container helpers for playback renditions:
//! - FLAC frame scanning and 1-second `SEEKTABLE` injection (RFC 9639), because ffmpeg's FLAC muxer does not write a
//!   `SEEKTABLE` block;
//! - Ogg Opus header and tail-granule inspection (RFC 7845) to verify total sample count and duration;
//! - EBU R128 stderr summary parser (`ffmpeg -af ebur128=peak=true -f null -`).
//!
//! No external tools (`metaflac`, `ffprobe`) and no `unsafe` code.

use std::fs::File;
use std::io::{BufReader, BufWriter, Read, Seek, SeekFrom, Write};
use std::path::Path;

/// Metadata extracted from a verified FLAC file.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FlacMeta {
    pub sample_rate: u32,
    pub channels: u8,
    pub bits_per_sample: u8,
    pub total_samples: u64,
    pub min_frame_size: u32,
    pub max_frame_size: u32,
    pub seekpoints: usize,
    pub file_size: u64,
}

impl FlacMeta {
    pub fn duration_secs(&self) -> f64 {
        if self.sample_rate == 0 { 0.0 } else { self.total_samples as f64 / self.sample_rate as f64 }
    }
}

/// Metadata extracted from a verified Ogg Opus file.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OpusMeta {
    pub sample_rate: u32,
    pub channels: u8,
    pub pre_skip: u16,
    pub total_samples: u64,
    pub file_size: u64,
}

impl OpusMeta {
    pub fn duration_secs(&self) -> f64 {
        self.total_samples as f64 / 48_000.0
    }
}

/// Loudness measurement from ffmpeg's `ebur128=peak=true` filter.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Loudness {
    /// Integrated loudness (LUFS).
    pub lufs: f64,
    /// Linear peak amplitude (`1.0` = `0 dBFS`).
    pub peak: f64,
}

// ---------------------------------------------------------------- CRC-8 / CRC-16 (RFC 9639)

const CRC8_TABLE: [u8; 256] = {
    let mut table = [0u8; 256];
    let mut i = 0;
    while i < 256 {
        let mut crc = i as u8;
        let mut bit = 0;
        while bit < 8 {
            crc = if crc & 0x80 != 0 { (crc << 1) ^ 0x07 } else { crc << 1 };
            bit += 1;
        }
        table[i] = crc;
        i += 1;
    }
    table
};

const CRC16_TABLE: [u16; 256] = {
    let mut table = [0u16; 256];
    let mut i = 0;
    while i < 256 {
        let mut crc = (i as u16) << 8;
        let mut bit = 0;
        while bit < 8 {
            crc = if crc & 0x8000 != 0 { (crc << 1) ^ 0x8005 } else { crc << 1 };
            bit += 1;
        }
        table[i] = crc;
        i += 1;
    }
    table
};

fn crc8(bytes: &[u8]) -> u8 {
    let mut crc = 0u8;
    for &b in bytes {
        crc = CRC8_TABLE[(crc ^ b) as usize];
    }
    crc
}

#[inline]
fn crc16_step(crc: u16, byte: u8) -> u16 {
    (crc << 8) ^ CRC16_TABLE[((crc >> 8) as u8 ^ byte) as usize]
}

fn crc16(bytes: &[u8]) -> u16 {
    let mut crc = 0u16;
    for &b in bytes {
        crc = crc16_step(crc, b);
    }
    crc
}

// ---------------------------------------------------------------- FLAC frame scanner & SEEKTABLE injector

struct StreamInfo {
    raw: [u8; 34],
    min_block_size: u16,
    sample_rate: u32,
    channels: u8,
    bits_per_sample: u8,
    total_samples: u64,
}

impl StreamInfo {
    fn parse(raw: [u8; 34]) -> Result<StreamInfo, String> {
        let min_block_size = u16::from_be_bytes([raw[0], raw[1]]);
        let max_block_size = u16::from_be_bytes([raw[2], raw[3]]);
        let sample_rate = ((raw[10] as u32) << 12) | ((raw[11] as u32) << 4) | ((raw[12] as u32) >> 4);
        let channels = ((raw[12] >> 1) & 0x07) + 1;
        let bits_per_sample = (((raw[12] & 0x01) << 4) | (raw[13] >> 4)) + 1;
        let total_samples =
            (((raw[13] & 0x0F) as u64) << 32) | ((raw[14] as u64) << 24) | ((raw[15] as u64) << 16) | ((raw[16] as u64) << 8) | (raw[17] as u64);
        if sample_rate == 0 || min_block_size < 16 || max_block_size < min_block_size {
            return Err("invalid FLAC STREAMINFO".into());
        }
        Ok(StreamInfo { raw, min_block_size, sample_rate, channels, bits_per_sample, total_samples })
    }

    fn with_bounds(&self, min_frame_size: u32, max_frame_size: u32, total_samples: u64) -> [u8; 34] {
        let mut raw = self.raw;
        let min_f = min_frame_size.min(0x00FF_FFFF);
        let max_f = max_frame_size.min(0x00FF_FFFF);
        raw[4] = (min_f >> 16) as u8;
        raw[5] = (min_f >> 8) as u8;
        raw[6] = min_f as u8;
        raw[7] = (max_f >> 16) as u8;
        raw[8] = (max_f >> 8) as u8;
        raw[9] = max_f as u8;
        let ts = total_samples & 0x000F_FFFF_FFFF;
        raw[13] = (raw[13] & 0xF0) | ((ts >> 32) as u8 & 0x0F);
        raw[14] = (ts >> 24) as u8;
        raw[15] = (ts >> 16) as u8;
        raw[16] = (ts >> 8) as u8;
        raw[17] = ts as u8;
        raw
    }
}

#[derive(Debug, Clone, Copy)]
struct FrameHeader {
    header_len: usize,
    block_size: u16,
    sample_number: u64,
}

/// Decodes a FLAC UTF-8 coded integer (1..=7 bytes).
fn read_utf8_u64(data: &[u8]) -> Option<(u64, usize)> {
    let first = *data.first()?;
    if first & 0x80 == 0 {
        return Some((first as u64, 1));
    }
    let ones = first.leading_ones() as usize;
    if !(2..=7).contains(&ones) || data.len() < ones {
        return None;
    }
    let mask = if ones == 7 { 0u8 } else { (1u8 << (7 - ones)) - 1 };
    let mut val = (first & mask) as u64;
    for &b in &data[1..ones] {
        if b & 0xC0 != 0x80 {
            return None;
        }
        val = (val << 6) | (b & 0x3F) as u64;
    }
    Some((val, ones))
}

/// Parses and validates a FLAC frame header against `info`, including its CRC-8.
fn parse_frame_header(data: &[u8], info: &StreamInfo) -> Option<FrameHeader> {
    // minimum FLAC frame header: 4 fixed + 1 coded + 1 crc8 = 6 bytes
    if data.len() < 6 {
        return None;
    }
    if data[0] != 0xFF || (data[1] & 0xFE) != 0xF8 {
        return None;
    }
    let variable_block = (data[1] & 0x01) != 0;
    let bs_code = data[2] >> 4;
    let sr_code = data[2] & 0x0F;
    let ch_code = data[3] >> 4;
    let ss_code = (data[3] >> 1) & 0x07;
    if (data[3] & 0x01) != 0 || bs_code == 0 || sr_code == 15 || ss_code == 3 || ss_code == 7 || ch_code > 10 {
        return None;
    }

    let frame_channels = match ch_code {
        0..=7 => ch_code + 1,
        8..=10 => 2,
        _ => return None,
    };
    if frame_channels != info.channels {
        return None;
    }
    let frame_bps = match ss_code {
        0 => info.bits_per_sample,
        1 => 8,
        2 => 12,
        4 => 16,
        5 => 20,
        6 => 24,
        _ => return None,
    };
    if frame_bps != info.bits_per_sample {
        return None;
    }

    let (coded, coded_len) = read_utf8_u64(&data[4..])?;
    let mut pos = 4 + coded_len;

    let block_size: u16 = match bs_code {
        1 => 192,
        2..=5 => 576 << (bs_code - 2),
        6 => {
            let v = *data.get(pos)? as u16 + 1;
            pos += 1;
            v
        }
        7 => {
            let hi = *data.get(pos)? as u16;
            let lo = *data.get(pos + 1)? as u16;
            pos += 2;
            ((hi << 8) | lo).checked_add(1)?
        }
        8..=15 => 256u16.checked_shl((bs_code - 8) as u32)?,
        _ => return None,
    };

    let sample_rate: u32 = match sr_code {
        0 => info.sample_rate,
        1 => 88_200,
        2 => 176_400,
        3 => 192_000,
        4 => 8_000,
        5 => 16_000,
        6 => 22_050,
        7 => 24_000,
        8 => 32_000,
        9 => 44_100,
        10 => 48_000,
        11 => 96_000,
        12 => {
            let v = *data.get(pos)? as u32 * 1000;
            pos += 1;
            v
        }
        13 => {
            let hi = *data.get(pos)? as u32;
            let lo = *data.get(pos + 1)? as u32;
            pos += 2;
            (hi << 8) | lo
        }
        14 => {
            let hi = *data.get(pos)? as u32;
            let lo = *data.get(pos + 1)? as u32;
            pos += 2;
            ((hi << 8) | lo) * 10
        }
        _ => return None,
    };
    if sample_rate != info.sample_rate {
        return None;
    }

    let expected_crc = *data.get(pos)?;
    if crc8(&data[..pos]) != expected_crc {
        return None;
    }
    let header_len = pos + 1;
    let sample_number = if variable_block { coded } else { coded.checked_mul(info.min_block_size as u64)? };
    Some(FrameHeader { header_len, block_size, sample_number })
}

#[derive(Debug, Clone, Copy)]
struct SeekPoint {
    sample_number: u64,
    stream_offset: u64,
    frame_samples: u16,
}

/// Scans `src_flac`, builds a 1-second `SEEKTABLE` (exact `next_target += sample_rate` cadence), fills
/// `STREAMINFO` min/max frame sizes, and writes the resulting FLAC to `dst_flac`.
///
/// Uses a bounded sliding buffer so high-resolution 192 kHz/24-bit files do not stay in memory whole.
pub fn write_flac_with_seektable(src_flac: &Path, dst_flac: &Path) -> Result<FlacMeta, String> {
    let mut reader = BufReader::with_capacity(256 << 10, File::open(src_flac).map_err(|e| format!("cannot open FLAC: {e}"))?);
    let mut magic = [0u8; 4];
    reader.read_exact(&mut magic).map_err(|e| format!("cannot read FLAC header: {e}"))?;
    if &magic != b"fLaC" {
        return Err("not a FLAC file".into());
    }

    let mut stream_info: Option<StreamInfo> = None;
    let mut preserved_blocks: Vec<(u8, Vec<u8>)> = Vec::new();
    let mut is_last = false;
    while !is_last {
        let mut hdr = [0u8; 4];
        reader.read_exact(&mut hdr).map_err(|e| format!("truncated FLAC metadata header: {e}"))?;
        is_last = (hdr[0] & 0x80) != 0;
        let block_type = hdr[0] & 0x7F;
        let len = ((hdr[1] as usize) << 16) | ((hdr[2] as usize) << 8) | (hdr[3] as usize);
        if block_type == 0 {
            if len != 34 {
                return Err(format!("unexpected STREAMINFO length {len}"));
            }
            let mut raw = [0u8; 34];
            reader.read_exact(&mut raw).map_err(|e| format!("truncated STREAMINFO: {e}"))?;
            stream_info = Some(StreamInfo::parse(raw)?);
        } else if block_type == 3 || block_type == 1 {
            // drop existing SEEKTABLE (rebuilt below) and PADDING (keep renditions compact)
            reader.seek(SeekFrom::Current(len as i64)).map_err(|e| format!("cannot skip FLAC metadata: {e}"))?;
        } else if len <= (16 << 20) {
            let mut body = vec![0u8; len];
            reader.read_exact(&mut body).map_err(|e| format!("truncated FLAC metadata block: {e}"))?;
            preserved_blocks.push((block_type, body));
        } else {
            reader.seek(SeekFrom::Current(len as i64)).map_err(|e| format!("cannot skip oversized FLAC metadata: {e}"))?;
        }
    }

    let info = stream_info.ok_or("FLAC has no STREAMINFO block")?;
    let audio_offset = reader.stream_position().map_err(|e| format!("cannot read FLAC position: {e}"))?;
    let total_file_len = reader.get_ref().metadata().map_err(|e| format!("cannot stat FLAC: {e}"))?.len();
    if audio_offset >= total_file_len {
        return Err("FLAC has no audio frames".into());
    }

    let (seekpoints, min_frame_size, max_frame_size, scanned_samples) = scan_flac_frames(&mut reader, &info, audio_offset, total_file_len)?;
    let total_samples = if info.total_samples > 0 { info.total_samples } else { scanned_samples };
    if total_samples == 0 {
        return Err("FLAC decoded zero samples".into());
    }
    if info.total_samples > 0 && scanned_samples != info.total_samples {
        return Err(format!("FLAC sample count mismatch: header={} frames={}", info.total_samples, scanned_samples));
    }

    let updated_info = info.with_bounds(min_frame_size, max_frame_size, total_samples);
    let mut seektable_bytes = Vec::with_capacity(seekpoints.len() * 18);
    for sp in &seekpoints {
        seektable_bytes.extend_from_slice(&sp.sample_number.to_be_bytes());
        seektable_bytes.extend_from_slice(&sp.stream_offset.to_be_bytes());
        seektable_bytes.extend_from_slice(&sp.frame_samples.to_be_bytes());
    }

    let out_file = File::create(dst_flac).map_err(|e| format!("cannot create FLAC output: {e}"))?;
    let mut writer = BufWriter::with_capacity(256 << 10, out_file);
    writer.write_all(b"fLaC").map_err(|e| format!("cannot write FLAC magic: {e}"))?;

    // Order: STREAMINFO (0), SEEKTABLE (3), preserved blocks (e.g. VORBIS_COMMENT)
    let has_seektable = !seektable_bytes.is_empty();
    let si_last = !has_seektable && preserved_blocks.is_empty();
    write_metadata_block(&mut writer, 0, si_last, &updated_info)?;
    if has_seektable {
        write_metadata_block(&mut writer, 3, preserved_blocks.is_empty(), &seektable_bytes)?;
    }
    let last_idx = preserved_blocks.len().saturating_sub(1);
    for (idx, (block_type, body)) in preserved_blocks.iter().enumerate() {
        write_metadata_block(&mut writer, *block_type, idx == last_idx, body)?;
    }

    // Stream original audio frames verbatim
    reader.seek(SeekFrom::Start(audio_offset)).map_err(|e| format!("cannot rewind FLAC audio: {e}"))?;
    std::io::copy(&mut reader, &mut writer).map_err(|e| format!("cannot copy FLAC audio frames: {e}"))?;
    writer.flush().map_err(|e| format!("cannot flush FLAC output: {e}"))?;
    let out_file = writer.into_inner().map_err(|e| format!("cannot finalize FLAC output: {e}"))?;
    out_file.sync_all().map_err(|e| format!("cannot sync FLAC output: {e}"))?;
    let file_size = out_file.metadata().map_err(|e| format!("cannot stat FLAC output: {e}"))?.len();

    Ok(FlacMeta {
        sample_rate: info.sample_rate,
        channels: info.channels,
        bits_per_sample: info.bits_per_sample,
        total_samples,
        min_frame_size,
        max_frame_size,
        seekpoints: seekpoints.len(),
        file_size,
    })
}

fn write_metadata_block(writer: &mut impl Write, block_type: u8, is_last: bool, body: &[u8]) -> Result<(), String> {
    if body.len() > 0x00FF_FFFF {
        return Err(format!("FLAC metadata block type {block_type} exceeds 16 MiB"));
    }
    let len = body.len() as u32;
    let hdr = [(if is_last { 0x80 } else { 0x00 }) | (block_type & 0x7F), ((len >> 16) & 0xFF) as u8, ((len >> 8) & 0xFF) as u8, (len & 0xFF) as u8];
    writer.write_all(&hdr).map_err(|e| format!("cannot write FLAC block header: {e}"))?;
    writer.write_all(body).map_err(|e| format!("cannot write FLAC block body: {e}"))?;
    Ok(())
}

/// Scans every frame from `audio_offset` to `total_file_len`, validating frame header CRC-8, sequential sample
/// numbers, and frame footer CRC-16, and collecting 1-second seekpoints.
fn scan_flac_frames(
    reader: &mut BufReader<File>,
    info: &StreamInfo,
    audio_offset: u64,
    total_file_len: u64,
) -> Result<(Vec<SeekPoint>, u32, u32, u64), String> {
    const READ_CHUNK: usize = 256 << 10;
    const MAX_HEADER: usize = 16;

    let mut buf: Vec<u8> = Vec::with_capacity(READ_CHUNK * 2);
    let mut buf_file_offset = audio_offset;
    let mut eof = false;

    let refill = |reader: &mut BufReader<File>, buf: &mut Vec<u8>, eof: &mut bool| -> Result<(), String> {
        if *eof {
            return Ok(());
        }
        let mut tmp = [0u8; READ_CHUNK];
        while buf.len() < READ_CHUNK {
            let n = reader.read(&mut tmp).map_err(|e| format!("cannot read FLAC frames: {e}"))?;
            if n == 0 {
                *eof = true;
                break;
            }
            buf.extend_from_slice(&tmp[..n]);
        }
        Ok(())
    };

    refill(reader, &mut buf, &mut eof)?;
    let mut cur = parse_frame_header(&buf, info).ok_or("first FLAC frame header is invalid")?;
    if cur.sample_number != 0 {
        return Err(format!("first FLAC frame starts at sample {}, expected 0", cur.sample_number));
    }

    let mut frame_start_abs = audio_offset;
    let mut running_crc = crc16(&buf[..cur.header_len]);
    // `scan` is the index inside `buf` of the candidate *next* frame start.
    // The 2 bytes before `scan` (`scan-2`, `scan-1`) are the candidate CRC-16 footer of the current frame,
    // so `running_crc` always lags `scan` by 2 bytes once `scan >= cur.header_len + 2`.
    let mut scan = cur.header_len + 2;
    let mut seekpoints: Vec<SeekPoint> = Vec::new();
    let mut next_target: u64 = 0;
    let step = info.sample_rate as u64;
    let mut min_frame_size = u32::MAX;
    let mut max_frame_size = 0u32;

    loop {
        if !eof && buf.len().saturating_sub(scan) < MAX_HEADER + 4 {
            // Keep bytes from `scan - 2` onward so candidate CRC-16 footer stays available
            let drop_prefix = scan.saturating_sub(2);
            if drop_prefix > 0 {
                buf.drain(..drop_prefix);
                buf_file_offset += drop_prefix as u64;
                scan -= drop_prefix;
            }
            refill(reader, &mut buf, &mut eof)?;
        }

        if scan >= buf.len() {
            break;
        }

        // Check if `scan` starts the next valid FLAC frame
        if scan + 6 <= buf.len() && buf[scan] == 0xFF && (buf[scan + 1] & 0xFE) == 0xF8 {
            let stored_crc = u16::from_be_bytes([buf[scan - 2], buf[scan - 1]]);
            if running_crc == stored_crc {
                if let Some(next_hdr) = parse_frame_header(&buf[scan..], info) {
                    let expected_sample = cur.sample_number + cur.block_size as u64;
                    if next_hdr.sample_number == expected_sample {
                        let next_start_abs = buf_file_offset + scan as u64;
                        let frame_len = (next_start_abs - frame_start_abs) as u32;
                        min_frame_size = min_frame_size.min(frame_len);
                        max_frame_size = max_frame_size.max(frame_len);
                        if cur.sample_number >= next_target {
                            seekpoints.push(SeekPoint {
                                sample_number: cur.sample_number,
                                stream_offset: frame_start_abs - audio_offset,
                                frame_samples: cur.block_size,
                            });
                            while next_target <= cur.sample_number {
                                next_target += step;
                            }
                        }

                        cur = next_hdr;
                        frame_start_abs = next_start_abs;
                        if scan + cur.header_len + 2 > buf.len() && !eof {
                            let drop_prefix = scan;
                            buf.drain(..drop_prefix);
                            buf_file_offset += drop_prefix as u64;
                            scan = 0;
                            refill(reader, &mut buf, &mut eof)?;
                        }
                        if scan + cur.header_len > buf.len() {
                            return Err("truncated FLAC frame header".into());
                        }
                        running_crc = crc16(&buf[scan..scan + cur.header_len]);
                        scan += cur.header_len + 2;
                        continue;
                    }
                }
            }
        }

        // Not a frame boundary: feed byte `scan - 2` into running CRC-16 and advance
        running_crc = crc16_step(running_crc, buf[scan - 2]);
        scan += 1;
    }

    // Validate final frame's CRC-16 at EOF
    if buf.len() < 2 || buf_file_offset + buf.len() as u64 != total_file_len {
        return Err("truncated final FLAC frame".into());
    }
    let stored_crc = u16::from_be_bytes([buf[buf.len() - 2], buf[buf.len() - 1]]);
    if running_crc != stored_crc {
        return Err("final FLAC frame CRC-16 mismatch".into());
    }
    let final_frame_len = (total_file_len - frame_start_abs) as u32;
    min_frame_size = min_frame_size.min(final_frame_len);
    max_frame_size = max_frame_size.max(final_frame_len);
    if cur.sample_number >= next_target {
        seekpoints.push(SeekPoint { sample_number: cur.sample_number, stream_offset: frame_start_abs - audio_offset, frame_samples: cur.block_size });
    }
    let scanned_samples = cur.sample_number + cur.block_size as u64;
    Ok((seekpoints, min_frame_size, max_frame_size, scanned_samples))
}

// ---------------------------------------------------------------- Ogg Opus inspector (RFC 7845)

/// Inspects an Ogg Opus file's `OpusHead` and final page granule position to confirm validity and exact duration.
pub fn inspect_ogg_opus(path: &Path) -> Result<OpusMeta, String> {
    let mut file = File::open(path).map_err(|e| format!("cannot open Ogg Opus: {e}"))?;
    let file_size = file.metadata().map_err(|e| format!("cannot stat Ogg Opus: {e}"))?.len();
    if file_size < 47 {
        return Err("Ogg Opus file is too small".into());
    }

    // Page 0: OggS header (27 bytes) + segment table + OpusHead (19+ bytes)
    let head_len = (file_size as usize).min(4096);
    let mut head = vec![0u8; head_len];
    file.read_exact(&mut head).map_err(|e| format!("cannot read Ogg Opus header: {e}"))?;
    if &head[0..4] != b"OggS" || head[4] != 0 {
        return Err("not an Ogg stream".into());
    }
    let serial = u32::from_le_bytes([head[14], head[15], head[16], head[17]]);
    let seg_count = head[26] as usize;
    let payload_start = 27 + seg_count;
    if payload_start + 19 > head.len() {
        return Err("truncated Ogg Opus head page".into());
    }
    let opus = &head[payload_start..];
    if &opus[0..8] != b"OpusHead" {
        return Err("first Ogg packet is not OpusHead".into());
    }
    let version = opus[8];
    if (version & 0xF0) != 0 {
        return Err(format!("unsupported OpusHead version {version}"));
    }
    let channels = opus[9];
    if channels == 0 {
        return Err("OpusHead reports 0 channels".into());
    }
    let pre_skip = u16::from_le_bytes([opus[10], opus[11]]);

    // Tail scan (last 64 KiB covers any valid Ogg page, max size 65307 bytes)
    let tail_len = (file_size as usize).min(65_536 * 2);
    file.seek(SeekFrom::Start(file_size - tail_len as u64)).map_err(|e| format!("cannot seek Ogg Opus tail: {e}"))?;
    let mut tail = vec![0u8; tail_len];
    file.read_exact(&mut tail).map_err(|e| format!("cannot read Ogg Opus tail: {e}"))?;

    let mut max_granule: Option<u64> = None;
    let mut i = 0;
    while i + 27 <= tail.len() {
        if &tail[i..i + 4] == b"OggS" && tail[i + 4] == 0 {
            let page_serial = u32::from_le_bytes([tail[i + 14], tail[i + 15], tail[i + 16], tail[i + 17]]);
            let segs = tail[i + 26] as usize;
            if page_serial == serial && i + 27 + segs <= tail.len() {
                let body_len: usize = tail[i + 27..i + 27 + segs].iter().map(|&s| s as usize).sum();
                if i + 27 + segs + body_len <= tail.len() {
                    let granule =
                        u64::from_le_bytes([tail[i + 6], tail[i + 7], tail[i + 8], tail[i + 9], tail[i + 10], tail[i + 11], tail[i + 12], tail[i + 13]]);
                    if granule != u64::MAX {
                        max_granule = Some(max_granule.map_or(granule, |m| m.max(granule)));
                    }
                    i += 27 + segs + body_len;
                    continue;
                }
            }
        }
        i += 1;
    }

    let granule = max_granule.ok_or("Ogg Opus tail has no valid granule position")?;
    let total_samples = granule.saturating_sub(pre_skip as u64);
    if total_samples == 0 {
        return Err("Ogg Opus contains zero samples".into());
    }

    Ok(OpusMeta { sample_rate: 48_000, channels, pre_skip, total_samples, file_size })
}

// ---------------------------------------------------------------- EBU R128 parser

/// Parses `Summary:` output from `ffmpeg -af ebur128=peak=true -f null -`:
/// ```text
///   Integrated loudness:
///     I:         -10.8 LUFS
///     Threshold: -20.8 LUFS
///   ...
///   True peak:
///     Peak:       -0.4 dBFS
/// ```
pub fn parse_ebur128(stderr: &str) -> Option<Loudness> {
    let summary = stderr.rfind("Summary:").map(|idx| &stderr[idx..]).unwrap_or(stderr);
    let mut lufs: Option<f64> = None;
    let mut peak_dbfs: Option<f64> = None;
    let mut in_integrated = false;
    let mut in_peak = false;
    for line in summary.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with("Integrated loudness:") {
            in_integrated = true;
            in_peak = false;
            continue;
        }
        if trimmed.starts_with("True peak:") || trimmed.starts_with("Sample peak:") {
            in_integrated = false;
            in_peak = true;
            continue;
        }
        if trimmed.starts_with("Loudness range:") {
            in_integrated = false;
            in_peak = false;
            continue;
        }
        if in_integrated {
            if let Some(rest) = trimmed.strip_prefix("I:") {
                if let Some(val) = rest.split_whitespace().next().and_then(|s| s.parse::<f64>().ok()) {
                    if val.is_finite() {
                        lufs = Some(val);
                    }
                }
            }
        }
        if in_peak {
            if let Some(rest) = trimmed.strip_prefix("Peak:") {
                if let Some(val) = rest.split_whitespace().next().and_then(|s| s.parse::<f64>().ok()) {
                    if val.is_finite() {
                        peak_dbfs = Some(val);
                    }
                }
            }
        }
    }
    let lufs = lufs?;
    let peak = match peak_dbfs {
        Some(db) if db.is_finite() => 10f64.powf(db / 20.0),
        _ => 1.0,
    };
    Some(Loudness { lufs, peak })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Builds a minimal valid 1-channel 16-bit constant-subframe FLAC file in memory (RFC 9639) for testing.
    fn make_synthetic_flac(sample_rate: u32, block_size: u16, frames: usize) -> Vec<u8> {
        let total_samples = (frames as u64) * (block_size as u64);
        let mut out = Vec::new();
        out.extend_from_slice(b"fLaC");
        // STREAMINFO (last block = 1, type = 0, len = 34)
        out.extend_from_slice(&[0x80, 0x00, 0x00, 34]);
        let mut si = [0u8; 34];
        si[0..2].copy_from_slice(&block_size.to_be_bytes());
        si[2..4].copy_from_slice(&block_size.to_be_bytes());
        si[10] = ((sample_rate >> 12) & 0xFF) as u8;
        si[11] = ((sample_rate >> 4) & 0xFF) as u8;
        si[12] = ((sample_rate & 0x0F) << 4) as u8; // 1 ch (0), bps=16 (15 -> hi bit 0)
        si[13] = (0x0F << 4) | (((total_samples >> 32) & 0x0F) as u8);
        si[14..18].copy_from_slice(&(total_samples as u32).to_be_bytes());
        out.extend_from_slice(&si);

        for f in 0..frames {
            let start = out.len();
            // Frame header: fixed blocksize (0xFF 0xF8), bs_code=7 (16-bit bs-1), sr_code=0 (from STREAMINFO)
            // ch_code=0 (1 ch), ss_code=4 (16-bit), reserved=0
            out.push(0xFF);
            out.push(0xF8);
            out.push(0x70);
            out.push(0x08);
            // UTF-8 coded frame number (supports < 128 directly, else 2-byte)
            if f < 0x80 {
                out.push(f as u8);
            } else {
                out.push(0xC0 | ((f >> 6) as u8));
                out.push(0x80 | ((f & 0x3F) as u8));
            }
            out.extend_from_slice(&(block_size - 1).to_be_bytes());
            let h_crc = crc8(&out[start..]);
            out.push(h_crc);
            // Subframe: constant (type=0, wasted=0 -> 0x00), 16-bit sample value
            out.push(0x00);
            out.extend_from_slice(&(f as i16).to_be_bytes());
            let f_crc = crc16(&out[start..]);
            out.extend_from_slice(&f_crc.to_be_bytes());
        }
        out
    }

    #[test]
    fn flac_seektable_is_injected_at_one_second_cadence() {
        let dir = std::env::temp_dir().join(format!("sonus-audio-meta-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let src = dir.join("in.flac");
        let dst = dir.join("out.flac");
        // 48 kHz, 4096 samples/frame, 37 frames (last frame starts at 36*4096 = 147456 >= 3*48000) -> 4 seekpoints (0s, 1s, 2s, 3s)
        let bytes = make_synthetic_flac(48_000, 4096, 37);
        std::fs::write(&src, &bytes).unwrap();

        let meta = write_flac_with_seektable(&src, &dst).unwrap();
        assert_eq!(meta.sample_rate, 48_000);
        assert_eq!(meta.channels, 1);
        assert_eq!(meta.bits_per_sample, 16);
        assert_eq!(meta.total_samples, 37 * 4096);
        assert_eq!(meta.seekpoints, 4);
        assert!(meta.min_frame_size > 0 && meta.max_frame_size >= meta.min_frame_size);

        // Verify output starts with fLaC, STREAMINFO (not last), SEEKTABLE (last, type 3, 4*18=72 bytes)
        let out = std::fs::read(&dst).unwrap();
        assert_eq!(&out[0..4], b"fLaC");
        assert_eq!(out[4], 0x00, "STREAMINFO is not last");
        assert_eq!(out[4 + 4 + 34], 0x83, "SEEKTABLE is type 3 and last");
        let st_len = ((out[4 + 4 + 35] as usize) << 16) | ((out[4 + 4 + 36] as usize) << 8) | (out[4 + 4 + 37] as usize);
        assert_eq!(st_len, 4 * 18);
        // Re-running on output replaces SEEKTABLE identically (idempotent)
        let dst2 = dir.join("out2.flac");
        let meta2 = write_flac_with_seektable(&dst, &dst2).unwrap();
        assert_eq!(meta2, meta);
        assert_eq!(std::fs::read(&dst2).unwrap(), out);

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn ogg_opus_head_and_granule_are_parsed() {
        let dir = std::env::temp_dir().join(format!("sonus-opus-meta-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("test.ogg");

        let mut data = Vec::new();
        // Page 0: OpusHead (pre_skip = 312, channels = 2)
        let mut head_pkt = Vec::new();
        head_pkt.extend_from_slice(b"OpusHead");
        head_pkt.push(1); // version
        head_pkt.push(2); // channels
        head_pkt.extend_from_slice(&312u16.to_le_bytes());
        head_pkt.extend_from_slice(&48_000u32.to_le_bytes());
        head_pkt.extend_from_slice(&0i16.to_le_bytes());
        head_pkt.push(0);
        append_ogg_page(&mut data, 0x02, 0, 0x12345678, 0, &head_pkt);
        // Page 1: audio ending at granule 48000*10 + 312 (exact 10.0 s)
        append_ogg_page(&mut data, 0x04, 480_312, 0x12345678, 1, &[0xF8, 0xFF, 0xFE]);

        std::fs::write(&path, &data).unwrap();
        let meta = inspect_ogg_opus(&path).unwrap();
        assert_eq!(meta.channels, 2);
        assert_eq!(meta.pre_skip, 312);
        assert_eq!(meta.total_samples, 480_000);
        assert!((meta.duration_secs() - 10.0).abs() < 1e-6);

        let _ = std::fs::remove_dir_all(&dir);
    }

    fn append_ogg_page(out: &mut Vec<u8>, flags: u8, granule: u64, serial: u32, seq: u32, body: &[u8]) {
        out.extend_from_slice(b"OggS");
        out.push(0);
        out.push(flags);
        out.extend_from_slice(&granule.to_le_bytes());
        out.extend_from_slice(&serial.to_le_bytes());
        out.extend_from_slice(&seq.to_le_bytes());
        out.extend_from_slice(&0u32.to_le_bytes()); // crc unused by inspector
        out.push(1);
        out.push(body.len() as u8);
        out.extend_from_slice(body);
    }

    #[test]
    fn ebur128_summary_is_parsed() {
        let stderr = "\
[Parsed_ebur128_0 @ 0x1] t: 179.9 TARGET:-23 LUFS M:-10.7 S:-10.7 I: -10.8 LUFS LRA: 0.0 LU TPK: -0.4 -0.4 dBFS
[Parsed_ebur128_0 @ 0x1] Summary:

  Integrated loudness:
    I:         -10.8 LUFS
    Threshold: -20.8 LUFS

  Loudness range:
    LRA:         0.2 LU
    Threshold: -30.8 LUFS
    LRA low:   -10.9 LUFS
    LRA high:  -10.7 LUFS

  True peak:
    Peak:       -6.0 dBFS
";
        let m = parse_ebur128(stderr).unwrap();
        assert!((m.lufs - (-10.8)).abs() < 1e-6);
        assert!((m.peak - 10f64.powf(-6.0 / 20.0)).abs() < 1e-6);
    }
}
