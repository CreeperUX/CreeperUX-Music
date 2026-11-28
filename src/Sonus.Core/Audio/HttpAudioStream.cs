using System.Net;
using System.Net.Http.Headers;

namespace Sonus.Core.Audio;

/// <summary>
/// Read-only stream over an HTTP audio endpoint designed for both low-overhead sequential playback and fast
/// HTTP Range seeking:
/// - Keeps the first 128 KB pinned in memory so magic-byte sniffing, FLAC STREAMINFO/SEEKTABLE reads, and Ogg
///   header reads never re-hit the network (and even work on non-seekable chunked live transcodes).
/// - Serves sequential playback over an open-ended <c>Range: bytes=pos-</c> streaming response pulled on demand,
///   avoiding per-block RTT stalls and keeping TCP backpressure active.
/// - Uses bounded Range blocks (64 KB lossy / 128 KB lossless) cached in a small LRU when <see cref="ProbeMode"/>
///   is active or when peeking near EOF (Ogg last-page granule, ID3v1 tail tags, bisection seeks).
/// - Automatically reconnects from the exact byte offset on mid-stream network drops (up to 4 attempts).
/// </summary>
public sealed class HttpAudioStream : Stream
{
    /// <summary>Dedicated HTTP client with AutomaticDecompression disabled so byte offsets match Range headers.</summary>
    public static readonly HttpClient SharedClient = new(new SocketsHttpHandler
    {
        PooledConnectionLifetime = TimeSpan.FromMinutes(5),
        ConnectTimeout = TimeSpan.FromSeconds(10),
        AutomaticDecompression = DecompressionMethods.None,
        MaxConnectionsPerServer = 16,
    })
    {
        Timeout = Timeout.InfiniteTimeSpan, // controlled per-request via CancellationToken
    };

    private const int HeaderCacheCapacity = 128 * 1024;
    private const int InitialProbeBytes = 64 * 1024;
    private const int MaxProbeCachedBlocks = 16;

    private readonly HttpClient _http;
    private readonly Uri _uri;
    private readonly CancellationTokenSource _cts = new();
    private readonly object _stateLock = new();

    private readonly byte[] _headerPrefix;
    private int _headerPrefixLen;

    // Small LRU cache for bounded probe reads (bisection & tail scans)
    private readonly Dictionary<long, byte[]> _probeCache = new();
    private readonly LinkedList<long> _probeLru = new();
    private readonly Dictionary<long, LinkedListNode<long>> _probeLruNodes = new();

    // Active sequential streaming HTTP response (open-ended GET or Range: bytes=start-)
    private HttpResponseMessage? _activeResponse;
    private Stream? _activeStream;
    private long _activeStreamPos;
    private bool _activeStreamEnded;

    private long _length;
    private long _position;
    private readonly bool _acceptsRanges;
    private int _probeBlockSize;
    private bool _disposed;

    public StreamMetadata Metadata { get; }
    public bool AcceptsRanges => _acceptsRanges;
    public long TotalHttpRequests { get; private set; }
    public long TotalBytesFetched { get; private set; }
    public int ReconnectCount { get; private set; }
    public Action<string>? OnDiagnostic { get; set; }

    /// <summary>
    /// When true, reads outside the header cache fetch bounded blocks (<see cref="ProbeBlockSize"/>) into an LRU
    /// cache instead of opening a streaming open-ended response. Used by decoders during bisection and tail scans.
    /// </summary>
    public bool ProbeMode { get; set; }

    /// <summary>Block size for bounded probe requests (64 KB for lossy formats, 128 KB for lossless).</summary>
    public int ProbeBlockSize
    {
        get => _probeBlockSize;
        set => _probeBlockSize = Math.Clamp(value, 16 * 1024, 256 * 1024);
    }

    private HttpAudioStream(
        HttpClient http,
        Uri uri,
        StreamMetadata metadata,
        byte[] headerPrefix,
        int headerPrefixLen,
        HttpResponseMessage? liveResponse,
        Stream? liveStream,
        long liveStreamPos,
        int probeBlockSize)
    {
        _http = http;
        _uri = uri;
        Metadata = metadata;
        _length = metadata.TotalBytes;
        _acceptsRanges = metadata.AcceptsRanges;
        _headerPrefix = headerPrefix;
        _headerPrefixLen = headerPrefixLen;
        _activeResponse = liveResponse;
        _activeStream = liveStream;
        _activeStreamPos = liveStreamPos;
        _probeBlockSize = probeBlockSize;
        TotalHttpRequests = 1;
        TotalBytesFetched = headerPrefixLen;
    }

