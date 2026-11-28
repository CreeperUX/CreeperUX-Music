using System.Buffers.Binary;
using System.Numerics;

namespace Sonus.Core.Audio;

/// <summary>
/// Pure C# RFC 9639 FLAC decoder with SEEKTABLE-accelerated seeking, fallback bisection seeking,
/// full 8–24 bit (including 96/192 kHz 24-bit high-res) decoding, CRC-8/CRC-16 verification,
/// and bad-frame skipping so a corrupt frame logs and continues instead of failing the song.
/// </summary>
public sealed class FlacDecoder : IAudioDecoder
{
    public readonly record struct SeekPoint(long SampleNumber, long StreamOffset, int FrameSamples);

    private readonly Stream _stream;
    private readonly bool _ownsStream;
    private readonly List<SeekPoint> _seekTable = [];
    private readonly byte[] _streamInfoMd5 = new byte[16];
    private readonly byte[] _buf = new byte[256 * 1024]; // covers even 192 kHz/24-bit verbatim frames
    private int _bufPos;
    private int _bufLen;
    private long _bufStreamStart;

    // Reusable per-frame decode buffers (zero steady-state heap allocations)
    private int[][] _channelBufs = [];
    private readonly int[] _lpcCoeffs = new int[32];
    private float[] _floatFrame = [];
    private int _floatFrameCount;
    private int _floatFramePos;

    public AudioFormat Format => AudioFormat.Flac;
    public int SampleRate { get; private set; }
    public int Channels { get; private set; }
    public int BitsPerSample { get; private set; }
    public long TotalSamples { get; private set; }
    public int MinBlockSize { get; private set; }
    public int MaxBlockSize { get; private set; }
    public int MinFrameSize { get; private set; }
    public int MaxFrameSize { get; private set; }
    public long FirstFrameOffset { get; private set; }
    public long CurrentSample { get; private set; }
    public int CorruptedFramesSkipped { get; private set; }
    public bool CanSeek => _stream.CanSeek;
    public Action<string>? OnDiagnostic { get; set; }
    public IReadOnlyList<SeekPoint> SeekTable => _seekTable;
    public ReadOnlySpan<byte> StreamInfoMd5 => _streamInfoMd5;
    public double DurationSeconds => SampleRate > 0 && TotalSamples > 0 ? (double)TotalSamples / SampleRate : 0;

    // CRC-8 (poly 0x07) and CRC-16 (poly 0x8005) lookup tables per RFC 9639
    private static readonly byte[] Crc8Table = BuildCrc8Table();
    private static readonly ushort[] Crc16Table = BuildCrc16Table();

    private static byte[] BuildCrc8Table()
    {
        var t = new byte[256];
        for (int i = 0; i < 256; i++)
        {
            int c = i;
            for (int b = 0; b < 8; b++) c = (c & 0x80) != 0 ? ((c << 1) ^ 0x07) : (c << 1);
            t[i] = (byte)c;
        }
        return t;
    }

    private static ushort[] BuildCrc16Table()
    {
        var t = new ushort[256];
        for (int i = 0; i < 256; i++)
        {
            int c = i << 8;
            for (int b = 0; b < 8; b++) c = (c & 0x8000) != 0 ? ((c << 1) ^ 0x8005) : (c << 1);
            t[i] = (ushort)c;
        }
        return t;
    }

    private static byte ComputeCrc8(ReadOnlySpan<byte> data)
    {
        byte crc = 0;
        for (int i = 0; i < data.Length; i++) crc = Crc8Table[crc ^ data[i]];
        return crc;
    }

    private static ushort ComputeCrc16(ReadOnlySpan<byte> data)
    {
        ushort crc = 0;
        for (int i = 0; i < data.Length; i++) crc = (ushort)((crc << 8) ^ Crc16Table[(crc >> 8) ^ data[i]]);
        return crc;
    }

    public FlacDecoder(Stream stream, bool ownsStream = false)
    {
        _stream = stream;
        _ownsStream = ownsStream;
        ParseMetadata();
        _channelBufs = new int[Channels][];
        int cap = Math.Max(MaxBlockSize, 65536);
        for (int c = 0; c < Channels; c++) _channelBufs[c] = new int[cap];
        _floatFrame = new float[cap * Channels];
    }

