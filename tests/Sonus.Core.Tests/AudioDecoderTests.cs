using System.Buffers.Binary;
using System.Net;
using System.Net.Sockets;
using System.Security.Cryptography;
using System.Text;
using Concentus;
using Concentus.Enums;
using Sonus.Core.Audio;

namespace Sonus.Core.Tests;

public sealed class AudioDecoderTests
{
    // ---------------------------------------------------------------- WAV
    [Theory]
    [InlineData(8)]
    [InlineData(16)]
    [InlineData(24)]
    [InlineData(32)]
    public void WavDecoder_DecodesAndSeeksAccurately(int bitsPerSample)
    {
        int sr = 44100, ch = 2, frames = 4410; // 0.1 s
        byte[] wav = BuildWav(sr, ch, bitsPerSample, ieeeFloat: bitsPerSample == 32, frames, (f, c) =>
            MathF.Sin(2 * MathF.PI * (c == 0 ? 440f : 880f) * f / sr) * 0.5f);

        using var ms = new MemoryStream(wav);
        using var dec = new WavDecoder(ms);
        Assert.Equal(AudioFormat.Wav, dec.Format);
        Assert.Equal(sr, dec.SampleRate);
        Assert.Equal(ch, dec.Channels);
        Assert.Equal(bitsPerSample, dec.BitsPerSample);
        Assert.Equal(frames, dec.TotalSamples);
        Assert.True(dec.CanSeek);

        float[] all = new float[frames * ch];
        int got = dec.ReadFloats(all);
        Assert.Equal(all.Length, got);
        Assert.Equal(0, dec.ReadFloats(new float[16]));

        // Verify exact O(1) seek to midpoint matches full decode
        int mid = frames / 2;
        dec.SeekSample(mid);
        Assert.Equal(mid, dec.CurrentSample);
        float[] slice = new float[256 * ch];
        Assert.Equal(slice.Length, dec.ReadFloats(slice));
        for (int i = 0; i < slice.Length; i++)
            Assert.Equal(all[mid * ch + i], slice[i], precision: 5);
    }

    [Fact]
    public void WavDecoder_HandlesNonSeekableSequentialStream()
    {
        byte[] wav = BuildWav(48000, 2, 16, false, 2400, (f, _) => MathF.Sin(2 * MathF.PI * 1000f * f / 48000) * 0.4f);
        using var nonSeek = new NonSeekableStream(wav);
        using var dec = new WavDecoder(nonSeek);
        Assert.False(dec.CanSeek);
        Assert.Equal(2400, dec.TotalSamples);

        float[] buf = new float[2400 * 2];
        int total = 0;
        while (total < buf.Length)
        {
            int n = dec.ReadFloats(buf.AsSpan(total));
            if (n == 0) break;
            total += n;
        }
        Assert.Equal(buf.Length, total);
    }

