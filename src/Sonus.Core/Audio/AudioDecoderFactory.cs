namespace Sonus.Core.Audio;

/// <summary>
/// Detects container/codec from stream magic bytes (never trusting URL suffixes alone, since servers
/// may transcode or serve WAV/Opus/FLAC under generic Subsonic stream URLs) and creates the matching
/// built-in pure C# decoder.
/// </summary>
public static class AudioDecoderFactory
{
    /// <summary>
    /// Sniffs the start of <paramref name="stream"/>, rewinds to offset 0, and constructs an <see cref="IAudioDecoder"/>.
    /// Throws <see cref="UnsupportedAudioFormatException"/> for formats not decoded natively (e.g. M4A/AAC/ALAC/Vorbis).
    /// </summary>
    public static IAudioDecoder Open(Stream stream, string? contentType = null, bool ownsStream = false, Action<string>? onDiagnostic = null)
    {
        if (stream.Position != 0) stream.Seek(0, SeekOrigin.Begin);
        byte[] sniff = new byte[64];
        int got = 0;
        while (got < sniff.Length)
        {
            int n = stream.Read(sniff, got, sniff.Length - got);
            if (n == 0) break;
            got += n;
        }
        if (got < 4) throw new InvalidDataException("Audio stream is empty or truncated.");

        AudioFormat fmt = DetectFormat(sniff.AsSpan(0, got), contentType);

        // If ID3v2 header precedes audio, peek right past the tag to distinguish ID3+FLAC from ID3+MP3
        if (fmt == AudioFormat.Mp3 && got >= 10 && sniff[0] == (byte)'I' && sniff[1] == (byte)'D' && sniff[2] == (byte)'3')
        {
            int id3Size = ((sniff[6] & 0x7F) << 21) | ((sniff[7] & 0x7F) << 14) | ((sniff[8] & 0x7F) << 7) | (sniff[9] & 0x7F);
            int afterId3 = 10 + id3Size;
            if (afterId3 >= 10 && afterId3 <= 120 * 1024 && stream.CanSeek)
            {
                stream.Seek(afterId3, SeekOrigin.Begin);
                Span<byte> peek = stackalloc byte[4];
                if (stream.Read(peek) == 4 && peek.SequenceEqual("fLaC"u8))
                    fmt = AudioFormat.Flac;
            }
        }

        stream.Seek(0, SeekOrigin.Begin);

        IAudioDecoder decoder = fmt switch
        {
            AudioFormat.Flac => new FlacDecoder(stream, ownsStream),
            AudioFormat.Opus => new OggOpusDecoder(stream, ownsStream),
            AudioFormat.Wav => new WavDecoder(stream, ownsStream),
            AudioFormat.Mp3 => new Mp3Decoder(stream, ownsStream),
            _ => throw new UnsupportedAudioFormatException($"Format not handled by built-in decoders (content-type={contentType ?? "unknown"}, magic={Convert.ToHexString(sniff.AsSpan(0, Math.Min(12, got)))})."),
        };
        decoder.OnDiagnostic = onDiagnostic;
        return decoder;
    }

    public static AudioFormat DetectFormat(ReadOnlySpan<byte> header, string? contentType = null)
    {
        if (header.Length >= 4 && header[..4].SequenceEqual("fLaC"u8))
            return AudioFormat.Flac;

        if (header.Length >= 12 && header[..4].SequenceEqual("RIFF"u8) && header.Slice(8, 4).SequenceEqual("WAVE"u8))
            return AudioFormat.Wav;

        if (header.Length >= 4 && header[..4].SequenceEqual("OggS"u8))
        {
            // Distinguish Ogg/Opus from Ogg/Vorbis or Ogg/FLAC by checking BOS packet signature
            if (header.Length >= 28)
            {
                int segs = header[26];
                int bodyOff = 27 + segs;
                if (bodyOff + 8 <= header.Length && header.Slice(bodyOff, 8).SequenceEqual("OpusHead"u8))
                    return AudioFormat.Opus;
            }
            if (contentType is not null && contentType.Contains("opus", StringComparison.OrdinalIgnoreCase))
                return AudioFormat.Opus;
            return AudioFormat.Unknown; // e.g. Ogg Vorbis -> let fallback handle it
        }

        // ISO BMFF (M4A / MP4 / AAC / ALAC): explicitly unknown so we don't misidentify as MP3
        if (header.Length >= 8 && header.Slice(4, 4).SequenceEqual("ftyp"u8))
            return AudioFormat.Unknown;

        if (header.Length >= 3 && header[..3].SequenceEqual("ID3"u8))
            return AudioFormat.Mp3;

        // Raw MPEG audio frame sync: 11 set bits (0xFFE0), MPEG version != 01, layer != 00
        if (header.Length >= 2 && header[0] == 0xFF && (header[1] & 0xE0) == 0xE0 &&
            ((header[1] >> 3) & 3) != 1 && ((header[1] >> 1) & 3) != 0)
            return AudioFormat.Mp3;

        if (contentType is not null)
        {
            if (contentType.Contains("flac", StringComparison.OrdinalIgnoreCase)) return AudioFormat.Flac;
            if (contentType.Contains("opus", StringComparison.OrdinalIgnoreCase)) return AudioFormat.Opus;
            if (contentType.Contains("wav", StringComparison.OrdinalIgnoreCase)) return AudioFormat.Wav;
            if (contentType.Contains("mpeg", StringComparison.OrdinalIgnoreCase) || contentType.Contains("mp3", StringComparison.OrdinalIgnoreCase)) return AudioFormat.Mp3;
        }

        return AudioFormat.Unknown;
    }
}
