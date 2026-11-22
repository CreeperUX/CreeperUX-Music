using System.Net;
using System.Runtime.InteropServices.WindowsRuntime;
using System.Text.RegularExpressions;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Media;
using Microsoft.UI.Xaml.Media.Imaging;
using Windows.Storage.Streams;

namespace CreeperUX.Music.Controls;

/// <summary>
/// Cover art, downloaded by the app rather than by XAML's image loader. That loader goes through WinINet, which shares a
/// few connections per server with the songs streaming from the same server: while music played, covers stopped arriving.
/// One request per URL at a time; the bytes stay in a small cache (most recently used first), so a list scrolled back or a
/// page opened again shows its covers at once. UI thread only.
/// </summary>
public static class Covers
{
    private static readonly HttpClient Http = new(new SocketsHttpHandler
    {
        PooledConnectionLifetime = TimeSpan.FromMinutes(5), MaxConnectionsPerServer = 6, AutomaticDecompression = DecompressionMethods.All,
    }) { Timeout = TimeSpan.FromSeconds(20) };

    private const long CacheLimit = 48L << 20;
    private static readonly Dictionary<string, LinkedListNode<(string Url, byte[] Bytes)>> Cache = [];
    private static readonly LinkedList<(string Url, byte[] Bytes)> Recent = [];
    private static readonly Dictionary<string, Task<byte[]?>> Loading = [];
    private static long _cached;

    /// <summary>The interface zoom (MainWindow): covers are fetched and decoded for the pixels they take on screen.</summary>
    public static double Zoom { get; set; } = 1;

    /// <summary>The sizes asked of the server: a few, so its resized copies (and this cache) are shared between places.</summary>
    private static readonly int[] Sizes = [64, 128, 256, 512, 1024];

    /// <summary>The bytes at <paramref name="url"/> (from the cache when there), or null when they cannot be had.</summary>
    public static Task<byte[]?> BytesAsync(string url)
    {
        if (Cache.TryGetValue(url, out var node))
        {
            Recent.Remove(node); Recent.AddFirst(node);
            return Task.FromResult<byte[]?>(node.Value.Bytes);
        }
        if (!Loading.TryGetValue(url, out var task)) Loading[url] = task = Fetch(url);
        return task;
    }

    private static async Task<byte[]?> Fetch(string url)
    {
        byte[]? bytes = null;
        try { bytes = await Http.GetByteArrayAsync(url); }
        catch (Exception ex) when (ex is not OutOfMemoryException) { Log.Write($"cover: {ex.Message}"); }
        finally { Loading.Remove(url); } // back on the UI thread; a failed one is asked for again the next time
        if (bytes is { Length: > 0 } && !Cache.ContainsKey(url))
        {
            Cache[url] = Recent.AddFirst((url, bytes));
            _cached += bytes.Length;
            while (_cached > CacheLimit && Recent.Last is { } last)
            {
                Recent.RemoveLast(); Cache.Remove(last.Value.Url); _cached -= last.Value.Bytes.Length;
            }
        }
        return bytes;
    }

    // Decoded covers, most recently used first, up to about 24 million pixels: a list rebuilt (the library after a like) or
    // scrolled back, or a page opened again, shows its covers at once instead of decoding and fading them in again.
    private const long DecodedLimit = 24_000_000;
    private static readonly Dictionary<string, LinkedListNode<(string Key, ImageSource Source, long Pixels)>> Decoded = [];
    private static readonly LinkedList<(string Key, ImageSource Source, long Pixels)> DecodedRecent = [];
    private static long _decodedPixels;

    private static ImageSource? DecodedFor(string key)
    {
        if (!Decoded.TryGetValue(key, out var node)) return null;
        DecodedRecent.Remove(node); DecodedRecent.AddFirst(node);
        return node.Value.Source;
    }

