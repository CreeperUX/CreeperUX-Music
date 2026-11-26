namespace Sonus.Core;

/// <summary>
/// A server whose address redirects (a reverse proxy answering every http:// request with 301 → https://, a moved host).
/// HttpClient follows redirects: a GET then simply answers from the new address, but the address the app keeps stays the
/// old one, and a POST becomes a GET without its content (on a 301, 302 or 303, as browsers do), which the server answers
/// with an error (the browser sign-in's start: 401). So the app takes the address a request ended at as the server's
/// from then on (<see cref="MovedBase"/>), and sends a POST again, as a POST, to where a redirect led
/// (<see cref="PostAsync"/>).
/// </summary>
public static class Redirects
{
    /// <summary>The server's address a request for <paramref name="apiPath"/> ended at ("https://h/music" for
    /// https://h/music/rest/ping.view), when a redirect took it to another one than it was sent to (another scheme, host,
    /// port or base path); null when it was not redirected, or ended somewhere that is not that API path.</summary>
    public static string? MovedBase(Uri sent, Uri? ended, string apiPath)
    {
        if (ended is null || BaseOf(sent, apiPath) is not { } from || BaseOf(ended, apiPath) is not { } to) return null;
        return to == from ? null : to;
    }

    private static string? BaseOf(Uri url, string apiPath)
    {
        string path = url.AbsolutePath;
        if (!path.EndsWith(apiPath, StringComparison.Ordinal)) return null;
        return url.GetLeftPart(UriPartial.Authority) + path[..^apiPath.Length];
    }

    /// <summary>A POST may be sent again to where a redirect led: the same host, and the same scheme or from http:// up
    /// to https:// (never back down, and never to another host, which would be handed the request's credentials).</summary>
    public static bool MayFollow(Uri from, Uri to) =>
        string.Equals(from.Host, to.Host, StringComparison.OrdinalIgnoreCase)
        && (from.Scheme == to.Scheme || (from.Scheme == Uri.UriSchemeHttp && to.Scheme == Uri.UriSchemeHttps));

    /// <summary>
    /// POSTs the content <paramref name="content"/> makes to <paramref name="url"/> so that a redirect never turns it into
    /// a GET: when the answer came from a GET (HttpClient followed a 301, 302 or 303), the POST is sent again, as a POST,
    /// to where the redirect led, as a 307 or 308 would have it, as long as <see cref="MayFollow"/> allows; otherwise
    /// <see cref="RedirectRefusedException"/>. The answer's RequestMessage.RequestUri is the address that answered.
    /// </summary>
    public static async Task<HttpResponseMessage> PostAsync(HttpClient http, string url, Func<HttpContent> content, CancellationToken cancel = default)
    {
        var target = new Uri(url);
        for (int hop = 0; hop < 5; hop++)
        {
            var request = new HttpRequestMessage(HttpMethod.Post, target) { Content = content() };
            var res = await http.SendAsync(request, cancel).ConfigureAwait(false);
            // a handler that does not say where it ended (a test's) did not redirect
            if (res.RequestMessage is not { } ended || ended.Method == HttpMethod.Post || ended.RequestUri is null) return res;
            var to = ended.RequestUri;
            res.Dispose();
            request.Dispose();
            if (!MayFollow(target, to)) throw new RedirectRefusedException(target, to);
            target = to;
        }
        throw new HttpRequestException($"too many redirects from {url}");
    }
}

/// <summary>A redirect the app does not follow with a POST: to another host, or from https:// down to http://.</summary>
public sealed class RedirectRefusedException(Uri from, Uri to)
    : HttpRequestException($"服务器把请求从 {from.Scheme}://{from.Host} 转到了 {to.Scheme}://{to.Host}，Sonus 没有跟过去。请直接填写服务器实际的地址（通常是 https:// 开头的那个）。")
{
    public Uri From { get; } = from;
    public Uri To { get; } = to;
}
