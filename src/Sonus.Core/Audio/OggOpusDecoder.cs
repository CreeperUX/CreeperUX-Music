using System.Buffers.Binary;
using Concentus;

namespace Sonus.Core.Audio;

/// <summary>
/// Pure C# Ogg/Opus decoder backed by Concentus (BSD-3-Clause) with RFC 7845 pre-skip and end-granule
/// trimming for sample-accurate gapless playback, 64 KB HTTP Range bisection seeking (80 ms pre-roll),
/// and packet loss concealment (PLC) recovery on corrupt packets.
/// </summary>
public sealed class OggOpusDecoder : IAudioDecoder
{
    private readonly Stream _stream;
    private readonly bool _ownsStream;
    private readonly IOpusDecoder _decoder;
    private readonly float _outputGainLinear;
    private readonly int _preSkip;
    private readonly long _firstAudioPageOffset;
    private readonly long _totalGranule; // EOS granule position (includes pre_skip)
    private readonly uint _serialNumber;

    // Buffered sequential byte reader over _stream to avoid per-byte virtual calls
    private readonly byte[] _readBuf = new byte[32 * 1024];
    private int _readBufPos;
    private int _readBufLen;

    // Packet reassembly & decoded PCM buffer
    private readonly MemoryStream _packetBuf = new();
    private readonly Queue<(byte[] Data, long PageGranule, bool IsLastPacketOnPage, bool IsEosPage)> _packets = new();
    private readonly float[] _pcmBuf;
    private int _pcmPos;
    private int _pcmCount;
    private long _decodedGranule;
    private int _skipRemaining;
    private bool _eof;

    public AudioFormat Format => AudioFormat.Opus;
    public int SampleRate => 48000;
    public int Channels { get; }
    public int BitsPerSample => 0;
    public long TotalSamples => _totalGranule > _preSkip ? _totalGranule - _preSkip : 0;
    public long CurrentSample { get; private set; }
    public double DurationSeconds => TotalSamples > 0 ? TotalSamples / 48000.0 : 0;
    public bool CanSeek => _stream.CanSeek && _totalGranule > 0;
    public int CorruptedFramesSkipped { get; private set; }
    public Action<string>? OnDiagnostic { get; set; }

    public OggOpusDecoder(Stream stream, bool ownsStream = false)
    {
        _stream = stream;
        _ownsStream = ownsStream;
        ResetStreamTo(0);

        // 1. Read OpusHead (BOS page)
        if (!TryReadPage(out var headPage) || (headPage.HeaderType & 0x02) == 0 || headPage.Packets.Count == 0)
            throw new InvalidDataException("Missing Ogg Opus BOS page.");
        byte[] head = headPage.Packets[0].Data;
        if (head.Length < 19 || !head.AsSpan(0, 8).SequenceEqual("OpusHead"u8))
            throw new InvalidDataException("Not an Ogg Opus stream (missing OpusHead).");

        _serialNumber = headPage.Serial;
        Channels = head[9];
        _preSkip = BinaryPrimitives.ReadUInt16LittleEndian(head.AsSpan(10, 2));
        short outputGainQ78 = BinaryPrimitives.ReadInt16LittleEndian(head.AsSpan(16, 2));
        _outputGainLinear = outputGainQ78 == 0 ? 1.0f : (float)Math.Pow(10.0, outputGainQ78 / (20.0 * 256.0));
        if (Channels is < 1 or > 2)
            throw new UnsupportedAudioFormatException($"Built-in Opus decoder supports 1-2 channels (got {Channels}).");

        // 2. Skip OpusTags (may span multiple pages if cover art is embedded)
        while (TryReadPage(out var page))
        {
            if (page.Serial != _serialNumber) continue;
            if (page.Packets.Count > 0 && page.Packets[0].Data.Length >= 8 && page.Packets[0].Data.AsSpan(0, 8).SequenceEqual("OpusTags"u8))
                break;
        }
        _firstAudioPageOffset = LogicalStreamPos;

        // 3. Find EOS granule via a single bounded tail Range read (64 KB from end)
        if (_stream.CanSeek)
        {
            var http = _stream as HttpAudioStream;
            if (http is not null) { http.ProbeBlockSize = 64 * 1024; http.ProbeMode = true; }
            try { _totalGranule = FindLastGranule(); }
            finally { if (http is not null) http.ProbeMode = false; }
            ResetStreamTo(_firstAudioPageOffset);
        }

        // 4. Create Concentus Opus decoder (always 48 kHz per RFC 7845)
        _decoder = OpusCodecFactory.CreateDecoder(48000, Channels);
        _pcmBuf = new float[5760 * Channels]; // max Opus frame is 120 ms = 5760 samples/channel
        _skipRemaining = _preSkip;
        _decodedGranule = 0;
        CurrentSample = 0;
    }

