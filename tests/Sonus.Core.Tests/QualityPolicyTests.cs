using System.Net;
using System.Text;
using Sonus.Core;
using Sonus.Core.Audio;
using Xunit;

namespace Sonus.Core.Tests;

public sealed class QualityPolicyTests
{
    [Fact]
    public void ResolveTier_ReturnsNullWhenServerLacksRenditions()
    {
        Assert.Null(QualityPolicy.ResolveTier(AudioQuality.Auto, metered: false, alwaysOriginal: false, autoDowngradeSteps: 0, serverHasRenditions: false));
        Assert.Null(QualityPolicy.ResolveTier(AudioQuality.Lossless, metered: true, alwaysOriginal: true, autoDowngradeSteps: 2, serverHasRenditions: false));
    }

    [Fact]
    public void ResolveTier_AlwaysOriginalOverridesAllSettings()
    {
        Assert.Equal("original", QualityPolicy.ResolveTier(AudioQuality.Normal, metered: true, alwaysOriginal: true, autoDowngradeSteps: 3, serverHasRenditions: true));
        Assert.Equal("original", QualityPolicy.ResolveTier(AudioQuality.Auto, metered: false, alwaysOriginal: true, autoDowngradeSteps: 0, serverHasRenditions: true));
    }

    [Fact]
    public void ResolveTier_AutoDefaultsAndDowngradesOnlyWhenAuto()
    {
        // Wi-Fi Auto defaults to lossless and steps down along the ladder on slow buffering
        Assert.Equal("lossless", QualityPolicy.ResolveTier(AudioQuality.Auto, metered: false, alwaysOriginal: false, autoDowngradeSteps: 0, serverHasRenditions: true));
        Assert.Equal("veryHigh", QualityPolicy.ResolveTier(AudioQuality.Auto, metered: false, alwaysOriginal: false, autoDowngradeSteps: 1, serverHasRenditions: true));
        Assert.Equal("high", QualityPolicy.ResolveTier(AudioQuality.Auto, metered: false, alwaysOriginal: false, autoDowngradeSteps: 2, serverHasRenditions: true));
        Assert.Equal("normal", QualityPolicy.ResolveTier(AudioQuality.Auto, metered: false, alwaysOriginal: false, autoDowngradeSteps: 3, serverHasRenditions: true));
        Assert.Equal("normal", QualityPolicy.ResolveTier(AudioQuality.Auto, metered: false, alwaysOriginal: false, autoDowngradeSteps: 9, serverHasRenditions: true));

        // Cellular/metered Auto defaults to high (Opus 160) and steps down to normal (Opus 96)
        Assert.Equal("high", QualityPolicy.ResolveTier(AudioQuality.Auto, metered: true, alwaysOriginal: false, autoDowngradeSteps: 0, serverHasRenditions: true));
        Assert.Equal("normal", QualityPolicy.ResolveTier(AudioQuality.Auto, metered: true, alwaysOriginal: false, autoDowngradeSteps: 1, serverHasRenditions: true));

        // Manual forced tiers NEVER auto-downgrade
        Assert.Equal("lossless", QualityPolicy.ResolveTier(AudioQuality.Lossless, metered: true, alwaysOriginal: false, autoDowngradeSteps: 3, serverHasRenditions: true));
        Assert.Equal("veryHigh", QualityPolicy.ResolveTier(AudioQuality.VeryHigh, metered: false, alwaysOriginal: false, autoDowngradeSteps: 3, serverHasRenditions: true));
        Assert.Equal("high", QualityPolicy.ResolveTier(AudioQuality.High, metered: false, alwaysOriginal: false, autoDowngradeSteps: 3, serverHasRenditions: true));
        Assert.Equal("normal", QualityPolicy.ResolveTier(AudioQuality.Normal, metered: false, alwaysOriginal: false, autoDowngradeSteps: 3, serverHasRenditions: true));
    }