    private void ResetBufferAt(long streamPos)
    {
        if (_stream.Position != streamPos)
            _stream.Seek(streamPos, SeekOrigin.Begin);
        _bufStreamStart = streamPos;
        _bufPos = 0;
        _bufLen = 0;
    }

    private long CurrentStreamPos => _bufStreamStart + _bufPos;

    private bool EnsureBuffered(int minBytes)
    {
        int avail = _bufLen - _bufPos;
        if (avail >= minBytes) return true;
        if (avail > 0 && _bufPos > 0)
            Buffer.BlockCopy(_buf, _bufPos, _buf, 0, avail);
        _bufStreamStart += _bufPos;
        _bufPos = 0;
        _bufLen = avail;
        // Pull up to _buf.Length when needed, but cap each fill to max(minBytes, 64 KB) so we don't
        // eagerly slurp 256 KB on a slow network before emitting the first frame.
        int fillTarget = Math.Min(_buf.Length, Math.Max(minBytes, 64 * 1024));
        while (_bufLen < fillTarget)
        {
            int n = _stream.Read(_buf, _bufLen, fillTarget - _bufLen);
            if (n == 0) break;
            _bufLen += n;
            if (_bufLen >= minBytes) break;
        }
        return (_bufLen - _bufPos) >= minBytes;
    }

    private void ReadExact(Span<byte> dest)
    {
        int done = 0;
        while (done < dest.Length)
        {
            if (!EnsureBuffered(1)) throw new EndOfStreamException("Unexpected EOF in FLAC metadata.");
            int take = Math.Min(dest.Length - done, _bufLen - _bufPos);
            _buf.AsSpan(_bufPos, take).CopyTo(dest.Slice(done, take));
            _bufPos += take;
            done += take;
        }
    }

    private void SkipExact(long count)
    {
        if (count <= 0) return;
        int avail = _bufLen - _bufPos;
        if (count <= avail) { _bufPos += (int)count; return; }
        long target = CurrentStreamPos + count;
        if (_stream.CanSeek)
        {
            ResetBufferAt(target);
            return;
        }
        count -= avail;
        _bufPos = _bufLen;
        byte[] tmp = new byte[8192];
        while (count > 0)
        {
            int n = _stream.Read(tmp, 0, (int)Math.Min(tmp.Length, count));
            if (n == 0) throw new EndOfStreamException();
            _bufStreamStart += n;
            count -= n;
        }
    }