    private long LogicalStreamPos => _stream.Position - (_readBufLen - _readBufPos);

    private void ResetStreamTo(long pos)
    {
        if (_stream.Position != pos)
            _stream.Seek(pos, SeekOrigin.Begin);
        _readBufPos = 0;
        _readBufLen = 0;
    }

    private int ReadNextByte()
    {
        if (_readBufPos < _readBufLen) return _readBuf[_readBufPos++];
        _readBufPos = 0;
        _readBufLen = _stream.Read(_readBuf, 0, _readBuf.Length);
        return _readBufLen == 0 ? -1 : _readBuf[_readBufPos++];
    }

    private bool ReadFully(Span<byte> dest)
    {
        int got = 0;
        while (got < dest.Length)
        {
            int avail = _readBufLen - _readBufPos;
            if (avail > 0)
            {
                int take = Math.Min(dest.Length - got, avail);
                _readBuf.AsSpan(_readBufPos, take).CopyTo(dest.Slice(got, take));
                _readBufPos += take;
                got += take;
                continue;
            }
            _readBufPos = 0;
            _readBufLen = _stream.Read(_readBuf, 0, _readBuf.Length);
            if (_readBufLen == 0) return false;
        }
        return true;
    }

    private long FindLastGranule()
    {
        if (!_stream.CanSeek || _stream.Length <= _firstAudioPageOffset) return 0;
        long scanLen = Math.Min(65536, _stream.Length - _firstAudioPageOffset);
        long start = _stream.Length - scanLen;
        _stream.Seek(start, SeekOrigin.Begin);
        byte[] tail = new byte[scanLen];
        int got = 0;
        while (got < tail.Length)
        {
            int n = _stream.Read(tail, got, tail.Length - got);
            if (n == 0) break;
            got += n;
        }
        for (int i = got - 27; i >= 0; i--)
        {
            if (tail[i] == (byte)'O' && tail[i + 1] == (byte)'g' && tail[i + 2] == (byte)'g' && tail[i + 3] == (byte)'S' && tail[i + 4] == 0)
            {
                uint serial = BinaryPrimitives.ReadUInt32LittleEndian(tail.AsSpan(i + 14, 4));
                long gran = BinaryPrimitives.ReadInt64LittleEndian(tail.AsSpan(i + 6, 8));
                if (serial == _serialNumber && gran >= 0) return gran;
            }
        }
        return 0;
    }