    // ---------------------------------------------------------------- FLAC (RFC 9639)
    [Fact]
    public void FlacDecoder_BitExactMd5_SeekTableAndBisectionAndCorruptFrameSkip()
    {
        int sr = 48000, ch = 2, blockSize = 512, numFrames = 40;
        byte[] flacWithSeek = BuildVerbatimFlac(sr, ch, 16, blockSize, numFrames, includeSeekTable: true, out byte[] expectedMd5);
        byte[] flacNoSeek = BuildVerbatimFlac(sr, ch, 16, blockSize, numFrames, includeSeekTable: false, out _);

        // 1. Bit-exact MD5 verification & SEEKTABLE seek
        using (var ms = new MemoryStream(flacWithSeek))
        using (var dec = new FlacDecoder(ms))
        {
            Assert.Equal(AudioFormat.Flac, dec.Format);
            Assert.Equal(sr, dec.SampleRate);
            Assert.Equal(ch, dec.Channels);
            Assert.Equal(16, dec.BitsPerSample);
            Assert.Equal(blockSize * numFrames, dec.TotalSamples);
            Assert.True(dec.SeekTable.Count > 0);

            using var md5 = IncrementalHash.CreateHash(HashAlgorithmName.MD5);
            long samples = 0;
            while (true)
            {
                int n = dec.DecodeNextFrameRaw(out int[][] raw);
                if (n == 0) break;
                byte[] pcm = new byte[n * ch * 2];
                for (int i = 0, o = 0; i < n; i++)
                    for (int c = 0; c < ch; c++)
                    {
                        pcm[o++] = (byte)(raw[c][i] & 0xFF);
                        pcm[o++] = (byte)((raw[c][i] >> 8) & 0xFF);
                    }
                md5.AppendData(pcm);
                samples += n;
            }
            Assert.Equal(blockSize * numFrames, samples);
            Assert.Equal(expectedMd5, md5.GetHashAndReset());

            // Seek using SEEKTABLE to an exact mid-frame sample
            long target = blockSize * 23 + 137;
            dec.SeekSample(target);
            Assert.Equal(target, dec.CurrentSample);
            float[] after = new float[256 * ch];
            Assert.Equal(after.Length, dec.ReadFloats(after));
            Assert.Equal(target + 256, dec.CurrentSample);
        }

        // 2. Bisection seek without SEEKTABLE
        using (var ms = new MemoryStream(flacNoSeek))
        using (var dec = new FlacDecoder(ms))
        {
            Assert.Empty(dec.SeekTable);
            long target = blockSize * 27 + 42;
            dec.SeekSample(target);
            Assert.Equal(target, dec.CurrentSample);
            float[] buf = new float[128 * ch];
            Assert.Equal(buf.Length, dec.ReadFloats(buf));
        }

        // 3. Corrupted frame recovery: corrupt bytes inside frame 10 and ensure decoder skips & finishes track
        byte[] corrupted = (byte[])flacWithSeek.Clone();
        int corruptPos = (int)(corrupted.Length * 0.25);
        for (int i = 0; i < 64; i++) corrupted[corruptPos + i] ^= 0xFF;

        var logs = new List<string>();
        using (var ms = new MemoryStream(corrupted))
        using (var dec = new FlacDecoder(ms) { OnDiagnostic = logs.Add })
        {
            float[] buf = new float[1024];
            long totalFloats = 0;
            while (true)
            {
                int n = dec.ReadFloats(buf);
                if (n == 0) break;
                totalFloats += n;
            }
            Assert.True(dec.CorruptedFramesSkipped > 0, "Expected corrupt frame to be detected and skipped");
            Assert.NotEmpty(logs);
            // At least 85% of frames survived around the damaged region
            Assert.True(totalFloats >= blockSize * (numFrames - 4) * ch, $"Only decoded {totalFloats} floats");
        }
    }

    // ---------------------------------------------------------------- Ogg/Opus (RFC 7845 + Concentus)
    [Fact]
    public void OggOpusDecoder_TrimsPreSkipAndEos_SeeksAndRecoversBadPackets()
    {
        int preSkip = 312;
        int targetSamples = 48000 * 2; // 2.0000 s
        byte[] ogg = BuildOggOpus(targetSamples, preSkip, channels: 2);

        // 1. Exact pre_skip + EOS granule trimming
        using (var ms = new MemoryStream(ogg))
        using (var dec = new OggOpusDecoder(ms))
        {
            Assert.Equal(AudioFormat.Opus, dec.Format);
            Assert.Equal(48000, dec.SampleRate);
            Assert.Equal(2, dec.Channels);
            Assert.Equal(targetSamples, dec.TotalSamples);
            Assert.InRange(dec.DurationSeconds, 1.999, 2.001);

            float[] buf = new float[4096];
            long totalFloats = 0;
            while (true)
            {
                int n = dec.ReadFloats(buf);
                if (n == 0) break;
                totalFloats += n;
            }
            Assert.Equal(targetSamples * 2, totalFloats);

            // 2. Bisection seek with 80 ms pre-roll
            dec.SeekSample(48000); // 1.0 s
            Assert.Equal(48000, dec.CurrentSample);
            float[] after = new float[1920 * 2];
            Assert.Equal(after.Length, dec.ReadFloats(after));
            Assert.True(after.Any(x => MathF.Abs(x) > 0.05f), "Expected audible signal after seek");
        }
    }