    /// <summary>
    /// Opens the audio stream in a single round-trip. When <paramref name="initialProbeOnly"/> is true (used when
    /// starting mid-song, e.g. takeover), requests only the first 128 KB so we parse headers/SEEKTABLE without
    /// downloading audio before the target seek offset.
    /// </summary>
    public static async Task<HttpAudioStream> OpenAsync(
        HttpClient http,
        Uri uri,
        bool initialProbeOnly = false,
        int probeBlockSize = 128 * 1024,
        CancellationToken ct = default)
    {
        using var req = new HttpRequestMessage(HttpMethod.Get, uri);
        req.Headers.Range = initialProbeOnly
            ? new RangeHeaderValue(0, InitialProbeBytes - 1)
            : new RangeHeaderValue(0, null);

        var resp = await http.SendAsync(req, HttpCompletionOption.ResponseHeadersRead, ct).ConfigureAwait(false);
        try
        {
            if (resp.StatusCode == HttpStatusCode.RequestedRangeNotSatisfiable && initialProbeOnly)
            {
                resp.Dispose();
                using var retryReq = new HttpRequestMessage(HttpMethod.Get, uri);
                resp = await http.SendAsync(retryReq, HttpCompletionOption.ResponseHeadersRead, ct).ConfigureAwait(false);
            }
            resp.EnsureSuccessStatusCode();

            string? contentType = resp.Content.Headers.ContentType?.MediaType;
            // Subsonic servers sometimes return HTTP 200 with application/json or text/xml on stream errors
            if (contentType is not null &&
                (contentType.Contains("json", StringComparison.OrdinalIgnoreCase) ||
                 contentType.Contains("xml", StringComparison.OrdinalIgnoreCase) ||
                 contentType.StartsWith("text/", StringComparison.OrdinalIgnoreCase)))
            {
                string body = await resp.Content.ReadAsStringAsync(ct).ConfigureAwait(false);
                throw new HttpRequestException($"Server returned {contentType} instead of audio: {Truncate(body, 160)}");
            }

            bool acceptsRanges = resp.StatusCode == HttpStatusCode.PartialContent ||
                                 resp.Headers.AcceptRanges.Any(v => v.Equals("bytes", StringComparison.OrdinalIgnoreCase));

            long totalLength;
            if (resp.StatusCode == HttpStatusCode.PartialContent)
            {
                totalLength = resp.Content.Headers.ContentRange?.Length ?? -1;
            }
            else
            {
                totalLength = resp.Content.Headers.ContentLength ?? -1;
            }

            var meta = new StreamMetadata(
                ContentType: contentType,
                TotalBytes: totalLength,
                AcceptsRanges: acceptsRanges,
                Quality: Header(resp, "X-Sonus-Quality"),
                Format: Header(resp, "X-Sonus-Format"),
                SampleRate: IntHeader(resp, "X-Sonus-Sample-Rate"),
                BitDepth: IntHeader(resp, "X-Sonus-Bit-Depth"),
                BitRate: IntHeader(resp, "X-Sonus-Bit-Rate"));

            // If this is a bounded header probe (or the server returned 206 for a bounded range), read the header
            // chunk completely and release the response; otherwise keep the streaming response open on demand!
            byte[] headerBuf = new byte[HeaderCacheCapacity];
            int headerLen = 0;

            if (initialProbeOnly && resp.StatusCode == HttpStatusCode.PartialContent)
            {
                await using var s = await resp.Content.ReadAsStreamAsync(ct).ConfigureAwait(false);
                while (headerLen < headerBuf.Length)
                {
                    int n = await s.ReadAsync(headerBuf.AsMemory(headerLen, headerBuf.Length - headerLen), ct).ConfigureAwait(false);
                    if (n == 0) break;
                    headerLen += n;
                }
                resp.Dispose();
                if (totalLength < 0) totalLength = headerLen;
                meta = meta with { TotalBytes = totalLength };
                return new HttpAudioStream(http, uri, meta, headerBuf, headerLen, null, null, 0, probeBlockSize);
            }
            else
            {
                // Keep the streaming response open, but pre-fill an initial sniff slice (up to 64 KB or whatever
                // is immediately available) so format detection + header parsing never need a second request.
                var liveStream = await resp.Content.ReadAsStreamAsync(ct).ConfigureAwait(false);
                int targetPrefill = Math.Min(64 * 1024, headerBuf.Length);
                if (totalLength >= 0 && totalLength < targetPrefill) targetPrefill = (int)totalLength;
                while (headerLen < targetPrefill)
                {
                    int n = await liveStream.ReadAsync(headerBuf.AsMemory(headerLen, targetPrefill - headerLen), ct).ConfigureAwait(false);
                    if (n == 0)
                    {
                        // Small file finished inside the first 64 KB
                        if (totalLength < 0) totalLength = headerLen;
                        await liveStream.DisposeAsync().ConfigureAwait(false);
                        resp.Dispose();
                        meta = meta with { TotalBytes = totalLength };
                        return new HttpAudioStream(http, uri, meta, headerBuf, headerLen, null, null, 0, probeBlockSize);
                    }
                    headerLen += n;
                }
                return new HttpAudioStream(http, uri, meta, headerBuf, headerLen, resp, liveStream, headerLen, probeBlockSize);
            }
        }
        catch
        {
            resp.Dispose();
            throw;
        }
    }