    public void SeekSample(long targetSample)
    {
        targetSample = Math.Clamp(targetSample, 0, TotalSamples > 0 ? TotalSamples : Math.Max(0, targetSample));
        _packets.Clear();
        _packetBuf.SetLength(0);
        _pcmPos = 0;
        _pcmCount = 0;
        _eof = false;
        _decoder.ResetState();

        if (targetSample == 0 || !_stream.CanSeek || _totalGranule <= 0)
        {
            if (_stream.CanSeek) ResetStreamTo(_firstAudioPageOffset);
            _decodedGranule = 0;
            _skipRemaining = _preSkip;
            CurrentSample = 0;
            return;
        }

        // RFC 7845 §4.6: decode 80 ms (3840 samples) of pre-roll so Opus LPC/MDCT state converges cleanly
        long targetGranule = targetSample + _preSkip;
        long preRollGranule = Math.Max(0, targetGranule - 3840);

        long low = _firstAudioPageOffset;
        long high = _stream.Length;
        long bestPageOffset = _firstAudioPageOffset;
        long bestPrevGranule = 0;

        var http = _stream as HttpAudioStream;
        if (http is not null) { http.ProbeBlockSize = 64 * 1024; http.ProbeMode = true; }
        try
        {
            long probe = low + (long)((double)preRollGranule / _totalGranule * (high - low));
            for (int iter = 0; iter < 10 && high - low > 8192; iter++)
            {
                probe = Math.Clamp(probe, low, high - 1);
                if (!TrySyncAndPeekPageHeader(probe, out long pageOff, out long granule, out long nextPageOff))
                {
                    high = probe;
                    probe = low + ((high - low) >> 1);
                    continue;
                }
                if (granule < preRollGranule)
                {
                    bestPageOffset = nextPageOff;
                    bestPrevGranule = granule;
                    low = nextPageOff;
                }
                else
                {
                    high = pageOff;
                }
                probe = low + ((high - low) >> 1);
            }
        }
        finally
        {
            if (http is not null) http.ProbeMode = false;
        }

        ResetStreamTo(bestPageOffset);
        _decodedGranule = bestPrevGranule;

        while (true)
        {
            if (!DecodeNextPacket()) { _eof = true; CurrentSample = TotalSamples; return; }
            int samples = _pcmCount / Channels;
            long packetEndGranule = _decodedGranule;
            long packetStartGranule = packetEndGranule - samples;
            if (packetEndGranule > targetGranule)
            {
                int skip = (int)Math.Clamp(targetGranule - packetStartGranule, 0, samples);
                _pcmPos = skip * Channels;
                _skipRemaining = 0;
                CurrentSample = targetSample;
                return;
            }
        }
    }

    private bool TrySyncAndPeekPageHeader(long startOffset, out long pageOffset, out long granule, out long nextPageOffset)
    {
        pageOffset = 0; granule = -1; nextPageOffset = startOffset;
        _stream.Seek(startOffset, SeekOrigin.Begin);
        byte[] scan = new byte[Math.Min(65536, Math.Max(0, _stream.Length - startOffset))];
        int got = 0;
        while (got < scan.Length)
        {
            int n = _stream.Read(scan, got, scan.Length - got);
            if (n == 0) break;
            got += n;
        }
        for (int i = 0; i + 27 <= got; i++)
        {
            if (scan[i] == (byte)'O' && scan[i + 1] == (byte)'g' && scan[i + 2] == (byte)'g' && scan[i + 3] == (byte)'S' && scan[i + 4] == 0)
            {
                uint serial = BinaryPrimitives.ReadUInt32LittleEndian(scan.AsSpan(i + 14, 4));
                if (serial != _serialNumber) continue;
                int segs = scan[i + 26];
                if (i + 27 + segs > got) break;
                int bodyLen = 0;
                for (int s = 0; s < segs; s++) bodyLen += scan[i + 27 + s];
                long gran = BinaryPrimitives.ReadInt64LittleEndian(scan.AsSpan(i + 6, 8));
                if (gran >= 0)
                {
                    pageOffset = startOffset + i;
                    granule = gran;
                    nextPageOffset = pageOffset + 27 + segs + bodyLen;
                    return true;
                }
            }
        }
        return false;
    }

    public int ReadFloats(Span<float> dest)
    {
        int written = 0;
        while (written < dest.Length && !_eof)
        {
            if (_pcmPos < _pcmCount)
            {
                if (_skipRemaining > 0)
                {
                    int availSamples = (_pcmCount - _pcmPos) / Channels;
                    int drop = Math.Min(_skipRemaining, availSamples);
                    _pcmPos += drop * Channels;
                    _skipRemaining -= drop;
                    continue;
                }
                int take = Math.Min(dest.Length - written, _pcmCount - _pcmPos);
                _pcmBuf.AsSpan(_pcmPos, take).CopyTo(dest.Slice(written, take));
                _pcmPos += take;
                written += take;
                CurrentSample += take / Channels;
                continue;
            }
            if (!DecodeNextPacket())
            {
                _eof = true;
                break;
            }
        }
        return written;
    }