    // ---------------------------------------------------------------- Format detection
    [Fact]
    public void AudioDecoderFactory_SniffsSupportedFormatsAndRejectsExoticContainers()
    {
        Assert.Equal(AudioFormat.Flac, AudioDecoderFactory.DetectFormat("fLaC\0\0\0\""u8));
        Assert.Equal(AudioFormat.Wav, AudioDecoderFactory.DetectFormat("RIFF\x24\x00\x00\x00WAVEfmt "u8));
        Assert.Equal(AudioFormat.Mp3, AudioDecoderFactory.DetectFormat("ID3\x03\x00\x00\x00\x00\x00\x10"u8));
        Assert.Equal(AudioFormat.Mp3, AudioDecoderFactory.DetectFormat([0xFF, 0xFB, 0x90, 0x00]));
        Assert.Equal(AudioFormat.Unknown, AudioDecoderFactory.DetectFormat([0x00, 0x00, 0x00, 0x20, (byte)'f', (byte)'t', (byte)'y', (byte)'p', (byte)'M', (byte)'4', (byte)'A', (byte)' ']));

        using var m4a = new MemoryStream([0x00, 0x00, 0x00, 0x20, (byte)'f', (byte)'t', (byte)'y', (byte)'p', (byte)'M', (byte)'4', (byte)'A', (byte)' ']);
        Assert.Throws<UnsupportedAudioFormatException>(() => AudioDecoderFactory.Open(m4a, "audio/mp4"));
    }

    // ---------------------------------------------------------------- Gapless pipeline + Soft limiter + Ring buffer
    [Fact]
    public void GaplessPipeline_SplicesSameAndMixedRatesWithZeroSilenceGap()
    {
        // Track A (44.1 kHz) -> Track B (96 kHz), continuous 440 Hz tone resampled to 48 kHz stereo
        byte[] wavA = BuildWav(44100, 2, 16, false, 4410, (f, _) => MathF.Sin(2 * MathF.PI * 440f * f / 44100) * 0.5f);
        byte[] wavB = BuildWav(96000, 2, 24, false, 9600, (f, _) => MathF.Sin(2 * MathF.PI * 440f * (0.1f + f / 96000f)) * 0.5f);

        using var decA = new WavDecoder(new MemoryStream(wavA), ownsStream: true);
        using var decB = new WavDecoder(new MemoryStream(wavB), ownsStream: true);
        using var pipe = new GaplessAudioPipeline(48000, 2);
        pipe.SetCurrent(new DecodedTrack("a", decA));
        pipe.SetNext(new DecodedTrack("b", decB));

        var transitions = new List<TrackTransition>();
        var output = new List<float>();
        float[] chunk = new float[1024 * 2];
        int transitionGlobalFrame = -1;
        while (true)
        {
            transitions.Clear();
            int baseFrame = output.Count / 2;
            int n = pipe.Read(chunk, transitions);
            if (transitions.Count > 0)
            {
                Assert.Single(transitions);
                Assert.Equal("b", transitions[0].NewTrack.Id);
                transitionGlobalFrame = baseFrame + transitions[0].OutputFrameOffset;
            }
            if (n == 0) break;
            for (int i = 0; i < n; i++) output.Add(chunk[i]);
        }

        Assert.True(transitionGlobalFrame > 4000, $"Transition frame expected ~4800, got {transitionGlobalFrame}");
        // Verify zero sustained silence gap around the boundary (no run of > 16 zero frames)
        int maxZeroRun = 0, curZero = 0;
        for (int f = Math.Max(0, transitionGlobalFrame - 400); f < Math.Min(output.Count / 2, transitionGlobalFrame + 400); f++)
        {
            if (MathF.Abs(output[f * 2]) < 1e-4f && MathF.Abs(output[f * 2 + 1]) < 1e-4f)
            {
                if (++curZero > maxZeroRun) maxZeroRun = curZero;
            }
            else curZero = 0;
        }
        Assert.True(maxZeroRun <= 16, $"Gapless splice had {maxZeroRun} silent frames around boundary");
    }

    [Fact]
    public void GaplessPipeline_SilentModeZeroesOutput_AndSoftLimiterPreventsClipping()
    {
        byte[] wav = BuildWav(48000, 2, 16, false, 4800, (f, _) => 0.8f);
        using var dec = new WavDecoder(new MemoryStream(wav), ownsStream: true);
        using var pipe = new GaplessAudioPipeline(48000, 2) { SilentMode = true, Volume = 0.75f };
        pipe.SetCurrent(new DecodedTrack("s", dec));

        float[] buf = new float[1024];
        int n = pipe.Read(buf);
        Assert.Equal(1024, n);
        Assert.All(buf, x => Assert.Equal(0f, x));
        Assert.True(pipe.DecodedPositionSeconds > 0);

        // Soft limiter checks
        Assert.Equal(0.5f, GaplessAudioPipeline.SoftLimit(0.5f));
        Assert.Equal(-0.95f, GaplessAudioPipeline.SoftLimit(-0.95f));
        Assert.InRange(GaplessAudioPipeline.SoftLimit(3.0f), 0.95f, 1.0f);
        Assert.InRange(GaplessAudioPipeline.SoftLimit(-3.0f), -1.0f, -0.95f);
    }