    [Fact]
    public void ComputeLoudnessGain_OffReturnsUnity()
    {
        var loud = new LoudnessInfo(-8.0, 0.99, -9.0, 0.99);
        Assert.Equal(1.0, QualityPolicy.ComputeLoudnessGain(LoudnessLevel.Off, LoudnessMode.Album, loud, -6.0, -5.0));
    }

    [Fact]
    public void ComputeLoudnessGain_UsesEbuR128AndPeakProtection()
    {
        // -10 LUFS track at Normal (-14 LUFS) => -4 dB attenuation (~0.631)
        var loud = new LoudnessInfo(TrackLufs: -10.0, TrackPeak: 0.95, AlbumLufs: -12.0, AlbumPeak: 0.98);
        double albumGain = QualityPolicy.ComputeLoudnessGain(LoudnessLevel.Normal, LoudnessMode.Album, loud, null, null);
        double trackGain = QualityPolicy.ComputeLoudnessGain(LoudnessLevel.Normal, LoudnessMode.Track, loud, null, null);
        Assert.InRange(albumGain, 0.79, 0.80); // 10^(-2/20) = 0.7943
        Assert.InRange(trackGain, 0.63, 0.635); // 10^(-4/20) = 0.6310

        // Quiet track (-24 LUFS) at Loud (-11 LUFS) wants +13 dB (4.47x), clamped by peak=0.5 => <= 2.0x
        var quiet = new LoudnessInfo(TrackLufs: -24.0, TrackPeak: 0.5, AlbumLufs: -24.0, AlbumPeak: 0.5);
        double boosted = QualityPolicy.ComputeLoudnessGain(LoudnessLevel.Loud, LoudnessMode.Track, quiet, null, null, allowBoost: true);
        Assert.Equal(2.0, boosted, 4);

        // When boost is disallowed (legacy MediaPlayer ceiling), gain never exceeds 1.0
        double noBoost = QualityPolicy.ComputeLoudnessGain(LoudnessLevel.Loud, LoudnessMode.Track, quiet, null, null, allowBoost: false);
        Assert.Equal(1.0, noBoost, 4);
    }

    [Fact]
    public void ComputeLoudnessGain_FallsBackToReplayGainRelativeToMinus18Lufs()
    {
        // ReplayGain -6 dB at Quiet (-18 LUFS) => -6 dB (~0.501)
        double quiet = QualityPolicy.ComputeLoudnessGain(LoudnessLevel.Quiet, LoudnessMode.Track, null, rgAlbum: -8.0, rgTrack: -6.0);
        Assert.InRange(quiet, 0.50, 0.503);

        // ReplayGain -6 dB at Normal (-14 LUFS) => -6 + 4 = -2 dB (~0.794)
        double normal = QualityPolicy.ComputeLoudnessGain(LoudnessLevel.Normal, LoudnessMode.Track, null, rgAlbum: -8.0, rgTrack: -6.0);
        Assert.InRange(normal, 0.79, 0.80);
    }

