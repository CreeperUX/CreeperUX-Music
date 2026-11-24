using System.Net;
using System.Security.Cryptography;
using System.Text;
using Sonus.Core.Updates;

namespace Sonus.Core.Tests;

public sealed class UpdateTests : IDisposable
{
    private readonly string _dir = Path.Combine(Path.GetTempPath(), "sonus-update-" + Guid.NewGuid().ToString("N"));

    public void Dispose() { if (Directory.Exists(_dir)) Directory.Delete(_dir, recursive: true); }

    private static readonly byte[] Setup = Encoding.ASCII.GetBytes(string.Concat(Enumerable.Repeat("MZ fake setup ", 20000)));
    private static string Sha(byte[] bytes) => Convert.ToHexStringLower(SHA256.HashData(bytes));

    private static string Release(string tag, bool pre = false, bool draft = false, string version = "", string? digest = null) =>
        $$"""
        { "tag_name": "{{tag}}", "name": "Sonus {{tag}}", "body": "说明", "prerelease": {{(pre ? "true" : "false")}},
          "draft": {{(draft ? "true" : "false")}}, "published_at": "2026-11-22T08:00:00Z",
          "assets": [
            { "name": "Sonus-{{version}}-x64-setup.exe", "size": {{Setup.Length}}, "url": "https://api/assets/1", "digest": "sha256:{{digest ?? Sha(Setup)}}" },
            { "name": "Sonus-{{version}}-x64.msi", "size": 10, "url": "https://api/assets/2", "digest": null } ] }
        """;

    private static readonly string Listing = "[" + string.Join(",",
        Release("v1.0.0", draft: true, version: "1.0.0"),
        Release("v0.5.0-beta.1", pre: true, version: "0.5.0"),
        Release("v0.4.0", version: "0.4.0"),
        Release("v0.3.0", version: "0.3.0")) + "]";