    private void ParseMetadata()
    {
        ResetBufferAt(0);
        Span<byte> magic = stackalloc byte[4];
        ReadExact(magic);
        // Handle optional ID3v2 tag prepended to some non-standard FLAC files
        if (magic[0] == (byte)'I' && magic[1] == (byte)'D' && magic[2] == (byte)'3')
        {
            Span<byte> id3Rest = stackalloc byte[6];
            ReadExact(id3Rest);
            int id3Size = ((id3Rest[2] & 0x7F) << 21) | ((id3Rest[3] & 0x7F) << 14) | ((id3Rest[4] & 0x7F) << 7) | (id3Rest[5] & 0x7F);
            SkipExact(id3Size);
            ReadExact(magic);
        }
        if (magic[0] != (byte)'f' || magic[1] != (byte)'L' || magic[2] != (byte)'a' || magic[3] != (byte)'C')
            throw new InvalidDataException("Not a FLAC stream (missing fLaC marker).");

        bool gotStreamInfo = false;
        Span<byte> hdr = stackalloc byte[4];
        Span<byte> si = stackalloc byte[34];
        while (true)
        {
            ReadExact(hdr);
            bool isLast = (hdr[0] & 0x80) != 0;
            int type = hdr[0] & 0x7F;
            int len = (hdr[1] << 16) | (hdr[2] << 8) | hdr[3];

            if (type == 0) // STREAMINFO
            {
                if (len < 34) throw new InvalidDataException("Invalid STREAMINFO length.");
                ReadExact(si);
                MinBlockSize = BinaryPrimitives.ReadUInt16BigEndian(si.Slice(0, 2));
                MaxBlockSize = BinaryPrimitives.ReadUInt16BigEndian(si.Slice(2, 2));
                MinFrameSize = (si[4] << 16) | (si[5] << 8) | si[6];
                MaxFrameSize = (si[7] << 16) | (si[8] << 8) | si[9];
                ulong packed = BinaryPrimitives.ReadUInt64BigEndian(si.Slice(10, 8));
                SampleRate = (int)(packed >> 44);
                Channels = (int)((packed >> 41) & 0x7) + 1;
                BitsPerSample = (int)((packed >> 36) & 0x1F) + 1;
                TotalSamples = (long)(packed & 0xFFFFFFFFFUL);
                si.Slice(18, 16).CopyTo(_streamInfoMd5);
                if (len > 34) SkipExact(len - 34);
                gotStreamInfo = true;
            }
            else if (type == 3) // SEEKTABLE
            {
                int count = len / 18;
                byte[] raw = new byte[len];
                ReadExact(raw);
                for (int i = 0; i < count; i++)
                {
                    int o = i * 18;
                    ulong sample = BinaryPrimitives.ReadUInt64BigEndian(raw.AsSpan(o, 8));
                    ulong offset = BinaryPrimitives.ReadUInt64BigEndian(raw.AsSpan(o + 8, 8));
                    ushort samples = BinaryPrimitives.ReadUInt16BigEndian(raw.AsSpan(o + 16, 2));
                    if (sample != ulong.MaxValue && samples > 0)
                        _seekTable.Add(new SeekPoint((long)sample, (long)offset, samples));
                }
            }
            else
            {
                SkipExact(len);
            }

            if (isLast) break;
        }

        if (!gotStreamInfo || SampleRate <= 0 || Channels <= 0 || BitsPerSample is < 4 or > 32)
            throw new InvalidDataException("FLAC stream missing valid STREAMINFO.");
        FirstFrameOffset = CurrentStreamPos;
    }

    public void SeekSample(long targetSample)
    {
        if (targetSample < 0) targetSample = 0;
        if (TotalSamples > 0 && targetSample > TotalSamples) targetSample = TotalSamples;
        _floatFrameCount = 0;
        _floatFramePos = 0;

        if (!_stream.CanSeek)
        {
            if (targetSample == 0) { CurrentSample = 0; return; }
            throw new NotSupportedException("Underlying stream is not seekable.");
        }

        if (targetSample == 0)
        {
            ResetBufferAt(FirstFrameOffset);
            CurrentSample = 0;
            return;
        }

        // 1. Use SEEKTABLE if available: O(log N) lookup -> single HTTP Range jump!
        long seekByteOffset;
        if (_seekTable.Count > 0)
        {
            int lo = 0, hi = _seekTable.Count - 1, best = -1;
            while (lo <= hi)
            {
                int mid = lo + ((hi - lo) >> 1);
                if (_seekTable[mid].SampleNumber <= targetSample) { best = mid; lo = mid + 1; }
                else hi = mid - 1;
            }
            seekByteOffset = best >= 0 ? FirstFrameOffset + _seekTable[best].StreamOffset : FirstFrameOffset;
        }
        else if (_stream.Length > FirstFrameOffset && TotalSamples > 0)
        {
            // 2. No SEEKTABLE (e.g. raw original FLAC): bounded-block bisection over frame headers
            var http = _stream as HttpAudioStream;
            if (http is not null)
            {
                http.ProbeBlockSize = 128 * 1024;
                http.ProbeMode = true;
            }
            try { seekByteOffset = BisectFrameOffset(targetSample); }
            finally { if (http is not null) http.ProbeMode = false; }
        }
        else
        {
            seekByteOffset = FirstFrameOffset;
        }

        ResetBufferAt(seekByteOffset);
        // Decode frames forward until reaching exact targetSample
        while (true)
        {
            int n = DecodeNextFrameIntoFloat(out long frameFirstSample);
            if (n == 0) { CurrentSample = TotalSamples; return; }
            if (frameFirstSample + n > targetSample)
            {
                int skip = (int)Math.Max(0, targetSample - frameFirstSample);
                _floatFramePos = skip * Channels;
                CurrentSample = frameFirstSample + skip;
                return;
            }
        }
    }

