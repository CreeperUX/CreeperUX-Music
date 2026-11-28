// Pure streaming-quality, auto-downgrade, EBU R128 loudness-gain, browser codec-capability, and playback-bar badge
// helpers shared by web/src/api/subsonic.js, web/src/shell/bar.js, web/src/views/now.js, and unit tests.

export const TIER_LADDER = ['lossless', 'veryHigh', 'high', 'normal'];
export const TARGET_LUFS = { off: null, quiet: -18, normal: -14, loud: -11 };
const LOSSLESS_FORMATS = new Set(['flac', 'wav', 'alac', 'aiff', 'ape', 'wv', 'dsf', 'dff']);
const LEGACY_TRANSCODED = new Set(['dsf', 'dff', 'ape', 'wv', 'tta', 'tak', 'wma', 'mpc', 'aif', 'aiff']);

/** Detects cellular or Save-Data connections when the Network Information API is available; defaults to Wi-Fi. */
export function isMeteredConnection(nav = globalThis.navigator) {
  const c = nav?.connection;
  if (!c) return false;
  return c.type === 'cellular' || c.saveData === true;
}

/**
 * Resolves the `sonusQuality` query parameter to send on `stream`, or null when the server does not advertise
 * `sonusRenditions`. Auto-downgrade only applies when the active network's preference is `auto`.
 */
export function resolveTier({ setting = 'auto', metered = false, alwaysOriginal = false, autoDowngradeSteps = 0, serverHasRenditions = false }) {
  if (!serverHasRenditions) return null;
  if (alwaysOriginal) return 'original';
  if (setting === 'lossless' || setting === 'veryHigh' || setting === 'high' || setting === 'normal') return setting;
  const base = metered ? 2 : 0;
  const idx = Math.max(0, Math.min(TIER_LADDER.length - 1, base + Math.max(0, autoDowngradeSteps | 0)));
  return TIER_LADDER[idx];
}

/**
 * Checks whether the browser `<audio>` element can decode the container/codec used by a rendition tier.
 * Always probes `audio/ogg; codecs=opus` (Chromium returns "" for bare `audio/opus`, per docs/streaming-renditions.md §12.4).
 */
export function browserCanPlayTier(tier, audioEl) {
  if (!tier || tier === 'original') return true;
  if (!audioEl?.canPlayType) return true;
  if (tier === 'lossless') return audioEl.canPlayType('audio/flac') !== '';
  if (tier === 'veryHigh' || tier === 'high' || tier === 'normal') return audioEl.canPlayType('audio/ogg; codecs=opus') !== '';
  return true;
}

/**
 * Computes the linear amplitude multiplier for loudness normalization.
 * Uses server-measured EBU R128 loudness when available (with true-peak clipping protection), falling back to
 * ReplayGain tags referenced to -18 LUFS when EBU R128 metadata is unavailable.
 */
export function computeLoudnessGain({ level = 'off', mode = 'album', loudness = null, rgAlbum = null, rgTrack = null, allowBoost = true }) {
  const target = TARGET_LUFS[level];
  if (target == null) return 1;

  if (loudness) {
    const measured = mode === 'album' ? (loudness.albumLufs ?? loudness.trackLufs) : (loudness.trackLufs ?? loudness.albumLufs);
    const peak = mode === 'album' ? (loudness.albumPeak ?? loudness.trackPeak) : (loudness.trackPeak ?? loudness.albumPeak);
    if (typeof measured === 'number' && Number.isFinite(measured)) {
      let linear = 10 ** ((target - measured) / 20);
      if (typeof peak === 'number' && Number.isFinite(peak) && peak > 0.0001 && linear * peak > 1) {
        linear = 1 / peak;
      }
      return Math.max(0.05, Math.min(allowBoost ? 4.0 : 1.0, linear));
    }
  }

  const rg = mode === 'album' ? (rgAlbum ?? rgTrack) : (rgTrack ?? rgAlbum);
  if (typeof rg === 'number' && Number.isFinite(rg)) {
    const db = rg + (target - (-18));
    const linear = 10 ** (db / 20);
    return Math.max(0.05, Math.min(allowBoost ? 4.0 : 1.0, linear));
  }

  return 1;
}

/** Formats sample rate in kHz with minimal decimals (44100 -> "44.1 kHz", 96000 -> "96 kHz"). */
export function formatSampleRate(hz) {
  if (!hz || hz <= 0) return '';
  if (hz % 1000 === 0) return `${hz / 1000} kHz`;
  return `${Number((hz / 1000).toFixed(1))} kHz`;
}

/** Builds the concise playback-bar quality badge (e.g. "无损 · 96 kHz/24 位", "Opus 160", "MP3 320"). */
export function formatQualityBadge({ renditions = null, track = null, requestedTier = null, locale = 'zh-CN' }) {
  const en = locale === 'en';
  const build = (fmt, quality, sr, bd, br, codecHint) => {
    const f = String(fmt ?? '').trim().toLowerCase();
    const q = String(quality ?? '').trim();
    const lossless = q === 'lossless' || (bd > 0) || LOSSLESS_FORMATS.has(f);
    if (lossless) {
      const hiRes = bd > 16 || sr > 48000;
      const rate = formatSampleRate(sr);
      const bits = bd > 0 ? (en ? `${bd}-bit` : `${bd} 位`) : '';
      const detail = rate && bits ? `${rate}/${bits}` : (rate || bits);
      const label = en ? 'Lossless' : '无损';
      return { text: detail ? `${label} · ${detail}` : label, isLossless: true, isHiRes: hiRes };
    }
    if (f === 'opus') {
      const kbps = br > 0 ? br : q === 'veryHigh' ? 256 : q === 'high' ? 160 : q === 'normal' ? 96 : 0;
      return { text: kbps > 0 ? `Opus ${kbps}` : 'Opus', isLossless: false, isHiRes: false };
    }
    const codec = f === 'mp3' ? 'MP3'
      : (f === 'aac' || f === 'm4a') ? 'AAC'
        : (f === 'ogg' || f === 'oga' || f === 'vorbis') ? 'Vorbis'
          : (codecHint && codecHint !== '?') ? codecHint
            : f ? f.toUpperCase() : '';
    if (!codec) return { text: '', isLossless: false, isHiRes: false };
    return { text: br > 0 ? `${codec} ${br}` : codec, isLossless: false, isHiRes: false };
  };

  if (requestedTier && requestedTier !== 'original' && renditions) {
    const r = (renditions.renditions ?? []).find(x => String(x.tier).toLowerCase() === requestedTier.toLowerCase());
    if (r) return build(r.format, r.tier, r.sampleRate || 0, r.bitDepth || 0, r.bitRate || 0);
    if (!renditions.sourceLossless && renditions.sourceFormat) {
      return build(renditions.sourceFormat, 'original', renditions.sourceSampleRate || 0, renditions.sourceBitDepth || 0, renditions.sourceBitRate || 0);
    }
  }

  if (!track) return { text: '', isLossless: false, isHiRes: false };
  if (!requestedTier && LEGACY_TRANSCODED.has(String(track.suffix ?? '').toLowerCase())) {
    return { text: 'Opus 320', isLossless: false, isHiRes: false };
  }
  const fmt = track.suffix || track.codec || '';
  return build(fmt, track.bitDepth > 0 ? 'lossless' : 'original', track.sampleRate || 0, track.bitDepth || 0, track.bitrate || 0, track.codec);
}
