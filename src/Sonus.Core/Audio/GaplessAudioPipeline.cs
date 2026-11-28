using NAudio.Wave;
using NAudio.Wave.SampleProviders;

namespace Sonus.Core.Audio;

/// <summary>A decoded track ready to be rendered through <see cref="GaplessAudioPipeline"/>.</summary>
public sealed class DecodedTrack : IDisposable
{
    public string Id { get; }
    public IAudioDecoder Decoder { get; }
    public StreamMetadata? Metadata { get; }
    /// <summary>Optional tag/object carried with the track (e.g. EngineItem for SMTC display on gapless switch).</summary>
    public object? Tag { get; }

    public DecodedTrack(string id, IAudioDecoder decoder, StreamMetadata? metadata = null, object? tag = null)
    {
        Id = id;
        Decoder = decoder;
        Metadata = metadata;
        Tag = tag;
    }

    public double DurationSeconds => Decoder.DurationSeconds;
    public void Dispose() => Decoder.Dispose();
}

/// <summary>Recorded when the pipeline crosses seamlessly from one track into the preloaded next track.</summary>
public readonly record struct TrackTransition(int OutputFrameOffset, DecodedTrack NewTrack);

/// <summary>
/// Sample-accurate gapless audio rendering pipeline in pure C# (unit-testable without WASAPI).
/// Adapts each track's sample rate (via NAudio's WDL windowed-sinc resampler) and channel count to a fixed
/// output format, splices the preloaded next track at the exact sample after the current track's EOF with
/// zero silence frames, and applies volume, loudness gain (with soft peak limiting above 0.95), and silent mode.
/// </summary>
public sealed class GaplessAudioPipeline : IDisposable
{
    private readonly int _outRate;
    private readonly int _outChannels;
    private DecodedTrack? _current;
    private ISampleProvider? _currentProvider;
    private DecodedTrack? _next;
    private ISampleProvider? _nextProvider;
    private long _currentOutputFrames;
    private double _currentBaseSeconds;
    private float _smoothedGain = 1.0f;

    public int OutputSampleRate => _outRate;
    public int OutputChannels => _outChannels;
    public DecodedTrack? Current => _current;
    public DecodedTrack? Next => _next;

    /// <summary>Decoded position in seconds for the current track (before downstream ring-buffer latency).</summary>
    public double DecodedPositionSeconds => _currentBaseSeconds + (_currentOutputFrames / (double)_outRate);

    /// <summary>App volume in [0, 1].</summary>
    public float Volume { get; set; } = 1.0f;

    /// <summary>Muted flag (outputs silence while keeping clock/decoding running).</summary>
    public bool Muted { get; set; }

    /// <summary>Additional linear gain multiplier (e.g. EBU R128 loudness normalization, may exceed 1.0).</summary>
    public float GainMultiplier { get; set; } = 1.0f;

    /// <summary>When true (SONUS_E2E_SILENT=1), runs full decode+resample then zeroes output samples.</summary>
    public bool SilentMode { get; set; }

    /// <summary>
    /// When true (default), applies volume/mute/gain inside <see cref="Read"/>. Set to false when a downstream
    /// real-time consumer applies gain via <see cref="ApplyGainBuffer"/> so volume/mute changes take effect
    /// without waiting for ring-buffer latency.
    /// </summary>
    public bool ApplyGainInPipeline { get; set; } = true;

    public GaplessAudioPipeline(int outputSampleRate, int outputChannels)
    {
        _outRate = outputSampleRate;
        _outChannels = outputChannels;
    }

    /// <summary>Replaces the active track (and optionally sets the next track), disposing any prior tracks.</summary>
    public void SetCurrent(DecodedTrack? track, double startSeconds = 0)
    {
        _current?.Dispose();
        _current = track;
        _currentProvider = track is not null ? BuildProvider(track.Decoder) : null;
        _currentBaseSeconds = Math.Max(0, startSeconds);
        _currentOutputFrames = 0;
    }