    private long BisectFrameOffset(long targetSample)
    {
        long low = FirstFrameOffset;
        long high = _stream.Length;
        long bestOffset = FirstFrameOffset;
        long probe = FirstFrameOffset + (long)((double)targetSample / TotalSamples * (high - low));
        for (int iter = 0; iter < 10 && high - low > 16384; iter++)
        {
            probe = Math.Clamp(probe, low, high - 1);
            ResetBufferAt(probe);
            if (!FindNextValidFrameHeader(out long frameOffset, out long frameSample, out int blockSize))
            {
                high = probe;
                probe = low + ((high - low) >> 1);
                continue;
            }
            if (frameSample <= targetSample)
            {
                bestOffset = frameOffset;
                if (targetSample - frameSample <= Math.Max(blockSize * 4L, SampleRate))
                    return bestOffset;
                low = frameOffset;
            }
            else
            {
                high = frameOffset;
            }
            probe = low + ((high - low) >> 1);
        }
        return bestOffset;
    }

    private bool FindNextValidFrameHeader(out long frameOffset, out long frameSample, out int blockSize)
    {
        frameOffset = 0; frameSample = 0; blockSize = 0;
        int scanned = 0;
        while (scanned < 65536 && EnsureBuffered(16))
        {
            int avail = _bufLen - _bufPos;
            for (int i = _bufPos; i + 15 < _bufLen; i++)
            {
                if (_buf[i] == 0xFF && (_buf[i + 1] & 0xFE) == 0xF8)
                {
                    if (TryParseFrameHeader(_buf.AsSpan(i, _bufLen - i), out _, out int bs, out int sr, out int chAssign, out int bps, out long sampleNum, out bool varBlock))
                    {
                        if (sr == SampleRate && bps == BitsPerSample && ChannelsFromAssignment(chAssign) == Channels)
                        {
                            frameOffset = _bufStreamStart + i;
                            frameSample = varBlock ? sampleNum : sampleNum * MinBlockSize;
                            blockSize = bs;
                            _bufPos = i;
                            return true;
                        }
                    }
                }
            }
            int advance = Math.Max(1, avail - 16);
            _bufPos += advance;
            scanned += advance;
        }
        return false;
    }

    public int ReadFloats(Span<float> dest)
    {
        int written = 0;
        while (written < dest.Length)
        {
            if (_floatFramePos < _floatFrameCount)
            {
                int take = Math.Min(dest.Length - written, _floatFrameCount - _floatFramePos);
                _floatFrame.AsSpan(_floatFramePos, take).CopyTo(dest.Slice(written, take));
                _floatFramePos += take;
                written += take;
                CurrentSample += take / Channels;
                continue;
            }
            int samples = DecodeNextFrameIntoFloat(out _);
            if (samples == 0) break;
        }
        return written;
    }

    /// <summary>Decodes the next frame directly to raw signed integer PCM (per-channel) for bit-exact MD5 verification.</summary>
    internal int DecodeNextFrameRaw(out int[][] channels)
    {
        channels = _channelBufs;
        return DecodeNextFrameInternal(out _);
    }

    private int DecodeNextFrameIntoFloat(out long frameFirstSample)
    {
        int blockSize = DecodeNextFrameInternal(out frameFirstSample);
        if (blockSize == 0) { _floatFramePos = 0; _floatFrameCount = 0; return 0; }
        int totalFloats = blockSize * Channels;
        if (_floatFrame.Length < totalFloats) _floatFrame = new float[totalFloats];
        float scale = 1.0f / (1L << (BitsPerSample - 1));
        int ch = Channels;
        if (ch == 2)
        {
            int[] l = _channelBufs[0], r = _channelBufs[1];
            for (int i = 0, o = 0; i < blockSize; i++)
            {
                _floatFrame[o++] = l[i] * scale;
                _floatFrame[o++] = r[i] * scale;
            }
        }
        else
        {
            for (int i = 0, o = 0; i < blockSize; i++)
                for (int c = 0; c < ch; c++)
                    _floatFrame[o++] = _channelBufs[c][i] * scale;
        }
        _floatFramePos = 0;
        _floatFrameCount = totalFloats;
        return blockSize;
    }