    private static string? Header(HttpResponseMessage resp, string name) =>
        resp.Headers.TryGetValues(name, out var vals) ? vals.FirstOrDefault() : null;

    private static int? IntHeader(HttpResponseMessage resp, string name) =>
        int.TryParse(Header(resp, name), System.Globalization.CultureInfo.InvariantCulture, out int v) ? v : null;

    private static string Truncate(string s, int max) => s.Length <= max ? s : s[..max] + "...";

    public override bool CanRead => true;
    public override bool CanSeek => _acceptsRanges && _length >= 0;
    public override bool CanWrite => false;
    public override long Length => _length;

    public override long Position
    {
        get => _position;
        set => Seek(value, SeekOrigin.Begin);
    }

    /// <summary>Aborts any in-flight HTTP transfer without disposing the stream permanently (used before an urgent seek).</summary>
    public void AbortActiveStream()
    {
        lock (_stateLock) CloseActiveStreamLocked();
    }

    /// <summary>
    /// Opens the sequential streaming connection right after the cached prefix when a preloaded track
    /// (opened with <c>initialProbeOnly: true</c>) is promoted to active playback.
    /// </summary>
    public void PromoteToStreaming()
    {
        if (_disposed || _cts.IsCancellationRequested || !_acceptsRanges) return;
        if (_activeStream is not null) return;
        if (_length >= 0 && _headerPrefixLen >= _length) return;
        long savedPos = _position;
        try
        {
            _position = _headerPrefixLen;
            EnsureActiveStreamAtPosition();
        }
        finally
        {
            _position = savedPos;
        }
    }

    /// <summary>Cancels all ongoing and future I/O immediately so a blocked read thread exits without waiting.</summary>
    public void Cancel()
    {
        try { _cts.Cancel(); } catch (ObjectDisposedException) { }
        lock (_stateLock) CloseActiveStreamLocked();
    }

    public override long Seek(long offset, SeekOrigin origin)
    {
        ObjectDisposedException.ThrowIf(_disposed, this);
        long target = origin switch
        {
            SeekOrigin.Begin => offset,
            SeekOrigin.Current => _position + offset,
            SeekOrigin.End => _length >= 0 ? _length + offset : throw new NotSupportedException("Cannot seek from End when length is unknown."),
            _ => throw new ArgumentOutOfRangeException(nameof(origin)),
        };
        if (target < 0) target = 0;
        if (_length >= 0 && target > _length) target = _length;

        // Allow rewinding within the buffered header prefix even on non-seekable chunked streams
        // (needed so AudioDecoderFactory can sniff magic bytes and rewind to 0 before constructing the decoder).
        if (!CanSeek && target > _headerPrefixLen)
            throw new NotSupportedException("Stream does not support HTTP Range seeking.");

        _position = target;
        return _position;
    }