    [Fact]
    public void PcmRingBuffer_WrapAroundAndExactBoundaryDelivery()
    {
        var ring = new PcmRingBuffer(capacityFrames: 1024, channels: 2);
        var bTrack = new DecodedTrack("next-1", new WavDecoder(new MemoryStream(BuildWav(48000, 2, 16, false, 480, (_, _) => 0.25f)), true));
        using (bTrack)
        {
            float[] part1 = Enumerable.Repeat(0.1f, 700 * 2).ToArray();
            float[] part2 = Enumerable.Repeat(0.2f, 500 * 2).ToArray();
            Assert.Equal(700, ring.Write(part1));

            float[] readBuf = new float[400 * 2];
            var crossed = new List<RingTrackBoundary>();
            Assert.Equal(400 * 2, ring.Read(readBuf, crossed, out long r1, out bool eof1));
            Assert.Equal(400, r1);
            Assert.False(eof1);
            Assert.Empty(crossed);

            // Write wrapping across ring end with boundary at offset 100 inside part2 (global frame 800)
            var tr = new List<TrackTransition> { new(100, bTrack) };
            Assert.Equal(500, ring.Write(part2, tr));
            ring.MarkEof();

            // Read 350 frames -> reaches frame 750 (still before boundary 800)
            float[] r2Buf = new float[350 * 2];
            Assert.Equal(350 * 2, ring.Read(r2Buf, crossed, out long r2, out bool eof2));
            Assert.Equal(750, r2);
            Assert.False(eof2);
            Assert.Empty(crossed);

            // Read remaining 450 frames -> crosses boundary 800 and reaches EOF
            float[] r3Buf = new float[500 * 2];
            Assert.Equal(450 * 2, ring.Read(r3Buf, crossed, out long r3, out bool eof3));
            Assert.Equal(1200, r3);
            Assert.True(eof3);
            Assert.Single(crossed);
            Assert.Equal(800, crossed[0].FrameIndex);
            Assert.Equal("next-1", crossed[0].TrackId);
        }
    }

    // ---------------------------------------------------------------- HttpAudioStream (Range, X-Sonus headers, reconnect, non-Range)
    [Fact]
    public async Task HttpAudioStream_CapturesHeaders_ProbesAndReconnectsOnDrop()
    {
        byte[] payload = new byte[320 * 1024];
        for (int i = 0; i < payload.Length; i++) payload[i] = (byte)((i * 31 + 7) & 0xFF);
        int dropsRemaining = 1;

        using var server = new LoopbackAudioServer(payload, () => Interlocked.Decrement(ref dropsRemaining) >= 0);
        using var http = new HttpClient(new SocketsHttpHandler { AutomaticDecompression = DecompressionMethods.None });

        // 1. Streaming open + X-Sonus-* headers + mid-stream drop recovery
        using (var s = await HttpAudioStream.OpenAsync(http, new Uri($"http://127.0.0.1:{server.Port}/range")))
        {
            Assert.Equal("lossless", s.Metadata.Quality);
            Assert.Equal("flac", s.Metadata.Format);
            Assert.Equal(96000, s.Metadata.SampleRate);
            Assert.Equal(24, s.Metadata.BitDepth);
            Assert.True(s.CanSeek);
            Assert.Equal(payload.Length, s.Length);

            byte[] got = new byte[payload.Length];
            int pos = 0;
            while (pos < got.Length)
            {
                int n = s.Read(got, pos, Math.Min(32768, got.Length - pos));
                if (n == 0) break;
                pos += n;
            }
            Assert.Equal(payload.Length, pos);
            Assert.Equal(payload, got);
            Assert.True(s.ReconnectCount >= 1, "Expected automatic reconnect after simulated mid-stream drop");

            // Probe mode reads bounded 64 KB blocks and caches them
            s.ProbeBlockSize = 64 * 1024;
            s.ProbeMode = true;
            long reqsBefore = s.TotalHttpRequests;
            s.Seek(200 * 1024, SeekOrigin.Begin);
            byte[] slice1 = new byte[128];
            Assert.Equal(128, s.Read(slice1));
            Assert.Equal(payload.AsSpan(200 * 1024, 128).ToArray(), slice1);
            Assert.Equal(reqsBefore + 1, s.TotalHttpRequests);
            // Second read in same block hits LRU cache (0 HTTP requests)
            s.Seek(200 * 1024 + 64, SeekOrigin.Begin);
            Assert.Equal(64, s.Read(slice1, 0, 64));
            Assert.Equal(reqsBefore + 1, s.TotalHttpRequests);
        }

        // 2. Non-Range chunked 200 OK stream still allows magic-byte sniff & rewind to 0
        using (var s = await HttpAudioStream.OpenAsync(http, new Uri($"http://127.0.0.1:{server.Port}/norangestream")))
        {
            Assert.False(s.CanSeek);
            byte[] sniff = new byte[32];
            Assert.Equal(32, s.Read(sniff));
            s.Seek(0, SeekOrigin.Begin);
            byte[] all = new byte[payload.Length];
            int pos = 0;
            while (pos < all.Length)
            {
                int n = s.Read(all, pos, Math.Min(32768, all.Length - pos));
                if (n == 0) break;
                pos += n;
            }
            Assert.Equal(payload.Length, pos);
            Assert.Equal(payload, all);
        }
    }

