using System.Buffers.Binary;

namespace Sonus.Core.Audio;

/// <summary>
/// Pure C# RIFF/WAVE PCM (8/16/24/32-bit integer and 32-bit IEEE float, including WAVE_FORMAT_EXTENSIBLE)
/// decoder with O(1) sample-exact seeking and sequential streaming fallback.
/// </summary>
public sealed class WavDecoder : IAudioDecoder
{
    private readonly Stream _stream;
    private readonly bool _ownsStream;
    private readonly int _audioFormat; // 1 = PCM int, 3 = IEEE float
    private readonly int _blockAlign;
    private readonly long _dataOffset;
    private readonly long _dataLength;
    private readonly byte[] _rawBuf = new byte[65536];

    public AudioFormat Format => AudioFormat.Wav;
    public int SampleRate { get; }
    public int Channels { get; }
    public int BitsPerSample { get; }
    public long TotalSamples { get; }
    public long CurrentSample { get; private set; }
    public double DurationSeconds => SampleRate > 0 && TotalSamples > 0 ? (double)TotalSamples / SampleRate : 0;
    public bool CanSeek => _stream.CanSeek;
    public int CorruptedFramesSkipped => 0;
    public Action<string>? OnDiagnostic { get; set; }

    public WavDecoder(Stream stream, bool ownsStream = false)
    {
        _stream = stream;
        _ownsStream = ownsStream;
        if (_stream.Position != 0) _stream.Seek(0, SeekOrigin.Begin);

        Span<byte> hdr = stackalloc byte[12];
        ReadExact(hdr);
        if (!hdr.Slice(0, 4).SequenceEqual("RIFF"u8) || !hdr.Slice(8, 4).SequenceEqual("WAVE"u8))
            throw new InvalidDataException("Not a RIFF/WAVE stream.");

        int fmt = 0, ch = 0, sr = 0, ba = 0, bps = 0;
        long dataOff = -1, dataLen = 0;
        long bytesRead = 12;
        Span<byte> chunkHdr = stackalloc byte[8];
        while (TryReadExact(chunkHdr))
        {
            bytesRead += 8;
            uint len = BinaryPrimitives.ReadUInt32LittleEndian(chunkHdr.Slice(4, 4));
            if (chunkHdr.Slice(0, 4).SequenceEqual("fmt "u8))
            {
                if (len < 16) throw new InvalidDataException("Short WAV fmt chunk.");
                byte[] fmtBuf = new byte[len];
                ReadExact(fmtBuf);
                bytesRead += len;
                fmt = BinaryPrimitives.ReadUInt16LittleEndian(fmtBuf.AsSpan(0, 2));
                ch = BinaryPrimitives.ReadUInt16LittleEndian(fmtBuf.AsSpan(2, 2));
                sr = (int)BinaryPrimitives.ReadUInt32LittleEndian(fmtBuf.AsSpan(4, 4));
                ba = BinaryPrimitives.ReadUInt16LittleEndian(fmtBuf.AsSpan(12, 2));
                bps = BinaryPrimitives.ReadUInt16LittleEndian(fmtBuf.AsSpan(14, 2));
                if (fmt == 0xFFFE && len >= 40) // WAVE_FORMAT_EXTENSIBLE
                    fmt = BinaryPrimitives.ReadUInt16LittleEndian(fmtBuf.AsSpan(24, 2));
                if ((len & 1) != 0) { SkipBytes(1); bytesRead++; }
            }
            else if (chunkHdr.Slice(0, 4).SequenceEqual("data"u8))
            {
                dataOff = bytesRead;
                dataLen = len;
                break;
            }
            else
            {
                long skip = len + (len & 1);
                SkipBytes(skip);
                bytesRead += skip;
            }
        }

        if (dataOff < 0 || ch <= 0 || sr <= 0 || ba <= 0 || fmt is not (1 or 3))
            throw new InvalidDataException($"Unsupported WAV format (fmt={fmt}, ch={ch}, sr={sr}, bps={bps}).");

        _audioFormat = fmt;
        Channels = ch;
        SampleRate = sr;
        _blockAlign = ba;
        BitsPerSample = bps;
        _dataOffset = dataOff;

        if (_stream.CanSeek && _stream.Length > dataOff)
        {
            long maxLen = _stream.Length - dataOff;
            _dataLength = (dataLen == 0 || dataLen == uint.MaxValue) ? maxLen : Math.Min(dataLen, maxLen);
        }
        else
        {
            _dataLength = (dataLen == uint.MaxValue) ? long.MaxValue : dataLen;
        }
        TotalSamples = _dataLength == long.MaxValue ? 0 : _dataLength / _blockAlign;
    }