    public override int Read(byte[] buffer, int offset, int count) => Read(buffer.AsSpan(offset, count));

    public override int Read(Span<byte> buffer)
    {
        ObjectDisposedException.ThrowIf(_disposed, this);
        _cts.Token.ThrowIfCancellationRequested();
        if (buffer.IsEmpty) return 0;
        if (_length >= 0 && _position >= _length) return 0;

        // 1. Serve from pinned header prefix cache whenever possible
        if (_position < _headerPrefixLen)
        {
            int avail = _headerPrefixLen - (int)_position;
            int take = Math.Min(buffer.Length, avail);
            _headerPrefix.AsSpan((int)_position, take).CopyTo(buffer[..take]);
            _position += take;
            return take;
        }

        // 2. Bounded probe mode (bisection, Ogg tail granule scan, MP3 ID3v1 tail peek)
        bool isTailPeek = _acceptsRanges && _length > 256 * 1024 && _position >= _length - 65536 &&
                          (_activeStream is null || _position != _activeStreamPos);
        if ((ProbeMode || isTailPeek) && _acceptsRanges)
        {
            return ReadFromProbeCache(buffer);
        }

        // 3. Sequential streaming mode: keep pulling from the active stream, opening/reconnecting as needed
        return ReadFromStreamingResponse(buffer);
    }

    private int ReadFromProbeCache(Span<byte> buffer)
    {
        int bs = _probeBlockSize;
        long blockIndex = _position / bs;
        int inBlock = (int)(_position % bs);
        byte[] block = GetOrFetchProbeBlock(blockIndex, bs);
        if (inBlock >= block.Length) return 0;
        int take = Math.Min(buffer.Length, block.Length - inBlock);
        block.AsSpan(inBlock, take).CopyTo(buffer[..take]);
        _position += take;
        return take;
    }

    private byte[] GetOrFetchProbeBlock(long blockIndex, int bs)
    {
        lock (_stateLock)
        {
            if (_probeCache.TryGetValue(blockIndex, out var hit))
            {
                TouchProbeLruLocked(blockIndex);
                return hit;
            }
        }

        long start = blockIndex * bs;
        if (_length >= 0 && start >= _length) return [];
        long end = _length >= 0 ? Math.Min(_length - 1, start + bs - 1) : start + bs - 1;

        Exception? lastErr = null;
        for (int attempt = 0; attempt < 4; attempt++)
        {
            _cts.Token.ThrowIfCancellationRequested();
            try
            {
                using var req = new HttpRequestMessage(HttpMethod.Get, _uri);
                req.Headers.Range = new RangeHeaderValue(start, end);
                using var resp = _http.SendAsync(req, HttpCompletionOption.ResponseHeadersRead, _cts.Token)
                    .ConfigureAwait(false).GetAwaiter().GetResult();
                if (resp.StatusCode == HttpStatusCode.RequestedRangeNotSatisfiable) return [];
                resp.EnsureSuccessStatusCode();

                using var s = resp.Content.ReadAsStreamAsync(_cts.Token).ConfigureAwait(false).GetAwaiter().GetResult();
                int expected = (int)(end - start + 1);
                byte[] data = new byte[expected];
                int got = 0;
                while (got < expected)
                {
                    int n = s.ReadAsync(data.AsMemory(got, expected - got), _cts.Token).AsTask()
                        .ConfigureAwait(false).GetAwaiter().GetResult();
                    if (n == 0) break;
                    got += n;
                }
                if (got < expected) Array.Resize(ref data, got);

                lock (_stateLock)
                {
                    TotalHttpRequests++;
                    TotalBytesFetched += data.Length;
                    PutProbeBlockLocked(blockIndex, data);
                }
                return data;
            }
            catch (OperationCanceledException) { throw; }
            catch (Exception ex) when (attempt < 3)
            {
                lastErr = ex;
                ReconnectCount++;
                OnDiagnostic?.Invoke($"HTTP range probe retry {attempt + 1} at {start}-{end}: {ex.Message}");
                WaitRetryDelay(attempt);
            }
        }
        throw new IOException($"HTTP range probe failed at {start}-{end}: {lastErr?.Message}", lastErr);
    }