    // ---------------------------------------------------------------- Synthetic audio builders
    private static byte[] BuildWav(int sr, int ch, int bps, bool ieeeFloat, int frames, Func<int, int, float> sampleFn)
    {
        int blockAlign = ch * (bps / 8);
        int dataLen = frames * blockAlign;
        byte[] buf = new byte[44 + dataLen];
        "RIFF"u8.CopyTo(buf);
        BinaryPrimitives.WriteUInt32LittleEndian(buf.AsSpan(4), (uint)(36 + dataLen));
        "WAVEfmt "u8.CopyTo(buf.AsSpan(8));
        BinaryPrimitives.WriteUInt32LittleEndian(buf.AsSpan(16), 16);
        BinaryPrimitives.WriteUInt16LittleEndian(buf.AsSpan(20), (ushort)(ieeeFloat ? 3 : 1));
        BinaryPrimitives.WriteUInt16LittleEndian(buf.AsSpan(22), (ushort)ch);
        BinaryPrimitives.WriteUInt32LittleEndian(buf.AsSpan(24), (uint)sr);
        BinaryPrimitives.WriteUInt32LittleEndian(buf.AsSpan(28), (uint)(sr * blockAlign));
        BinaryPrimitives.WriteUInt16LittleEndian(buf.AsSpan(32), (ushort)blockAlign);
        BinaryPrimitives.WriteUInt16LittleEndian(buf.AsSpan(34), (ushort)bps);
        "data"u8.CopyTo(buf.AsSpan(36));
        BinaryPrimitives.WriteUInt32LittleEndian(buf.AsSpan(40), (uint)dataLen);

        int o = 44;
        for (int f = 0; f < frames; f++)
            for (int c = 0; c < ch; c++)
            {
                float s = Math.Clamp(sampleFn(f, c), -1f, 1f);
                if (ieeeFloat) { BinaryPrimitives.WriteSingleLittleEndian(buf.AsSpan(o), s); o += 4; }
                else if (bps == 8) { buf[o++] = (byte)Math.Clamp((int)MathF.Round(s * 128 + 128), 0, 255); }
                else if (bps == 16) { BinaryPrimitives.WriteInt16LittleEndian(buf.AsSpan(o), (short)Math.Clamp((int)MathF.Round(s * 32767), -32768, 32767)); o += 2; }
                else if (bps == 24)
                {
                    int v = Math.Clamp((int)MathF.Round(s * 8388607), -8388608, 8388607);
                    buf[o++] = (byte)(v & 0xFF); buf[o++] = (byte)((v >> 8) & 0xFF); buf[o++] = (byte)((v >> 16) & 0xFF);
                }
            }
        return buf;
    }