    private void SkipBytes(long count)
    {
        if (count <= 0) return;
        if (_stream.CanSeek) { _stream.Seek(count, SeekOrigin.Current); return; }
        byte[] tmp = new byte[Math.Min(count, 8192)];
        while (count > 0)
        {
            int n = _stream.Read(tmp, 0, (int)Math.Min(tmp.Length, count));
            if (n == 0) throw new EndOfStreamException("Unexpected EOF skipping WAV chunk.");
            count -= n;
        }
    }

    private void ReadExact(Span<byte> dest)
    {
        if (!TryReadExact(dest)) throw new EndOfStreamException("Unexpected EOF in WAV.");
    }

    private bool TryReadExact(Span<byte> dest)
    {
        int got = 0;
        while (got < dest.Length)
        {
            int n = _stream.Read(dest.Slice(got));
            if (n == 0) return false;
            got += n;
        }
        return true;
    }

    public void SeekSample(long targetSample)
    {
        if (!_stream.CanSeek)
        {
            if (targetSample == 0) { CurrentSample = 0; return; }
            throw new NotSupportedException("Underlying WAV stream is not seekable.");
        }
        targetSample = Math.Clamp(targetSample, 0, TotalSamples);
        _stream.Seek(_dataOffset + targetSample * _blockAlign, SeekOrigin.Begin);
        CurrentSample = targetSample;
    }

    public int ReadFloats(Span<float> dest)
    {
        long remFrames = TotalSamples > 0 ? TotalSamples - CurrentSample : long.MaxValue;
        if (remFrames <= 0 || dest.Length < Channels) return 0;
        int wantFrames = (int)Math.Min(remFrames, Math.Min(dest.Length / Channels, _rawBuf.Length / _blockAlign));
        int wantBytes = wantFrames * _blockAlign;
        int got = 0;
        while (got < wantBytes)
        {
            int n = _stream.Read(_rawBuf, got, wantBytes - got);
            if (n == 0) break;
            got += n;
        }
        int frames = got / _blockAlign;
        if (frames == 0) return 0;
        int totalValues = frames * Channels;
        int bps = BitsPerSample;

        if (_audioFormat == 3 && bps == 32)
        {
            for (int i = 0; i < totalValues; i++)
                dest[i] = BinaryPrimitives.ReadSingleLittleEndian(_rawBuf.AsSpan(i * 4, 4));
        }
        else if (bps == 8)
        {
            for (int i = 0; i < totalValues; i++)
                dest[i] = (_rawBuf[i] - 128) / 128.0f;
        }
        else if (bps == 16)
        {
            for (int i = 0; i < totalValues; i++)
                dest[i] = BinaryPrimitives.ReadInt16LittleEndian(_rawBuf.AsSpan(i * 2, 2)) / 32768.0f;
        }
        else if (bps == 24)
        {
            for (int i = 0; i < totalValues; i++)
            {
                int o = i * 3;
                int v = _rawBuf[o] | (_rawBuf[o + 1] << 8) | ((sbyte)_rawBuf[o + 2] << 16);
                dest[i] = v / 8388608.0f;
            }
        }
        else if (bps == 32)
        {
            for (int i = 0; i < totalValues; i++)
                dest[i] = (float)(BinaryPrimitives.ReadInt32LittleEndian(_rawBuf.AsSpan(i * 4, 4)) / 2147483648.0);
        }

        CurrentSample += frames;
        return totalValues;
    }

    public void Dispose()
    {
        if (_ownsStream) _stream.Dispose();
    }
}