    private int ReadFromStreamingResponse(Span<byte> buffer)
    {
        byte[] tmp = System.Buffers.ArrayPool<byte>.Shared.Rent(Math.Min(buffer.Length, 64 * 1024));
        try
        {
            int want = Math.Min(buffer.Length, tmp.Length);
            Exception? lastErr = null;

            for (int attempt = 0; attempt < 4; attempt++)
            {
                _cts.Token.ThrowIfCancellationRequested();
                try
                {
                    EnsureActiveStreamAtPosition();
                    if (_activeStream is null) return 0; // true EOF

                    int n = _activeStream.ReadAsync(tmp.AsMemory(0, want), _cts.Token).AsTask()
                        .ConfigureAwait(false).GetAwaiter().GetResult();
                    if (n > 0)
                    {
                        tmp.AsSpan(0, n).CopyTo(buffer[..n]);
                        // Extend pinned header prefix if still inside first 128 KB
                        if (_position < HeaderCacheCapacity && _position == _headerPrefixLen)
                        {
                            int copyHdr = Math.Min(n, HeaderCacheCapacity - _headerPrefixLen);
                            if (copyHdr > 0)
                            {
                                Buffer.BlockCopy(tmp, 0, _headerPrefix, _headerPrefixLen, copyHdr);
                                _headerPrefixLen += copyHdr;
                            }
                        }
                        _position += n;
                        _activeStreamPos += n;
                        TotalBytesFetched += n;
                        return n;
                    }

                    // Stream returned 0 bytes: either true EOF or premature drop before _length
                    lock (_stateLock)
                    {
                        CloseActiveStreamLocked();
                        _activeStreamEnded = true;
                    }
                    if (_length < 0 || _position >= _length) return 0; // true EOF

                    // Premature EOF on a known-length Range-capable stream -> reconnect!
                    if (!_acceptsRanges) return 0;
                    ReconnectCount++;
                    OnDiagnostic?.Invoke($"HTTP stream ended early at {_position}/{_length}, reconnecting (attempt {attempt + 1})");
                    WaitRetryDelay(attempt);
                }
                catch (OperationCanceledException) { throw; }
                catch (Exception ex) when (attempt < 3 && _acceptsRanges)
                {
                    lastErr = ex;
                    lock (_stateLock) CloseActiveStreamLocked();
                    ReconnectCount++;
                    OnDiagnostic?.Invoke($"HTTP stream interrupted at {_position} ({ex.Message}), reconnecting (attempt {attempt + 1})");
                    WaitRetryDelay(attempt);
                }
            }
            throw new IOException($"HTTP audio stream failed at {_position}: {lastErr?.Message}", lastErr);
        }
        finally
        {
            System.Buffers.ArrayPool<byte>.Shared.Return(tmp);
        }
    }