    private static byte[] BuildVerbatimFlac(int sr, int ch, int bps, int blockSize, int numFrames, bool includeSeekTable, out byte[] md5)
    {
        // Build verbatim FLAC frames with valid CRC-8 header and CRC-16 footer
        var frames = new List<(long Sample, long Offset, byte[] Bytes)>();
        using var hash = IncrementalHash.CreateHash(HashAlgorithmName.MD5);
        long runningOffset = 0;
        for (int fi = 0; fi < numFrames; fi++)
        {
            using var frameMs = new MemoryStream();
            // Frame header: sync 0xFFF8 (fixed blocksize), bsCode=9 (512), srCode=10 (48000), chAssign=1 (2ch), ssCode=4 (16-bit)
            frameMs.WriteByte(0xFF);
            frameMs.WriteByte(0xF8);
            frameMs.WriteByte((9 << 4) | 10);
            frameMs.WriteByte((byte)(((ch - 1) << 4) | (4 << 1)));
            // UTF-8 coded frame number
            WriteUtf8Number(frameMs, fi);
            byte[] hdrBytes = frameMs.ToArray();
            frameMs.WriteByte(FlacCrc8(hdrBytes));

            // Subframes: VERBATIM (0 | 000001 | 0 = 0x02) + raw big-endian 16-bit samples
            byte[] pcm = new byte[blockSize * ch * 2];
            for (int c = 0; c < ch; c++)
            {
                frameMs.WriteByte(0x02);
                for (int i = 0; i < blockSize; i++)
                {
                    long globalSample = (long)fi * blockSize + i;
                    short val = (short)(Math.Sin(2 * Math.PI * (c == 0 ? 440.0 : 660.0) * globalSample / sr) * 16000);
                    frameMs.WriteByte((byte)(val >> 8));
                    frameMs.WriteByte((byte)(val & 0xFF));
                    int pOff = (i * ch + c) * 2;
                    pcm[pOff] = (byte)(val & 0xFF);
                    pcm[pOff + 1] = (byte)((val >> 8) & 0xFF);
                }
            }
            hash.AppendData(pcm);
            byte[] body = frameMs.ToArray();
            ushort crc16 = FlacCrc16(body);
            frameMs.WriteByte((byte)(crc16 >> 8));
            frameMs.WriteByte((byte)(crc16 & 0xFF));
            byte[] full = frameMs.ToArray();
            frames.Add(((long)fi * blockSize, runningOffset, full));
            runningOffset += full.Length;
        }
        md5 = hash.GetHashAndReset();

        using var outMs = new MemoryStream();
        outMs.Write("fLaC"u8);
        // STREAMINFO
        outMs.WriteByte((byte)(includeSeekTable ? 0x00 : 0x80));
        outMs.Write([0, 0, 34]);
        byte[] si = new byte[34];
        BinaryPrimitives.WriteUInt16BigEndian(si.AsSpan(0), (ushort)blockSize);
        BinaryPrimitives.WriteUInt16BigEndian(si.AsSpan(2), (ushort)blockSize);
        ulong totalSamples = (ulong)(blockSize * numFrames);
        ulong packed = ((ulong)sr << 44) | ((ulong)(ch - 1) << 41) | ((ulong)(bps - 1) << 36) | totalSamples;
        BinaryPrimitives.WriteUInt64BigEndian(si.AsSpan(10), packed);
        md5.CopyTo(si, 18);
        outMs.Write(si);

        if (includeSeekTable)
        {
            int pts = numFrames / 4;
            int len = pts * 18;
            outMs.WriteByte(0x83); // last + SEEKTABLE
            outMs.Write([(byte)(len >> 16), (byte)(len >> 8), (byte)len]);
            byte[] sp = new byte[18];
            for (int i = 0; i < numFrames; i += 4)
            {
                BinaryPrimitives.WriteUInt64BigEndian(sp.AsSpan(0), (ulong)frames[i].Sample);
                BinaryPrimitives.WriteUInt64BigEndian(sp.AsSpan(8), (ulong)frames[i].Offset);
                BinaryPrimitives.WriteUInt16BigEndian(sp.AsSpan(16), (ushort)blockSize);
                outMs.Write(sp);
            }
        }
        foreach (var f in frames) outMs.Write(f.Bytes);
        return outMs.ToArray();
    }