    private void NoteCorruptFrame(string reason, long offset)
    {
        CorruptedFramesSkipped++;
        if (CorruptedFramesSkipped <= 5 || CorruptedFramesSkipped % 50 == 0)
            OnDiagnostic?.Invoke($"FLAC bad frame skipped (#{CorruptedFramesSkipped} at byte {offset}, sample {CurrentSample}): {reason}");
    }

    private int DecodeNextFrameInternal(out long frameFirstSample)
    {
        frameFirstSample = CurrentSample;
        int resyncLimit = 256 * 1024;
        int minFrameBuf = MaxFrameSize > 0 ? Math.Min(MaxFrameSize, _buf.Length) : 65536;
        while (true)
        {
            if (!EnsureBuffered(minFrameBuf))
            {
                if (_bufLen - _bufPos < 6) return 0; // EOF
            }

            // Locate sync code 0xFF 0xF8/0xF9
            if (!(_buf[_bufPos] == 0xFF && (_buf[_bufPos + 1] & 0xFE) == 0xF8))
            {
                bool found = false;
                while (resyncLimit > 0 && _bufLen - _bufPos >= 2)
                {
                    _bufPos++;
                    resyncLimit--;
                    if (_buf[_bufPos] == 0xFF && (_buf[_bufPos + 1] & 0xFE) == 0xF8) { found = true; break; }
                    if (_bufLen - _bufPos < 16 && !EnsureBuffered(65536)) break;
                }
                if (!found) return 0;
            }

            int frameStart = _bufPos;
            ReadOnlySpan<byte> span = _buf.AsSpan(frameStart, _bufLen - frameStart);
            if (!TryParseFrameHeader(span, out int headerLen, out int blockSize, out int sampleRate, out int chAssign, out int bps, out long number, out bool varBlock))
            {
                NoteCorruptFrame("invalid header/CRC-8", _bufStreamStart + frameStart);
                _bufPos++;
                if (--resyncLimit <= 0) return 0;
                continue;
            }

            int chCount = ChannelsFromAssignment(chAssign);
            if (chCount != Channels || blockSize <= 0)
            {
                NoteCorruptFrame($"channel/block mismatch ({chCount}ch, bs={blockSize})", _bufStreamStart + frameStart);
                _bufPos++;
                if (--resyncLimit <= 0) return 0;
                continue;
            }

            if (_channelBufs[0].Length < blockSize)
                for (int c = 0; c < Channels; c++) _channelBufs[c] = new int[blockSize];

            var br = new BitReader(span, headerLen);
            bool ok = true;
            for (int c = 0; c < chCount; c++)
            {
                int subBps = bps;
                if ((chAssign == 8 && c == 1) || (chAssign == 9 && c == 0) || (chAssign == 10 && c == 1))
                    subBps++; // side channel needs +1 bit
                if (!DecodeSubframe(ref br, _channelBufs[c], blockSize, subBps))
                {
                    ok = false;
                    break;
                }
            }

            if (ok)
            {
                br.AlignToByte();
                int frameBodyEnd = br.BytePos;
                if (frameBodyEnd + 2 <= span.Length)
                {
                    ushort expectedCrc = BinaryPrimitives.ReadUInt16BigEndian(span.Slice(frameBodyEnd, 2));
                    ushort actualCrc = ComputeCrc16(span.Slice(0, frameBodyEnd));
                    if (expectedCrc == actualCrc)
                    {
                        Decorrelate(chAssign, blockSize);
                        _bufPos = frameStart + frameBodyEnd + 2;
                        frameFirstSample = varBlock ? number : number * MinBlockSize;
                        return blockSize;
                    }
                }
            }

            // Frame failed decode or CRC-16: skip 1 byte and resync to the next valid frame
            NoteCorruptFrame(ok ? "CRC-16 mismatch" : "subframe decode error", _bufStreamStart + frameStart);
            _bufPos = frameStart + 1;
            if (--resyncLimit <= 0) return 0;
        }
    }

