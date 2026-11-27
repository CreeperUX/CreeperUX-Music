using System.Net;

namespace Sonus.Core;

/// <summary>
/// A server whose address redirects (a reverse proxy answering every http:// request with 301 → https://, a moved host).
/// HttpClient follows redirects: a GET then simply answers from the new address, but the address the app keeps stays the
/// old one, and a POST becomes a GET without its content (on a 301, 302 or 303, as browsers do), which the server answers
/// with an error (the browser sign-in's start: 401). So the app takes the address a request ended at as the server's
/// from then on (<see cref="MovedBase"/>), and sends a POST on, as a POST, to where a redirect leads
/// (<see cref="PostAsync"/>).
/// <para>Only where <see cref="MayFollow"/> allows: the same host, and the same scheme or from http:// up to https://.
/// Every request carries the sign-in (the token or the API key in its query, a key in a POST's content), so a redirect
/// to another host, or from https:// down to http://, is not taken as the server's address, and a POST is not sent
/// there. (HttpClient itself never follows https:// down to http://.)</para>
/// </summary>
public static class Redirects
{
    /// <summary>A client that leaves redirects to the caller: POSTs go through it (<see cref="PostAsync"/>).</summary>
    internal static readonly HttpClient NoRedirects = new(new SocketsHttpHandler
    {
        AllowAutoRedirect = false, PooledConnectionLifetime = TimeSpan.FromMinutes(5), AutomaticDecompression = DecompressionMethods.All,
    }) { Timeout = TimeSpan.FromSeconds(30) };

    /// <summary>The server's address a request for <paramref name="apiPath"/> ended at ("https://h/music" for
    /// https://h/music/rest/ping.view), when a redirect <see cref="MayFollow"/> allows took it to another one than it was
    /// sent to (http:// up to https://, another port or base path); null when it was not redirected, was redirected
    /// where it may not go, or ended somewhere that is not that API path.</summary>
    public static string? MovedBase(Uri sent, Uri? ended, string apiPath)
    {
        if (ended is null || !MayFollow(sent, ended) || BaseOf(sent, apiPath) is not { } from || BaseOf(ended, apiPath) is not { } to) return null;
        return to == from ? null : to;
    }

    private static string? BaseOf(Uri url, string apiPath)
    {
        string path = url.AbsolutePath;
        if (!path.EndsWith(apiPath, StringComparison.Ordinal)) return null;
        return url.GetLeftPart(UriPartial.Authority) + path[..^apiPath.Length];
    }

    /// <summary>A request may go on to where a redirect leads: the same host, and the same scheme or from http:// up to
    /// https:// (never back down, and never to another host, which would be handed the request's credentials).</summary>
    public static bool MayFollow(Uri from, Uri to) =>
        string.Equals(from.Host, to.Host, StringComparison.OrdinalIgnoreCase)
        && (from.Scheme == to.Scheme || (from.Scheme == Uri.UriSchemeHttp && to.Scheme == Uri.UriSchemeHttps));

    /// <summary>
    /// POSTs the content <paramref name="content"/> makes to <paramref name="url"/> so that a redirect never turns it into
    /// a GET, nor takes it where <see cref="MayFollow"/> does not allow (<see cref="RedirectRefusedException"/>). By
    /// default (no <paramref name="http"/>) through <see cref="NoRedirects"/>, following each redirect here as the same
    /// POST (as a 307 or 308 would have it). A given client that follows redirects itself: an answer that came from a
    /// GET is sent again as a POST, and one from where it may not go is refused. The answer's RequestMessage.RequestUri
    /// is the address that answered.
    /// </summary>
    public static async Task<HttpResponseMessage> PostAsync(HttpClient? http, string url, Func<HttpContent> content, CancellationToken cancel = default)
    {
        var client = http ?? NoRedirects;
        var target = new Uri(url);
        for (int hop = 0; hop < 6; hop++)
        {
            var request = new HttpRequestMessage(HttpMethod.Post, target) { Content = content() };
            var res = await client.SendAsync(request, cancel).ConfigureAwait(false);
            Uri next;
            if ((int)res.StatusCode is 301 or 302 or 303 or 307 or 308 && res.Headers.Location is { } location)
            {
                next = location.IsAbsoluteUri ? location : new Uri(target, location); // a redirect left to us
            }
            else if (res.RequestMessage is { RequestUri: { } ended } m && ended != target)
            {
                // the client followed redirects itself: only where it may go, and only an answer to a POST is one
                if (!MayFollow(target, ended)) { res.Dispose(); throw new RedirectRefusedException(target, ended); }
                if (m.Method == HttpMethod.Post) return res;
                next = ended;
            }
            else
            {
                return res;
            }
            res.Dispose();
            request.Dispose();
            if (!MayFollow(target, next)) throw new RedirectRefusedException(target, next);
            target = next;
        }
        throw new HttpRequestException($"too many redirects from {url}");
    }
}

/// <summary>A redirect the app does not follow: to another host, or from https:// down to http://.</summary>
public sealed class RedirectRefusedException(Uri from, Uri to)
    : HttpRequestException($"服务器把请求从 {from.Scheme}://{from.Host} 转到了 {to.Scheme}://{to.Host}，Sonus 没有跟过去。请直接填写服务器实际的地址（通常是 https:// 开头的那个）。")
{
    public Uri From { get; } = from;
    public Uri To { get; } = to;
}