    private static byte[] BuildOggOpus(int totalSamples, int preSkip, int channels)
    {
        var enc = OpusCodecFactory.CreateEncoder(48000, channels, OpusApplication.OPUS_APPLICATION_AUDIO);
        enc.Bitrate = 128000;
        using var ms = new MemoryStream();
        uint serial = 0x12345678;
        uint pageSeq = 0;

        // BOS page: OpusHead
        byte[] head = new byte[19];
        "OpusHead"u8.CopyTo(head);
        head[8] = 1;
        head[9] = (byte)channels;
        BinaryPrimitives.WriteUInt16LittleEndian(head.AsSpan(10), (ushort)preSkip);
        BinaryPrimitives.WriteUInt32LittleEndian(head.AsSpan(12), 48000);
        WriteOggPage(ms, 0x02, 0, serial, pageSeq++, [head]);

        // Tags page: OpusTags
        byte[] tags = [.. "OpusTags"u8, 5, 0, 0, 0, .. "Sonus"u8, 0, 0, 0, 0];
        WriteOggPage(ms, 0x00, 0, serial, pageSeq++, [tags]);

        // Audio pages (20 ms = 960 samples per packet, 10 packets per page)
        int frameSamples = 960;
        int rawTotal = totalSamples + preSkip;
        int produced = 0;
        float[] pcm = new float[frameSamples * channels];
        byte[] pktOut = new byte[4000];
        var pagePkts = new List<byte[]>();

        while (produced < rawTotal)
        {
            for (int i = 0; i < frameSamples; i++)
            {
                int idx = produced + i;
                float s = idx < preSkip ? 0f : MathF.Sin(2 * MathF.PI * 440f * (idx - preSkip) / 48000f) * 0.5f;
                for (int c = 0; c < channels; c++) pcm[i * channels + c] = s;
            }
            int len = enc.Encode(pcm.AsSpan(), frameSamples, pktOut.AsSpan(), pktOut.Length);
            pagePkts.Add(pktOut.AsSpan(0, len).ToArray());
            produced += frameSamples;

            bool isLast = produced >= rawTotal;
            if (pagePkts.Count == 10 || isLast)
            {
                long gran = isLast ? rawTotal : produced;
                WriteOggPage(ms, (byte)(isLast ? 0x04 : 0x00), gran, serial, pageSeq++, pagePkts);
                pagePkts.Clear();
            }
        }
        return ms.ToArray();
    }

    private static void WriteOggPage(Stream s, byte hdrType, long granule, uint serial, uint seq, List<byte[]> packets)
    {
        var segs = new List<byte>();
        var body = new MemoryStream();
        foreach (var p in packets)
        {
            body.Write(p);
            int rem = p.Length;
            while (rem >= 255) { segs.Add(255); rem -= 255; }
            segs.Add((byte)rem);
        }
        byte[] hdr = new byte[27];
        "OggS"u8.CopyTo(hdr);
        hdr[5] = hdrType;
        BinaryPrimitives.WriteInt64LittleEndian(hdr.AsSpan(6), granule);
        BinaryPrimitives.WriteUInt32LittleEndian(hdr.AsSpan(14), serial);
        BinaryPrimitives.WriteUInt32LittleEndian(hdr.AsSpan(18), seq);
        hdr[26] = (byte)segs.Count;
        s.Write(hdr);
        s.Write(segs.ToArray());
        s.Write(body.ToArray());
    }

    private static void WriteUtf8Number(Stream s, long val)
    {
        if (val < 0x80) s.WriteByte((byte)val);
        else if (val < 0x800) { s.WriteByte((byte)(0xC0 | (val >> 6))); s.WriteByte((byte)(0x80 | (val & 0x3F))); }
        else throw new NotSupportedException();
    }

    private static byte FlacCrc8(ReadOnlySpan<byte> data)
    {
        byte crc = 0;
        foreach (byte b in data)
        {
            crc ^= b;
            for (int i = 0; i < 8; i++) crc = (byte)((crc & 0x80) != 0 ? (crc << 1) ^ 0x07 : crc << 1);
        }
        return crc;
    }

    private static ushort FlacCrc16(ReadOnlySpan<byte> data)
    {
        ushort crc = 0;
        foreach (byte b in data)
        {
            crc ^= (ushort)(b << 8);
            for (int i = 0; i < 8; i++) crc = (ushort)((crc & 0x8000) != 0 ? (crc << 1) ^ 0x8005 : crc << 1);
        }
        return crc;
    }

    private sealed class NonSeekableStream(byte[] data) : Stream
    {
        private int _pos;
        public override bool CanRead => true;
        public override bool CanSeek => false;
        public override bool CanWrite => false;
        public override long Length => throw new NotSupportedException();
        public override long Position { get => _pos; set => throw new NotSupportedException(); }
        public override int Read(byte[] buffer, int offset, int count)
        {
            int n = Math.Min(count, data.Length - _pos);
            Buffer.BlockCopy(data, _pos, buffer, offset, n);
            _pos += n;
            return n;
        }
        public override void Flush() { }
        public override long Seek(long offset, SeekOrigin origin) => throw new NotSupportedException();
        public override void SetLength(long value) => throw new NotSupportedException();
        public override void Write(byte[] buffer, int offset, int count) => throw new NotSupportedException();
    }