    private sealed class FakeGitHub(Func<HttpRequestMessage, HttpResponseMessage> answer) : HttpMessageHandler
    {
        public readonly List<HttpRequestMessage> Requests = [];
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken ct) { Requests.Add(request); return Task.FromResult(answer(request)); }
    }

    private static HttpResponseMessage Ok(string json) => new(HttpStatusCode.OK) { Content = new StringContent(json, Encoding.UTF8, "application/json") };

    [Theory]
    [InlineData("v0.3.0", "0.3.0")]
    [InlineData("v0.4.0-beta.1", "0.4.0")]
    [InlineData("1.2", "1.2.0")]
    [InlineData("V2.0.0+build", "2.0.0")]
    public void ATagGivesItsNumbers(string tag, string version) => Assert.Equal(Version.Parse(version), GitHubUpdates.ParseTag(tag));

    [Theory]
    [InlineData("latest")]
    [InlineData("")]
    public void OtherTagsAreNotVersions(string tag) => Assert.Null(GitHubUpdates.ParseTag(tag));

    [Fact]
    public void DraftsAreLeftOutAndInstallersAreFoundByTheirNames()
    {
        var releases = GitHubUpdates.Parse(Listing);
        Assert.DoesNotContain(releases, r => r.Tag == "v1.0.0");
        var beta = Assert.Single(releases, r => r.IsPrerelease);
        Assert.Equal("0.5.0-beta.1", beta.DisplayVersion);
        var setup = releases.First(r => r.Tag == "v0.4.0").SetupFor("x64");
        Assert.NotNull(setup);
        Assert.Equal("Sonus-0.4.0-x64-setup.exe", setup.Name);
        Assert.Equal(Sha(Setup), setup.Sha256);
        Assert.Null(releases[0].SetupFor("ARM64")); // no ARM64 installer in this listing
    }

    [Fact]
    public void TheNewestFinalVersionIsOfferedOrABetaWhenAskedFor()
    {
        var releases = GitHubUpdates.Parse(Listing);
        Assert.Equal("v0.4.0", GitHubUpdates.Newest(releases, new Version(0, 3, 0, 0), false, "x64")?.Tag);
        Assert.Equal("v0.5.0-beta.1", GitHubUpdates.Newest(releases, new Version(0, 3, 0), true, "x64")?.Tag);
        Assert.Null(GitHubUpdates.Newest(releases, new Version(0, 4, 0), false, "x64")); // up to date
        Assert.Null(GitHubUpdates.Newest(releases, new Version(0, 3, 0), false, "ARM64")); // nothing to install
    }

    [Fact]
    public void TheFinalVersionWinsOverABetaWithTheSameNumbers()
    {
        var releases = GitHubUpdates.Parse("[" + Release("v0.4.0-beta.1", pre: true, version: "0.4.0") + "," + Release("v0.4.0", version: "0.4.0") + "]");
        Assert.Equal("v0.4.0", GitHubUpdates.Newest(releases, new Version(0, 3, 0), true, "x64")?.Tag);
    }

    [Fact]
    public async Task TheListIsAskedForWithoutSigningIn()
    {
        var fake = new FakeGitHub(_ => Ok(Listing));
        await new GitHubUpdates(new HttpClient(fake)).ReleasesAsync();
        var request = Assert.Single(fake.Requests);
        Assert.Null(request.Headers.Authorization); // the repository is public
        Assert.Contains(request.Headers.Accept, a => a.MediaType == "application/vnd.github+json");
        Assert.Equal("https://api.github.com/repos/CreeperUX/Sonus/releases?per_page=30", request.RequestUri?.ToString());
        Assert.NotEmpty(request.Headers.UserAgent);
    }

    [Theory]
    [InlineData(HttpStatusCode.NotFound, null, "找不到 CreeperUX/Sonus")]
    [InlineData(HttpStatusCode.Forbidden, "0", "请求次数")]
    [InlineData(HttpStatusCode.TooManyRequests, "0", "请求次数")]
    [InlineData(HttpStatusCode.Forbidden, "42", "403")]
    [InlineData(HttpStatusCode.BadGateway, null, "502")]
    public async Task WhatWentWrongIsSaid(HttpStatusCode status, string? remaining, string expected)
    {
        var fake = new FakeGitHub(_ =>
        {
            var response = new HttpResponseMessage(status);
            if (remaining is not null) response.Headers.Add("X-RateLimit-Remaining", remaining);
            return response;
        });
        var ex = await Assert.ThrowsAsync<UpdateException>(() => new GitHubUpdates(new HttpClient(fake)).ReleasesAsync());
        Assert.Contains(expected, ex.Message);
    }

    [Fact]
    public async Task TheDownloadIsCheckedAndReportsProgress()
    {
        var fake = new FakeGitHub(_ => new HttpResponseMessage(HttpStatusCode.OK) { Content = new ByteArrayContent(Setup) });
        var asset = GitHubUpdates.Parse(Listing).First(r => r.Tag == "v0.4.0").SetupFor("x64")!;
        string path = Path.Combine(_dir, "setup.exe");
        var seen = new List<double>();
        await new GitHubUpdates(new HttpClient(fake)).DownloadAsync(asset, path, new SyncProgress(seen.Add));
        Assert.Equal(Setup, File.ReadAllBytes(path));
        Assert.Equal("application/octet-stream", Assert.Single(fake.Requests).Headers.Accept.ToString());
        Assert.Equal(1.0, seen[^1]);
        Assert.False(File.Exists(path + ".part"));
    }

    [Fact]
    public async Task ADownloadWithTheWrongDigestLeavesNothing()
    {
        var fake = new FakeGitHub(_ => new HttpResponseMessage(HttpStatusCode.OK) { Content = new ByteArrayContent(Setup) });
        var release = GitHubUpdates.Parse("[" + Release("v0.4.0", version: "0.4.0", digest: new string('0', 64)) + "]")[0];
        string path = Path.Combine(_dir, "setup.exe");
        var ex = await Assert.ThrowsAsync<UpdateException>(() => new GitHubUpdates(new HttpClient(fake)).DownloadAsync(release.SetupFor("x64")!, path));
        Assert.Contains("校验不一致", ex.Message);
        Assert.False(File.Exists(path));
        Assert.False(File.Exists(path + ".part"));
    }

    // Progress<T> posts to the thread pool; this one reports in place
    private sealed class SyncProgress(Action<double> report) : IProgress<double> { public void Report(double value) => report(value); }
}