    /// <summary>Replaces the preloaded next track, disposing any previous preloaded track.</summary>
    public void SetNext(DecodedTrack? next)
    {
        if (ReferenceEquals(_next, next)) return;
        _next?.Dispose();
        _next = next;
        _nextProvider = next is not null ? BuildProvider(next.Decoder) : null;
    }

    /// <summary>Seeks the current track to <paramref name="seconds"/> and resets the resampler cleanly.</summary>
    public double SeekCurrent(double seconds)
    {
        if (_current is null) return 0;
        long sample = Math.Max(0, (long)Math.Round(seconds * _current.Decoder.SampleRate));
        _current.Decoder.SeekSample(sample);
        double actual = _current.Decoder.SampleRate > 0 ? _current.Decoder.CurrentSample / (double)_current.Decoder.SampleRate : seconds;
        // Rebuild resampler so no pre-seek FIR history bleeds into the post-seek audio
        _currentProvider = BuildProvider(_current.Decoder);
        _currentBaseSeconds = actual;
        _currentOutputFrames = 0;
        return actual;
    }

    /// <summary>
    /// Reads interleaved float32 samples in output format into <paramref name="dest"/>.
    /// If the current track hits EOF and a preloaded next track is present, splices seamlessly inside the
    /// same buffer with zero gap and records the exact output frame offset in <paramref name="transitions"/>.
    /// Returns number of float values produced (less than <paramref name="dest"/>.Length only on final EOF).
    /// </summary>
    public int Read(Span<float> dest, List<TrackTransition>? transitions = null)
    {
        int written = 0;
        while (written < dest.Length && _currentProvider is not null)
        {
            int got = _currentProvider.Read(dest[written..]);
            if (got > 0)
            {
                written += got;
                _currentOutputFrames += got / _outChannels;
                continue;
            }

            // Current track hit EOF: seamlessly promote preloaded Next inside the SAME buffer!
            if (_next is not null && _nextProvider is not null)
            {
                var finished = _current;
                _current = _next;
                _currentProvider = _nextProvider;
                _next = null;
                _nextProvider = null;
                _currentBaseSeconds = 0;
                _currentOutputFrames = 0;
                finished?.Dispose();
                transitions?.Add(new TrackTransition(written / _outChannels, _current));
                continue;
            }

            // No next track: playback ended
            _current?.Dispose();
            _current = null;
            _currentProvider = null;
            break;
        }

        if (written > 0 && ApplyGainInPipeline)
            ApplyGainBuffer(dest[..written], _outChannels, _outRate, Volume, Muted, GainMultiplier, SilentMode, ref _smoothedGain);
        return written;
    }

    /// <summary>
    /// Applies smooth volume/mute/loudness gain with soft peak limiting above 0.95 (or zeroes when silent).
    /// Safe to invoke on the real-time WASAPI render thread (zero allocations).
    /// </summary>
    public static void ApplyGainBuffer(
        Span<float> samples,
        int channels,
        int sampleRate,
        float volume,
        bool muted,
        float gainMultiplier,
        bool silentMode,
        ref float smoothedGain)
    {
        if (silentMode)
        {
            samples.Clear();
            return;
        }

        float target = muted ? 0.0f : Math.Max(0.0f, volume * gainMultiplier);
        int frames = samples.Length / Math.Max(1, channels);
        float step = frames > 0 ? (target - smoothedGain) / Math.Max(frames, Math.Max(1, sampleRate / 200)) : 0;
        bool needLimiter = target > 0.98f || smoothedGain > 0.98f;

        if (Math.Abs(target - smoothedGain) < 1e-5f)
        {
            smoothedGain = target;
            if (target == 0.0f) { samples.Clear(); return; }
            if (target == 1.0f && !needLimiter) return;
            for (int i = 0; i < samples.Length; i++)
            {
                float v = samples[i] * target;
                samples[i] = needLimiter ? SoftLimit(v) : v;
            }
            return;
        }

        float g = smoothedGain;
        for (int f = 0; f < frames; f++)
        {
            g += step;
            if ((step > 0 && g > target) || (step < 0 && g < target)) g = target;
            int baseIdx = f * channels;
            for (int c = 0; c < channels; c++)
            {
                float v = samples[baseIdx + c] * g;
                samples[baseIdx + c] = needLimiter ? SoftLimit(v) : v;
            }
        }
        smoothedGain = g;
    }