    private sealed class LoopbackAudioServer : IDisposable
    {
        private readonly TcpListener _listener;
        private readonly CancellationTokenSource _cts = new();
        private readonly byte[] _data;
        private readonly Func<bool> _shouldDropOnce;

        public int Port { get; }

        public LoopbackAudioServer(byte[] data, Func<bool> shouldDropOnce)
        {
            _data = data;
            _shouldDropOnce = shouldDropOnce;
            _listener = new TcpListener(IPAddress.Loopback, 0);
            _listener.Start();
            Port = ((IPEndPoint)_listener.LocalEndpoint).Port;
            _ = Task.Run(AcceptLoopAsync);
        }

        private async Task AcceptLoopAsync()
        {
            while (!_cts.IsCancellationRequested)
            {
                try
                {
                    var client = await _listener.AcceptTcpClientAsync(_cts.Token).ConfigureAwait(false);
                    _ = Task.Run(() => HandleClientAsync(client));
                }
                catch { break; }
            }
        }

        private async Task HandleClientAsync(TcpClient client)
        {
            using (client)
            {
                try
                {
                    using var ns = client.GetStream();
                    byte[] reqBuf = new byte[4096];
                    int got = await ns.ReadAsync(reqBuf, _cts.Token).ConfigureAwait(false);
                    if (got <= 0) return;
                    string req = Encoding.ASCII.GetString(reqBuf, 0, got);
                    string firstLine = req.Split("\r\n")[0];
                    string path = firstLine.Split(' ')[1];

                    if (path == "/norangestream")
                    {
                        string hdr = "HTTP/1.1 200 OK\r\nContent-Type: audio/mpeg\r\nConnection: close\r\n\r\n";
                        await ns.WriteAsync(Encoding.ASCII.GetBytes(hdr), _cts.Token).ConfigureAwait(false);
                        await ns.WriteAsync(_data, _cts.Token).ConfigureAwait(false);
                        return;
                    }

                    long start = 0, end = _data.Length - 1;
                    bool isRange = false;
                    foreach (var line in req.Split("\r\n"))
                    {
                        if (line.StartsWith("Range: bytes=", StringComparison.OrdinalIgnoreCase))
                        {
                            isRange = true;
                            var parts = line["Range: bytes=".Length..].Split('-');
                            start = long.Parse(parts[0]);
                            end = parts.Length > 1 && parts[1].Length > 0 ? Math.Min(_data.Length - 1, long.Parse(parts[1])) : _data.Length - 1;
                        }
                    }

                    int len = (int)(end - start + 1);
                    string respHdr = (isRange ? "HTTP/1.1 206 Partial Content\r\n" : "HTTP/1.1 200 OK\r\n") +
                        $"Content-Type: audio/flac\r\nAccept-Ranges: bytes\r\nContent-Length: {len}\r\n" +
                        (isRange ? $"Content-Range: bytes {start}-{end}/{_data.Length}\r\n" : "") +
                        "X-Sonus-Quality: lossless\r\nX-Sonus-Format: flac\r\nX-Sonus-Sample-Rate: 96000\r\nX-Sonus-Bit-Depth: 24\r\n" +
                        "Connection: close\r\n\r\n";
                    await ns.WriteAsync(Encoding.ASCII.GetBytes(respHdr), _cts.Token).ConfigureAwait(false);

                    // Simulate mid-stream drop on the first full streaming transfer
                    if (start == 0 && end == _data.Length - 1 && _shouldDropOnce())
                    {
                        await ns.WriteAsync(_data.AsMemory(0, 96 * 1024), _cts.Token).ConfigureAwait(false);
                        await ns.FlushAsync(_cts.Token).ConfigureAwait(false);
                        return; // abrupt close before Content-Length!
                    }
                    await ns.WriteAsync(_data.AsMemory((int)start, len), _cts.Token).ConfigureAwait(false);
                }
                catch { }
            }
        }

        public void Dispose()
        {
            _cts.Cancel();
            _listener.Stop();
            _cts.Dispose();
        }
    }
}
