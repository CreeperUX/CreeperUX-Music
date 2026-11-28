import test from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveTier,
  browserCanPlayTier,
  computeLoudnessGain,
  formatSampleRate,
  formatQualityBadge,
  isMeteredConnection,
} from '../src/api/quality.js';

test('resolveTier returns null without sonusRenditions and respects alwaysOriginal', () => {
  assert.equal(resolveTier({ setting: 'auto', metered: false, alwaysOriginal: false, autoDowngradeSteps: 0, serverHasRenditions: false }), null);
  assert.equal(resolveTier({ setting: 'normal', metered: true, alwaysOriginal: true, autoDowngradeSteps: 3, serverHasRenditions: true }), 'original');
});

test('resolveTier auto defaults and only auto-downgrades on Auto', () => {
  assert.equal(resolveTier({ setting: 'auto', metered: false, autoDowngradeSteps: 0, serverHasRenditions: true }), 'lossless');
  assert.equal(resolveTier({ setting: 'auto', metered: false, autoDowngradeSteps: 1, serverHasRenditions: true }), 'veryHigh');
  assert.equal(resolveTier({ setting: 'auto', metered: false, autoDowngradeSteps: 2, serverHasRenditions: true }), 'high');
  assert.equal(resolveTier({ setting: 'auto', metered: false, autoDowngradeSteps: 3, serverHasRenditions: true }), 'normal');

  assert.equal(resolveTier({ setting: 'auto', metered: true, autoDowngradeSteps: 0, serverHasRenditions: true }), 'high');
  assert.equal(resolveTier({ setting: 'auto', metered: true, autoDowngradeSteps: 1, serverHasRenditions: true }), 'normal');

  // Forced manual tiers never downgrade
  assert.equal(resolveTier({ setting: 'lossless', metered: true, autoDowngradeSteps: 3, serverHasRenditions: true }), 'lossless');
  assert.equal(resolveTier({ setting: 'veryHigh', metered: false, autoDowngradeSteps: 3, serverHasRenditions: true }), 'veryHigh');
});

test('browserCanPlayTier probes audio/ogg; codecs=opus (not audio/opus)', () => {
  const probed = [];
  const fakeAudio = {
    canPlayType(mime) {
      probed.push(mime);
      if (mime === 'audio/ogg; codecs=opus') return 'probably';
      if (mime === 'audio/flac') return 'probably';
      return '';
    },
  };
  assert.equal(browserCanPlayTier('high', fakeAudio), true);
  assert.equal(browserCanPlayTier('lossless', fakeAudio), true);
  assert.deepEqual(probed, ['audio/ogg; codecs=opus', 'audio/flac']);

  const noOpus = { canPlayType: () => '' };
  assert.equal(browserCanPlayTier('high', noOpus), false);
  assert.equal(browserCanPlayTier('original', noOpus), true);
});

test('computeLoudnessGain handles EBU R128, peak protection, and ReplayGain fallback', () => {
  const loud = { trackLufs: -10, trackPeak: 0.95, albumLufs: -12, albumPeak: 0.98 };
  assert.equal(computeLoudnessGain({ level: 'off', mode: 'album', loudness: loud, rgAlbum: -6, rgTrack: -5 }), 1);
  assert.ok(Math.abs(computeLoudnessGain({ level: 'normal', mode: 'album', loudness: loud }) - 10 ** (-2 / 20)) < 0.005);
  assert.ok(Math.abs(computeLoudnessGain({ level: 'normal', mode: 'track', loudness: loud }) - 10 ** (-4 / 20)) < 0.005);

  const quiet = { trackLufs: -24, trackPeak: 0.5, albumLufs: -24, albumPeak: 0.5 };
  assert.ok(Math.abs(computeLoudnessGain({ level: 'loud', mode: 'track', loudness: quiet, allowBoost: true }) - 2.0) < 0.001);
  assert.equal(computeLoudnessGain({ level: 'loud', mode: 'track', loudness: quiet, allowBoost: false }), 1.0);

  // ReplayGain fallback relative to -18 LUFS
  assert.ok(Math.abs(computeLoudnessGain({ level: 'quiet', mode: 'track', rgTrack: -6 }) - 10 ** (-6 / 20)) < 0.005);
  assert.ok(Math.abs(computeLoudnessGain({ level: 'normal', mode: 'track', rgTrack: -6 }) - 10 ** (-2 / 20)) < 0.005);
});

test('formatQualityBadge formats zh-CN and en badges from renditions and track metadata', () => {
  assert.equal(formatSampleRate(44100), '44.1 kHz');
  assert.equal(formatSampleRate(96000), '96 kHz');

  const rend = {
    sourceFormat: 'flac', sourceLossless: true, sourceSampleRate: 96000, sourceBitDepth: 24, sourceBitRate: 2900,
    renditions: [
      { tier: 'lossless', format: 'flac', sampleRate: 96000, bitDepth: 24, bitRate: 2800 },
      { tier: 'high', format: 'opus', sampleRate: 48000, bitDepth: 0, bitRate: 160 },
    ],
  };
  const bZh = formatQualityBadge({ renditions: rend, requestedTier: 'lossless', locale: 'zh-CN' });
  assert.equal(bZh.text, '无损 · 96 kHz/24 位');
  assert.equal(bZh.isLossless, true);
  assert.equal(bZh.isHiRes, true);

  const bEn = formatQualityBadge({ renditions: rend, requestedTier: 'lossless', locale: 'en' });
  assert.equal(bEn.text, 'Lossless · 96 kHz/24-bit');

  const bOpus = formatQualityBadge({ renditions: rend, requestedTier: 'high', locale: 'zh-CN' });
  assert.equal(bOpus.text, 'Opus 160');
  assert.equal(bOpus.isLossless, false);

  const dsd = { suffix: 'dsf', codec: 'DSD64', bitDepth: 1, sampleRate: 2822400, bitrate: 5644 };
  assert.equal(formatQualityBadge({ track: dsd, requestedTier: null }).text, 'Opus 320');
});

test('isMeteredConnection detects cellular and saveData', () => {
  assert.equal(isMeteredConnection({}), false);
  assert.equal(isMeteredConnection({ connection: { type: 'wifi', saveData: false } }), false);
  assert.equal(isMeteredConnection({ connection: { type: 'cellular', saveData: false } }), true);
  assert.equal(isMeteredConnection({ connection: { type: 'wifi', saveData: true } }), true);
});