    private void Decorrelate(int chAssign, int blockSize)
    {
        if (chAssign == 8) // left-side
        {
            int[] l = _channelBufs[0], s = _channelBufs[1];
            for (int i = 0; i < blockSize; i++) s[i] = l[i] - s[i];
        }
        else if (chAssign == 9) // right-side
        {
            int[] s = _channelBufs[0], r = _channelBufs[1];
            for (int i = 0; i < blockSize; i++) s[i] = s[i] + r[i];
        }
        else if (chAssign == 10) // mid-side
        {
            int[] m = _channelBufs[0], s = _channelBufs[1];
            for (int i = 0; i < blockSize; i++)
            {
                int side = s[i];
                int mid = (m[i] << 1) | (side & 1);
                m[i] = (mid + side) >> 1;
                s[i] = (mid - side) >> 1;
            }
        }
    }

    private static int ChannelsFromAssignment(int chAssign) => chAssign <= 7 ? chAssign + 1 : (chAssign <= 10 ? 2 : 0);

    private bool TryParseFrameHeader(
        ReadOnlySpan<byte> data,
        out int headerLen,
        out int blockSize,
        out int sampleRate,
        out int chAssign,
        out int bps,
        out long number,
        out bool varBlock)
    {
        headerLen = 0; blockSize = 0; sampleRate = 0; chAssign = 0; bps = 0; number = 0; varBlock = false;
        if (data.Length < 6) return false;
        if (data[0] != 0xFF || (data[1] & 0xFE) != 0xF8) return false;
        varBlock = (data[1] & 1) != 0;

        int bsCode = data[2] >> 4;
        int srCode = data[2] & 0x0F;
        chAssign = data[3] >> 4;
        int ssCode = (data[3] >> 1) & 0x07;
        if ((data[3] & 1) != 0) return false;
        if (bsCode == 0 || srCode == 15 || chAssign > 10 || ssCode == 3 || ssCode == 7) return false;

        int pos = 4;
        if (!TryReadUtf8Number(data, ref pos, out number)) return false;

        blockSize = bsCode switch
        {
            1 => 192,
            >= 2 and <= 5 => 576 << (bsCode - 2),
            6 => pos < data.Length ? data[pos++] + 1 : -1,
            7 => pos + 1 < data.Length ? BinaryPrimitives.ReadUInt16BigEndian(data.Slice(pos, 2)) + 1 : -1,
            >= 8 and <= 15 => 256 << (bsCode - 8),
            _ => -1,
        };
        if (bsCode == 7) pos += 2;
        if (blockSize <= 0) return false;

        sampleRate = srCode switch
        {
            0 => SampleRate,
            1 => 88200,
            2 => 176400,
            3 => 192000,
            4 => 8000,
            5 => 16000,
            6 => 22050,
            7 => 24000,
            8 => 32000,
            9 => 44100,
            10 => 48000,
            11 => 96000,
            12 => pos < data.Length ? data[pos++] * 1000 : -1,
            13 => pos + 1 < data.Length ? BinaryPrimitives.ReadUInt16BigEndian(data.Slice(pos, 2)) : -1,
            14 => pos + 1 < data.Length ? BinaryPrimitives.ReadUInt16BigEndian(data.Slice(pos, 2)) * 10 : -1,
            _ => -1,
        };
        if (srCode is 13 or 14) pos += 2;
        if (sampleRate <= 0) return false;

        bps = ssCode switch
        {
            0 => BitsPerSample,
            1 => 8,
            2 => 12,
            4 => 16,
            5 => 20,
            6 => 24,
            _ => -1,
        };
        if (bps <= 0) return false;

        if (pos >= data.Length) return false;
        byte crc = ComputeCrc8(data.Slice(0, pos));
        if (crc != data[pos]) return false;
        headerLen = pos + 1;
        return true;
    }