    private bool DecodeNextPacket()
    {
        while (_packets.Count == 0)
        {
            if (!TryReadPage(out var page)) return false;
            if (page.Serial != _serialNumber) continue;
            bool eos = (page.HeaderType & 0x04) != 0;
            for (int i = 0; i < page.Packets.Count; i++)
            {
                bool isLast = i == page.Packets.Count - 1;
                _packets.Enqueue((page.Packets[i].Data, page.Granule, isLast, eos));
            }
        }

        var pkt = _packets.Dequeue();
        int decodedSamples;
        try
        {
            decodedSamples = _decoder.Decode(pkt.Data.AsSpan(), _pcmBuf.AsSpan(), 5760, false);
        }
        catch (Exception ex)
        {
            // Bad Opus packet: synthesize 20 ms PLC concealment and keep playing
            CorruptedFramesSkipped++;
            if (CorruptedFramesSkipped <= 5 || CorruptedFramesSkipped % 50 == 0)
                OnDiagnostic?.Invoke($"Opus bad packet recovered via PLC (#{CorruptedFramesSkipped} at sample {CurrentSample}): {ex.Message}");
            decodedSamples = _decoder.Decode(ReadOnlySpan<byte>.Empty, _pcmBuf.AsSpan(), 960, false);
        }

        if (decodedSamples <= 0)
        {
            _pcmPos = 0; _pcmCount = 0;
            return true;
        }

        int totalFloats = decodedSamples * Channels;
        if (_outputGainLinear != 1.0f)
            for (int i = 0; i < totalFloats; i++) _pcmBuf[i] *= _outputGainLinear;

        // Track granule position and trim trailing encoder padding on the EOS page (RFC 7845 §4.4)
        long newGranule = _decodedGranule + decodedSamples;
        if (pkt.IsLastPacketOnPage && pkt.PageGranule >= 0)
        {
            if (pkt.IsEosPage && newGranule > pkt.PageGranule)
            {
                long trim = newGranule - pkt.PageGranule;
                decodedSamples = (int)Math.Max(0, decodedSamples - trim);
                totalFloats = decodedSamples * Channels;
            }
            _decodedGranule = pkt.PageGranule;
        }
        else
        {
            _decodedGranule = newGranule;
        }

        _pcmPos = 0;
        _pcmCount = totalFloats;
        return true;
    }

    private readonly record struct OggPacket(byte[] Data);
    private readonly record struct OggPage(byte HeaderType, long Granule, uint Serial, List<OggPacket> Packets);

    private bool TryReadPage(out OggPage page)
    {
        page = default;
        Span<byte> hdr = stackalloc byte[27];
        int matched = 0;
        int resync = 0;
        while (matched < 4)
        {
            int b = ReadNextByte();
            if (b < 0) return false;
            byte expected = matched switch { 0 => (byte)'O', 1 => (byte)'g', 2 => (byte)'g', _ => (byte)'S' };
            if (b == expected) matched++;
            else { matched = b == (byte)'O' ? 1 : 0; if (++resync > 65536) return false; }
        }
        hdr[0] = (byte)'O'; hdr[1] = (byte)'g'; hdr[2] = (byte)'g'; hdr[3] = (byte)'S';
        if (!ReadFully(hdr.Slice(4))) return false;

        byte headerType = hdr[5];
        long granule = BinaryPrimitives.ReadInt64LittleEndian(hdr.Slice(6, 8));
        uint serial = BinaryPrimitives.ReadUInt32LittleEndian(hdr.Slice(14, 4));
        int numSegs = hdr[26];
        byte[] segTable = new byte[numSegs];
        if (!ReadFully(segTable)) return false;

        int bodyLen = 0;
        for (int i = 0; i < numSegs; i++) bodyLen += segTable[i];
        byte[] body = new byte[bodyLen];
        if (!ReadFully(body)) return false;

        if ((headerType & 0x01) == 0 && _packetBuf.Length > 0) _packetBuf.SetLength(0);

        var packets = new List<OggPacket>();
        int off = 0;
        for (int i = 0; i < numSegs; i++)
        {
            int slen = segTable[i];
            if (slen > 0) _packetBuf.Write(body, off, slen);
            off += slen;
            if (slen < 255)
            {
                packets.Add(new OggPacket(_packetBuf.ToArray()));
                _packetBuf.SetLength(0);
            }
        }
        page = new OggPage(headerType, granule, serial, packets);
        return true;
    }

    public void Dispose()
    {
        _packetBuf.Dispose();
        if (_ownsStream) _stream.Dispose();
    }
}