    private static void KeepDecoded(string key, ImageSource source, int pixels)
    {
        if (Decoded.ContainsKey(key)) return;
        long area = (long)pixels * pixels;
        Decoded[key] = DecodedRecent.AddFirst((key, source, area));
        _decodedPixels += area;
        while (_decodedPixels > DecodedLimit && DecodedRecent.Last is { } last)
        {
            DecodedRecent.RemoveLast(); Decoded.Remove(last.Value.Key); _decodedPixels -= last.Value.Pixels;
        }
    }

    /// <summary>
    /// Shows the image at <paramref name="url"/> in <paramref name="image"/>, decoded <paramref name="width"/> px wide (logical);
    /// null clears it. <paramref name="done"/> learns whether it worked, and whether it was there at once (already decoded:
    /// no need to fade it in). If the image is given another URL meanwhile (a recycled list row), the newer one wins.
    /// </summary>
    public static async void Show(Image image, string? url, int width, Action<bool, bool>? done = null)
    {
        // sharp: the server's copy and the decoded bitmap as wide as the cover is on screen (its size × the display's scale ×
        // the zoom), never a smaller copy blown up
        double scale = (image.XamlRoot?.RasterizationScale ?? App.MainWindow?.Content?.XamlRoot?.RasterizationScale ?? 1) * Zoom;
        int pixels = (int)Math.Ceiling(Math.Max(1, width) * scale);
        if (url is not null) url = Sized(url, Sizes.FirstOrDefault(s => s >= pixels, Sizes[^1]));
        if (url is not null && Equals(image.Tag, url) && image.Source is not null) { done?.Invoke(true, true); return; }
        image.Tag = url;
        if (url is null) { image.Source = null; return; }
        string key = $"{url}|{pixels}";
        if (DecodedFor(key) is { } ready) { image.Source = ready; done?.Invoke(true, true); return; }
        var bytes = await BytesAsync(url);
        if (!Equals(image.Tag, url)) return;
        ImageSource? source = bytes is null ? null : DecodedFor(key) ?? await Decode(bytes, pixels);
        if (!Equals(image.Tag, url)) return;
        if (source is not null) KeepDecoded(key, source, pixels);
        image.Source = source;
        done?.Invoke(source is not null, false);
    }

    /// <summary>A getCoverArt URL asking for <paramref name="size"/> px.</summary>
    private static string Sized(string url, int size) =>
        Regex.IsMatch(url, @"[?&]size=\d+") ? Regex.Replace(url, @"([?&]size=)\d+", "${1}" + size) : url;

    /// <summary>The image, decoded <paramref name="pixels"/> wide (physical pixels).</summary>
    private static async Task<ImageSource?> Decode(byte[] bytes, int pixels)
    {
        try
        {
            using var stream = new InMemoryRandomAccessStream();
            await stream.WriteAsync(bytes.AsBuffer());
            stream.Seek(0);
            if (IsSvg(bytes))
            {
                // some servers send SVG covers (the demo server's generated ones, when there is no JPEG)
                var svg = new SvgImageSource { RasterizePixelWidth = pixels, RasterizePixelHeight = pixels };
                return await svg.SetSourceAsync(stream) == SvgImageSourceLoadStatus.Success ? svg : null;
            }
            var bitmap = new BitmapImage { DecodePixelWidth = pixels, DecodePixelType = DecodePixelType.Physical };
            await bitmap.SetSourceAsync(stream);
            return bitmap;
        }
        catch (Exception ex) when (ex is ArgumentException or System.Runtime.InteropServices.COMException or InvalidCastException or UnauthorizedAccessException)
        {
            return null; // not an image (a server error page, say)
        }
    }

    private static bool IsSvg(byte[] bytes)
    {
        int i = 0;
        if (bytes.Length >= 3 && bytes[0] == 0xEF && bytes[1] == 0xBB && bytes[2] == 0xBF) i = 3;
        while (i < bytes.Length && bytes[i] is (byte)' ' or (byte)'\t' or (byte)'\r' or (byte)'\n') i++;
        return i < bytes.Length && bytes[i] == (byte)'<';
    }
}