    /// <summary>Transparent below 0.95 (-0.45 dBFS); smooth tanh knee prevents digital clipping when loudness gain boosts quiet tracks.</summary>
    public static float SoftLimit(float x)
    {
        const float knee = 0.95f;
        float ax = MathF.Abs(x);
        if (ax <= knee) return x;
        float over = (ax - knee) / (1.0f - knee);
        float limited = knee + (1.0f - knee) * MathF.Tanh(over);
        return x >= 0 ? limited : -limited;
    }

    private ISampleProvider BuildProvider(IAudioDecoder decoder)
    {
        ISampleProvider src = new DecoderSampleAdapter(decoder);
        if (decoder.Channels == 1 && _outChannels == 2)
            src = new MonoToStereoSampleProvider(src);
        else if (decoder.Channels != _outChannels)
            src = new ChannelRemixProvider(src, _outChannels);

        if (decoder.SampleRate != _outRate)
            src = new WdlResamplingSampleProvider(src, _outRate);
        return src;
    }

    public void Dispose()
    {
        _current?.Dispose();
        _next?.Dispose();
        _current = null;
        _next = null;
        _currentProvider = null;
        _nextProvider = null;
    }

    private sealed class DecoderSampleAdapter(IAudioDecoder decoder) : ISampleProvider
    {
        public WaveFormat WaveFormat { get; } = WaveFormat.CreateIeeeFloatWaveFormat(decoder.SampleRate, decoder.Channels);
        public int Read(float[] buffer, int offset, int count) => decoder.ReadFloats(buffer.AsSpan(offset, count));
        public int Read(Span<float> buffer) => decoder.ReadFloats(buffer);
    }

    /// <summary>Downmixes multichannel (e.g. 5.1) to stereo or stereo to mono so any valid source plays cleanly.</summary>
    private sealed class ChannelRemixProvider(ISampleProvider source, int outChannels) : ISampleProvider
    {
        private readonly int _inChannels = source.WaveFormat.Channels;
        private float[] _tmp = [];
        public WaveFormat WaveFormat { get; } = WaveFormat.CreateIeeeFloatWaveFormat(source.WaveFormat.SampleRate, outChannels);

        public int Read(float[] buffer, int offset, int count) => Read(buffer.AsSpan(offset, count));

        public int Read(Span<float> buffer)
        {
            int outFrames = buffer.Length / outChannels;
            if (outFrames == 0) return 0;
            int needIn = outFrames * _inChannels;
            if (_tmp.Length < needIn) _tmp = new float[needIn];
            int gotIn = source.Read(_tmp.AsSpan(0, needIn));
            int frames = gotIn / _inChannels;
            for (int f = 0; f < frames; f++)
            {
                int i = f * _inChannels;
                int o = f * outChannels;
                if (outChannels == 2 && _inChannels >= 2)
                {
                    float l = _tmp[i], r = _tmp[i + 1];
                    if (_inChannels >= 3) { float center = _tmp[i + 2] * 0.7071f; l += center; r += center; }
                    if (_inChannels >= 6) { l += _tmp[i + 4] * 0.7071f; r += _tmp[i + 5] * 0.7071f; }
                    buffer[o] = l;
                    buffer[o + 1] = r;
                }
                else
                {
                    float sum = 0;
                    for (int c = 0; c < _inChannels; c++) sum += _tmp[i + c];
                    float mono = sum / _inChannels;
                    for (int c = 0; c < outChannels; c++) buffer[o + c] = mono;
                }
            }
            return frames * outChannels;
        }
    }
}
