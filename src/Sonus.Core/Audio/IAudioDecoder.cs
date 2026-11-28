namespace Sonus.Core.Audio;

/// <summary>Which playback backend Windows uses.</summary>
public enum AudioCore
{
    /// <summary>Built-in pure C# decoders (FLAC, Opus, WAV, MP3) over WASAPI.</summary>
    Native,
    /// <summary>Legacy Windows Media Foundation MediaPlayer backend (retained as fallback).</summary>
    Legacy,
}

/// <summary>Container/codec detected from stream magic bytes.</summary>
public enum AudioFormat
{
    Unknown,
    Flac,
    Opus,
    Wav,
    Mp3,
}

/// <summary>
/// Stream properties captured from the HTTP response headers (including X-Sonus-* rendition headers
/// returned by the Sonus playback library server, when present).
/// </summary>
public sealed record StreamMetadata(
    string? ContentType,
    long TotalBytes,
    bool AcceptsRanges,
    string? Quality = null,
    string? Format = null,
    int? SampleRate = null,
    int? BitDepth = null,
    int? BitRate = null);

/// <summary>Thrown when a stream's container or codec is outside the built-in decoders (e.g. M4A/AAC/Vorbis).</summary>
public sealed class UnsupportedAudioFormatException(string message) : NotSupportedException(message);

/// <summary>
/// Common decoded PCM source implemented by the built-in FLAC, Ogg/Opus, WAV, and MP3 decoders.
/// All decoders emit interleaved 32-bit IEEE float PCM in [-1.0, 1.0].
/// </summary>
public interface IAudioDecoder : IDisposable
{
    AudioFormat Format { get; }
    int SampleRate { get; }
    int Channels { get; }
    int BitsPerSample { get; }
    long TotalSamples { get; }
    long CurrentSample { get; }
    double DurationSeconds { get; }
    bool CanSeek { get; }
    int CorruptedFramesSkipped { get; }
    Action<string>? OnDiagnostic { get; set; }

    /// <summary>Moves decoding to <paramref name="targetSample"/> (per-channel sample index, 0-based).</summary>
    void SeekSample(long targetSample);

    /// <summary>Reads interleaved float32 samples into <paramref name="dest"/>. Returns float count written (0 = EOF).</summary>
    int ReadFloats(Span<float> dest);
}