    [Fact]
    public void FormatBadge_FormatsHeadersRenditionsAndTrackFallbacks()
    {
        var hiResStream = new StreamMetadata("audio/flac", 50_000_000, true, Quality: "lossless", Format: "flac", SampleRate: 96000, BitDepth: 24, BitRate: 2800);
        var b1 = QualityPolicy.FormatBadge(hiResStream, null, null, "lossless");
        Assert.Equal("无损 · 96 kHz/24 位", b1.Text);
        Assert.True(b1.IsLossless);
        Assert.True(b1.IsHiRes);

        var cdStream = new StreamMetadata("audio/flac", 20_000_000, true, Quality: "lossless", Format: "flac", SampleRate: 44100, BitDepth: 16, BitRate: 900);
        var b2 = QualityPolicy.FormatBadge(cdStream, null, null, "lossless");
        Assert.Equal("无损 · 44.1 kHz/16 位", b2.Text);
        Assert.True(b2.IsLossless);
        Assert.False(b2.IsHiRes);

        var opusStream = new StreamMetadata("audio/ogg", 4_000_000, true, Quality: "high", Format: "opus", SampleRate: 48000, BitDepth: null, BitRate: 160);
        var b3 = QualityPolicy.FormatBadge(opusStream, null, null, "high");
        Assert.Equal("Opus 160", b3.Text);
        Assert.False(b3.IsLossless);

        var rend = new SongRenditions("s1", "flac", true, 96000, 24, 2900, null, [
            new RenditionInfo("veryHigh", "opus", 48000, 0, 2, 8640000, 256, 5_700_000),
        ]);
        var b4 = QualityPolicy.FormatBadge(null, rend, null, "veryHigh");
        Assert.Equal("Opus 256", b4.Text);

        var dsdTrack = new Track
        {
            Id = "d1", Title = "DSD", Artist = "A", ArtistId = "a1", Album = "Al", AlbumId = "al1", AlbumArtist = "A",
            Codec = "DSD64", Suffix = "dsf", BitDepth = 1, SampleRate = 2822400,
        };
        var b5 = QualityPolicy.FormatBadge(null, null, dsdTrack, requestedTier: null);
        Assert.Equal("MP3 320", b5.Text);
    }

    [Fact]
    public async Task SubsonicClient_StreamUrlAndGetSonusRenditions()
    {
        string json = """
        {
          "subsonic-response": {
            "status": "ok",
            "version": "1.16.1",
            "sonusRenditions": {
              "enabled": true,
              "songs": [
                {
                  "id": "s1",
                  "sourceFormat": "flac",
                  "sourceLossless": true,
                  "sourceSampleRate": 96000,
                  "sourceBitDepth": 24,
                  "sourceBitRate": 2910,
                  "loudness": { "trackLufs": -10.6, "trackPeak": 0.912, "albumLufs": -11.2, "albumPeak": 0.985 },
                  "renditions": [
                    { "tier": "lossless", "format": "flac", "sampleRate": 96000, "bitDepth": 24, "channels": 2, "totalSamples": 17280000, "bitRate": 2900, "fileSize": 65000000 },
                    { "tier": "high", "format": "opus", "sampleRate": 48000, "bitDepth": 0, "channels": 2, "totalSamples": 8640000, "bitRate": 160, "fileSize": 3600000 }
                  ]
                }
              ]
            }
          }
        }
        """;

        string? seenQuery = null;
        using var http = new HttpClient(new StubHandler(req =>
        {
            seenQuery = req.RequestUri?.Query;
            return new HttpResponseMessage(HttpStatusCode.OK)
            {
                Content = new StringContent(json, Encoding.UTF8, "application/json"),
            };
        }));

        var client = new SubsonicClient(new Login("http://127.0.0.1:4533", "u", "s", "t"), "Sonus-Test", http);
        Assert.False(client.SupportsRenditions);
        client.Extensions.Add("sonusRenditions");
        Assert.True(client.SupportsRenditions);

        string url = client.StreamUrl("s1", sonusQuality: "lossless");
        Assert.Contains("sonusQuality=lossless", url);
        Assert.DoesNotContain("maxBitRate", url);

        var map = await client.GetSonusRenditionsAsync(["s1"]);
        Assert.Contains("id=s1", seenQuery);
        Assert.True(map.TryGetValue("s1", out var s1));
        Assert.Equal(96000, s1!.SourceSampleRate);
        Assert.Equal(-10.6, s1.Loudness!.TrackLufs);
        Assert.Equal(-11.2, s1.Loudness.AlbumLufs);
        Assert.Equal(2, s1.Renditions.Count);
        Assert.Equal("opus", s1.Renditions[1].Format);
    }

    private sealed class StubHandler(Func<HttpRequestMessage, HttpResponseMessage> respond) : HttpMessageHandler
    {
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken) =>
            Task.FromResult(respond(request));
    }
}
