namespace Sonus.Core.Audio;

/// <summary>Records the exact ring-buffer frame index where a gapless next track begins.</summary>
public readonly record struct RingTrackBoundary(
    long FrameIndex,
    string TrackId,
    double DurationSeconds,
    StreamMetadata? Metadata,
    object? Tag);

/// <summary>
/// Thread-safe circular float32 PCM buffer bridging the background decode thread (producer) and the
/// real-time WASAPI render thread (consumer). Tracks exact frame positions of gapless track transitions
/// so the UI and SMTC switch at the exact moment audio crosses from track A to track B rather than
/// when the producer finished decoding track A into the buffer.
/// </summary>
public sealed class PcmRingBuffer
{
    private readonly float[] _buf;
    private readonly int _capacityFrames;
    private readonly int _channels;
    private readonly object _lock = new();
    private readonly Queue<RingTrackBoundary> _boundaries = new();

    private int _readFrame;
    private int _writeFrame;
    private int _countFrames;
    private long _totalWrittenFrames;
    private long _totalReadFrames;
    private bool _producerEof;

    public PcmRingBuffer(int capacityFrames, int channels)
    {
        _capacityFrames = Math.Max(1024, capacityFrames);
        _channels = Math.Max(1, channels);
        _buf = new float[_capacityFrames * _channels];
    }

    public int CapacityFrames => _capacityFrames;
    public int Channels => _channels;

    public int AvailableFrames { get { lock (_lock) return _countFrames; } }
    public int FreeFrames { get { lock (_lock) return _capacityFrames - _countFrames; } }
    public long TotalWrittenFrames { get { lock (_lock) return _totalWrittenFrames; } }
    public long TotalReadFrames { get { lock (_lock) return _totalReadFrames; } }
    public bool ProducerEof { get { lock (_lock) return _producerEof; } }

    public void Clear()
    {
        lock (_lock)
        {
            _readFrame = 0;
            _writeFrame = 0;
            _countFrames = 0;
            _totalWrittenFrames = 0;
            _totalReadFrames = 0;
            _producerEof = false;
            _boundaries.Clear();
        }
    }

    public void MarkEof()
    {
        lock (_lock) _producerEof = true;
    }

    /// <summary>
    /// Writes interleaved floats (must be a multiple of <see cref="Channels"/>) into the ring buffer,
    /// recording any gapless <paramref name="transitions"/> at their exact monotonic frame offsets.
    /// Returns the number of frames written.
    /// </summary>
    public int Write(ReadOnlySpan<float> interleaved, IReadOnlyList<TrackTransition>? transitions = null)
    {
        int frames = interleaved.Length / _channels;
        if (frames <= 0) return 0;

        lock (_lock)
        {
            int free = _capacityFrames - _countFrames;
            int toWrite = Math.Min(frames, free);
            if (toWrite <= 0) return 0;

            long baseFrame = _totalWrittenFrames;
            int firstPart = Math.Min(toWrite, _capacityFrames - _writeFrame);
            interleaved[..(firstPart * _channels)].CopyTo(_buf.AsSpan(_writeFrame * _channels, firstPart * _channels));

            int secondPart = toWrite - firstPart;
            if (secondPart > 0)
                interleaved.Slice(firstPart * _channels, secondPart * _channels).CopyTo(_buf.AsSpan(0, secondPart * _channels));

            _writeFrame = (_writeFrame + toWrite) % _capacityFrames;
            _countFrames += toWrite;
            _totalWrittenFrames += toWrite;

            if (transitions is not null)
            {
                for (int i = 0; i < transitions.Count; i++)
                {
                    var t = transitions[i];
                    if (t.OutputFrameOffset <= toWrite)
                    {
                        _boundaries.Enqueue(new RingTrackBoundary(
                            baseFrame + t.OutputFrameOffset,
                            t.NewTrack.Id,
                            t.NewTrack.DurationSeconds,
                            t.NewTrack.Metadata,
                            t.NewTrack.Tag));
                    }
                }
            }
            return toWrite;
        }
    }

    /// <summary>
    /// Reads interleaved floats into <paramref name="dest"/>. Any gapless track boundaries reached by this
    /// read are dequeued into <paramref name="crossed"/>. Returns float count read, along with the updated
    /// <paramref name="totalReadFrames"/> and <paramref name="isEof"/>.
    /// </summary>
    public int Read(Span<float> dest, List<RingTrackBoundary>? crossed, out long totalReadFrames, out bool isEof)
    {
        int wantFrames = dest.Length / _channels;
        lock (_lock)
        {
            int toRead = Math.Min(wantFrames, _countFrames);
            if (toRead > 0)
            {
                int firstPart = Math.Min(toRead, _capacityFrames - _readFrame);
                _buf.AsSpan(_readFrame * _channels, firstPart * _channels).CopyTo(dest[..(firstPart * _channels)]);

                int secondPart = toRead - firstPart;
                if (secondPart > 0)
                    _buf.AsSpan(0, secondPart * _channels).CopyTo(dest.Slice(firstPart * _channels, secondPart * _channels));

                _readFrame = (_readFrame + toRead) % _capacityFrames;
                _countFrames -= toRead;
                _totalReadFrames += toRead;
            }

            while (_boundaries.Count > 0 && _boundaries.Peek().FrameIndex <= _totalReadFrames)
            {
                var b = _boundaries.Dequeue();
                crossed?.Add(b);
            }

            totalReadFrames = _totalReadFrames;
            isEof = _producerEof && _countFrames == 0;
            return toRead * _channels;
        }
    }
}