    private static bool TryReadUtf8Number(ReadOnlySpan<byte> data, ref int pos, out long value)
    {
        value = 0;
        if (pos >= data.Length) return false;
        byte first = data[pos++];
        if ((first & 0x80) == 0) { value = first; return true; }
        int extra;
        if ((first & 0xE0) == 0xC0) { value = first & 0x1F; extra = 1; }
        else if ((first & 0xF0) == 0xE0) { value = first & 0x0F; extra = 2; }
        else if ((first & 0xF8) == 0xF0) { value = first & 0x07; extra = 3; }
        else if ((first & 0xFC) == 0xF8) { value = first & 0x03; extra = 4; }
        else if ((first & 0xFE) == 0xFC) { value = first & 0x01; extra = 5; }
        else if (first == 0xFE) { value = 0; extra = 6; }
        else return false;

        if (pos + extra > data.Length) return false;
        for (int i = 0; i < extra; i++)
        {
            byte b = data[pos++];
            if ((b & 0xC0) != 0x80) return false;
            value = (value << 6) | (uint)(b & 0x3F);
        }
        return true;
    }

    private bool DecodeSubframe(ref BitReader br, int[] output, int blockSize, int bps)
    {
        if (!br.HasBits(8)) return false;
        if (br.ReadUInt(1) != 0) return false;
        int type = (int)br.ReadUInt(6);
        int wasted = 0;
        if (br.ReadUInt(1) != 0)
        {
            wasted = 1;
            while (br.ReadUInt(1) == 0)
            {
                wasted++;
                if (wasted >= bps || !br.HasBits(1)) return false;
            }
            bps -= wasted;
        }

        if (type == 0) // CONSTANT
        {
            int val = br.ReadSigned(bps);
            output.AsSpan(0, blockSize).Fill(val);
        }
        else if (type == 1) // VERBATIM
        {
            for (int i = 0; i < blockSize; i++) output[i] = br.ReadSigned(bps);
        }
        else if (type >= 8 && type <= 12) // FIXED
        {
            int order = type - 8;
            if (order > blockSize) return false;
            for (int i = 0; i < order; i++) output[i] = br.ReadSigned(bps);
            if (!DecodeResidual(ref br, output, blockSize, order)) return false;
            RestoreFixed(output, blockSize, order);
        }
        else if (type >= 32 && type <= 63) // LPC
        {
            int order = type - 31;
            if (order > blockSize) return false;
            for (int i = 0; i < order; i++) output[i] = br.ReadSigned(bps);
            int precision = (int)br.ReadUInt(4) + 1;
            if (precision == 16) return false;
            int shift = br.ReadSigned(5);
            if (shift < 0) return false;
            for (int i = 0; i < order; i++) _lpcCoeffs[i] = br.ReadSigned(precision);
            if (!DecodeResidual(ref br, output, blockSize, order)) return false;
            RestoreLpc(output, blockSize, order, shift);
        }
        else
        {
            return false;
        }

        if (wasted > 0)
            for (int i = 0; i < blockSize; i++) output[i] <<= wasted;
        return !br.Overflowed;
    }

    private static void RestoreFixed(int[] s, int n, int order)
    {
        switch (order)
        {
            case 0: break;
            case 1:
                for (int i = 1; i < n; i++) s[i] += s[i - 1];
                break;
            case 2:
                for (int i = 2; i < n; i++) s[i] += 2 * s[i - 1] - s[i - 2];
                break;
            case 3:
                for (int i = 3; i < n; i++) s[i] += 3 * (s[i - 1] - s[i - 2]) + s[i - 3];
                break;
            case 4:
                for (int i = 4; i < n; i++) s[i] += 4 * (s[i - 1] + s[i - 3]) - 6 * s[i - 2] - s[i - 4];
                break;
        }
    }

    private void RestoreLpc(int[] s, int n, int order, int shift)
    {
        int[] c = _lpcCoeffs;
        // 64-bit accumulator prevents overflow on 24-bit and 25-bit side-channel LPC
        for (int i = order; i < n; i++)
        {
            long sum = 0;
            for (int j = 0; j < order; j++)
                sum += (long)c[j] * s[i - j - 1];
            s[i] += (int)(sum >> shift);
        }
    }

