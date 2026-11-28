using NLayer;

namespace Sonus.Core.Audio;

/// <summary>
/// Pure C# MP3 decoder backed by NLayer (MIT) for original MP3 playback and server-transcoded MP3 streams
/// (such as live DSD-to-MP3 transcodes) without Media Foundation.
/// </summary>
public sealed class Mp3Decoder : IAudioDecoder
{
    private readonly MpegFile _mpeg;
    private readonly bool _ownsStream;
    private readonly Stream _stream;
    private float[] _scratch = new float[8192];

    public AudioFormat Format => AudioFormat.Mp3;
    public int SampleRate => _mpeg.SampleRate;
    public int Channels => _mpeg.Channels;
    public int BitsPerSample => 0;
    public long TotalSamples => _mpeg.CanSeek && _mpeg.Length > 0 ? _mpeg.Length / (sizeof(float) * Math.Max(1, Channels)) : 0;
    public long CurrentSample { get; private set; }
    public double DurationSeconds => _mpeg.CanSeek ? _mpeg.Duration.TotalSeconds : 0;
    public bool CanSeek => _mpeg.CanSeek;
    public int CorruptedFramesSkipped { get; private set; }
    public Action<string>? OnDiagnostic { get; set; }

    public Mp3Decoder(Stream stream, bool ownsStream = false)
    {
        _stream = stream;
        _ownsStream = ownsStream;
        if (_stream.Position != 0) _stream.Seek(0, SeekOrigin.Begin);
        // Let NLayer inspect ID3v1 tail tags via bounded probe reads rather than opening a second streaming transfer
        var http = _stream as HttpAudioStream;
        if (http is not null) http.ProbeBlockSize = 64 * 1024;
        _mpeg = new MpegFile(_stream);
    }

    public void SeekSample(long targetSample)
    {
        if (!_mpeg.CanSeek)
        {
            if (targetSample == 0) { CurrentSample = 0; return; }
            throw new NotSupportedException("Underlying MP3 stream is not seekable.");
        }
        long max = TotalSamples;
        targetSample = max > 0 ? Math.Clamp(targetSample, 0, max) : Math.Max(0, targetSample);
        _mpeg.Position = targetSample * sizeof(float) * Channels;
        CurrentSample = targetSample;
    }

    public int ReadFloats(Span<float> dest)
    {
        if (dest.IsEmpty) return 0;
        if (_scratch.Length < dest.Length) _scratch = new float[dest.Length];
        try
        {
            int n = _mpeg.ReadSamples(_scratch, 0, dest.Length);
            if (n > 0)
            {
                _scratch.AsSpan(0, n).CopyTo(dest);
                CurrentSample += n / Math.Max(1, Channels);
            }
            return n;
        }
        catch (InvalidDataException ex)
        {
            CorruptedFramesSkipped++;
            if (CorruptedFramesSkipped <= 5 || CorruptedFramesSkipped % 50 == 0)
                OnDiagnostic?.Invoke($"MP3 bad frame skipped (#{CorruptedFramesSkipped} at sample {CurrentSample}): {ex.Message}");
            return 0;
        }
    }

    public void Dispose()
    {
        _mpeg.Dispose();
        if (_ownsStream) _stream.Dispose();
    }
}