    private void EnsureActiveStreamAtPosition()
    {
        if (_activeStream is not null && _activeStreamPos == _position) return;

        // If we are just a small distance ahead on the active stream (<= 32 KB forward skip, e.g. skipping a
        // FLAC PADDING metadata block or WAV metadata chunk), drain it rather than opening a new HTTP request!
        if (_activeStream is not null && _position > _activeStreamPos && _position - _activeStreamPos <= 32 * 1024)
        {
            byte[] skip = new byte[8192];
            while (_activeStreamPos < _position)
            {
                int want = (int)Math.Min(skip.Length, _position - _activeStreamPos);
                int n = _activeStream.ReadAsync(skip.AsMemory(0, want), _cts.Token).AsTask()
                    .ConfigureAwait(false).GetAwaiter().GetResult();
                if (n == 0) break;
                if (_activeStreamPos < HeaderCacheCapacity && _activeStreamPos == _headerPrefixLen)
                {
                    int copyHdr = Math.Min(n, HeaderCacheCapacity - _headerPrefixLen);
                    if (copyHdr > 0)
                    {
                        Buffer.BlockCopy(skip, 0, _headerPrefix, _headerPrefixLen, copyHdr);
                        _headerPrefixLen += copyHdr;
                    }
                }
                _activeStreamPos += n;
                TotalBytesFetched += n;
            }
            if (_activeStreamPos == _position) return;
        }

        if (!_acceptsRanges)
        {
            if (_activeStreamEnded) return; // sequential stream already reached EOF
            if (_activeStream is null) return;
            throw new NotSupportedException("Cannot reposition a non-Range HTTP stream.");
        }

        if (_length >= 0 && _position >= _length)
        {
            lock (_stateLock) CloseActiveStreamLocked();
            return;
        }

        lock (_stateLock) CloseActiveStreamLocked();

        using var req = new HttpRequestMessage(HttpMethod.Get, _uri);
        req.Headers.Range = new RangeHeaderValue(_position, null);
        var resp = _http.SendAsync(req, HttpCompletionOption.ResponseHeadersRead, _cts.Token)
            .ConfigureAwait(false).GetAwaiter().GetResult();
        try
        {
            if (resp.StatusCode == HttpStatusCode.RequestedRangeNotSatisfiable)
            {
                resp.Dispose();
                return;
            }
            resp.EnsureSuccessStatusCode();
            var stream = resp.Content.ReadAsStreamAsync(_cts.Token).ConfigureAwait(false).GetAwaiter().GetResult();

            // If server ignored Range and answered 200 OK from byte 0, skip forward only if small; otherwise fail
            long startOffset = resp.StatusCode == HttpStatusCode.PartialContent
                ? resp.Content.Headers.ContentRange?.From ?? _position
                : 0;

            if (startOffset < _position)
            {
                long skipRemaining = _position - startOffset;
                byte[] discard = new byte[16384];
                while (skipRemaining > 0)
                {
                    int n = stream.ReadAsync(discard.AsMemory(0, (int)Math.Min(discard.Length, skipRemaining)), _cts.Token)
                        .AsTask().ConfigureAwait(false).GetAwaiter().GetResult();
                    if (n == 0) break;
                    skipRemaining -= n;
                }
            }

            lock (_stateLock)
            {
                if (_disposed || _cts.IsCancellationRequested)
                {
                    stream.Dispose();
                    resp.Dispose();
                    _cts.Token.ThrowIfCancellationRequested();
                }
                _activeResponse = resp;
                _activeStream = stream;
                _activeStreamPos = _position;
                _activeStreamEnded = false;
                TotalHttpRequests++;
            }
        }
        catch
        {
            resp.Dispose();
            throw;
        }
    }

    private void WaitRetryDelay(int attempt)
    {
        int ms = attempt switch { 0 => 100, 1 => 300, 2 => 800, _ => 1500 };
        _cts.Token.WaitHandle.WaitOne(ms);
        _cts.Token.ThrowIfCancellationRequested();
    }

    private void PutProbeBlockLocked(long blockIndex, byte[] data)
    {
        if (_probeCache.ContainsKey(blockIndex))
        {
            _probeCache[blockIndex] = data;
            TouchProbeLruLocked(blockIndex);
            return;
        }
        _probeCache[blockIndex] = data;
        var node = _probeLru.AddFirst(blockIndex);
        _probeLruNodes[blockIndex] = node;
        while (_probeCache.Count > MaxProbeCachedBlocks)
        {
            var victim = _probeLru.Last;
            if (victim is null) break;
            long k = victim.Value;
            _probeLru.Remove(victim);
            _probeLruNodes.Remove(k);
            _probeCache.Remove(k);
        }
    }

    private void TouchProbeLruLocked(long blockIndex)
    {
        if (_probeLruNodes.TryGetValue(blockIndex, out var node))
        {
            _probeLru.Remove(node);
            _probeLru.AddFirst(node);
        }
    }

    private void CloseActiveStreamLocked()
    {
        try { _activeStream?.Dispose(); } catch { }
        try { _activeResponse?.Dispose(); } catch { }
        _activeStream = null;
        _activeResponse = null;
    }

    public override void Flush() { }
    public override void SetLength(long value) => throw new NotSupportedException();
    public override void Write(byte[] buffer, int offset, int count) => throw new NotSupportedException();

    protected override void Dispose(bool disposing)
    {
        if (_disposed) return;
        _disposed = true;
        if (disposing)
        {
            try { _cts.Cancel(); } catch { }
            lock (_stateLock) CloseActiveStreamLocked();
            _cts.Dispose();
        }
        base.Dispose(disposing);
    }
}