    private static bool DecodeResidual(ref BitReader br, int[] output, int blockSize, int predictorOrder)
    {
        int method = (int)br.ReadUInt(2);
        if (method > 1) return false;
        int paramBits = method == 0 ? 4 : 5;
        int escapeParam = method == 0 ? 15 : 31;
        int partitionOrder = (int)br.ReadUInt(4);
        int numPartitions = 1 << partitionOrder;
        if (blockSize % numPartitions != 0) return false;
        int partSamples = blockSize >> partitionOrder;
        if (partSamples < predictorOrder) return false;

        int outIdx = predictorOrder;
        for (int p = 0; p < numPartitions; p++)
        {
            int count = p == 0 ? partSamples - predictorOrder : partSamples;
            int riceParam = (int)br.ReadUInt(paramBits);
            if (riceParam == escapeParam)
            {
                int rawBits = (int)br.ReadUInt(5);
                if (rawBits == 0)
                    output.AsSpan(outIdx, count).Clear();
                else
                    for (int i = 0; i < count; i++) output[outIdx + i] = br.ReadSigned(rawBits);
                outIdx += count;
            }
            else
            {
                for (int i = 0; i < count; i++)
                {
                    uint q = br.ReadUnary();
                    uint r = riceParam > 0 ? br.ReadUInt(riceParam) : 0;
                    uint u = (q << riceParam) | r;
                    output[outIdx++] = (int)(u >> 1) ^ -(int)(u & 1);
                }
            }
            if (br.Overflowed) return false;
        }
        return true;
    }

    public void Dispose()
    {
        if (_ownsStream) _stream.Dispose();
    }

    private ref struct BitReader
    {
        private readonly ReadOnlySpan<byte> _data;
        private int _bytePos;
        private ulong _bitBuf;
        private int _bitsInBuf;
        public bool Overflowed;

        public BitReader(ReadOnlySpan<byte> data, int startByte)
        {
            _data = data;
            _bytePos = startByte;
            _bitBuf = 0;
            _bitsInBuf = 0;
            Overflowed = false;
            Refill();
        }

        public readonly int BytePos => _bytePos - (_bitsInBuf >> 3);
        public readonly bool HasBits(int count) => _bitsInBuf + ((_data.Length - _bytePos) << 3) >= count;

        private void Refill()
        {
            while (_bitsInBuf <= 56 && _bytePos < _data.Length)
            {
                _bitBuf = (_bitBuf << 8) | _data[_bytePos++];
                _bitsInBuf += 8;
            }
        }

        public uint ReadUInt(int bits)
        {
            if (bits == 0) return 0;
            if (_bitsInBuf < bits) Refill();
            if (_bitsInBuf < bits) { Overflowed = true; _bitsInBuf = 0; return 0; }
            _bitsInBuf -= bits;
            return (uint)((_bitBuf >> _bitsInBuf) & ((1UL << bits) - 1));
        }

        public int ReadSigned(int bits)
        {
            uint u = ReadUInt(bits);
            int shift = 32 - bits;
            return ((int)(u << shift)) >> shift;
        }

        public uint ReadUnary()
        {
            uint zeros = 0;
            while (true)
            {
                if (_bitsInBuf == 0)
                {
                    Refill();
                    if (_bitsInBuf == 0) { Overflowed = true; return 0; }
                }
                ulong aligned = _bitBuf << (64 - _bitsInBuf);
                int lz = BitOperations.LeadingZeroCount(aligned);
                if (lz < _bitsInBuf)
                {
                    zeros += (uint)lz;
                    _bitsInBuf -= (lz + 1);
                    return zeros;
                }
                zeros += (uint)_bitsInBuf;
                _bitsInBuf = 0;
            }
        }

        public void AlignToByte()
        {
            int rem = _bitsInBuf & 7;
            if (rem > 0) _bitsInBuf -= rem;
        }
    }
}
