using System.Globalization;
using System.Text.RegularExpressions;
using Sonus.Controls;
using Sonus.Core.Updates;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Automation;
using Microsoft.UI.Xaml.Controls;

namespace Sonus.Updates;

/// <summary>
/// "更新到 Sonus x", as Lumen's: what's new (the release notes), then downloading the installer with its
/// progress, then running it (the app closes). Closing the dialog during the download cancels it.
/// </summary>
public static partial class UpdateDialog
{
    private static bool _open;

    public static async Task ShowAsync(XamlRoot root, UpdateService updates, AppRelease release)
    {
        if (_open) return; // the pill and the settings button both open it: one at a time
        _open = true;
        var status = Ui.Text("", "MutedTextStyle");
        status.TextWrapping = TextWrapping.Wrap; status.Visibility = Visibility.Collapsed;
        AutomationProperties.SetName(status, "更新状态");
        AutomationProperties.SetLiveSetting(status, Microsoft.UI.Xaml.Automation.Peers.AutomationLiveSetting.Polite);
        var bar = new ProgressBar { Maximum = 1, Visibility = Visibility.Collapsed };
        AutomationProperties.SetName(bar, "下载进度");
        string when = release.PublishedAt == default ? "" : $" · 发布于 {release.PublishedAt.ToLocalTime().ToString("yyyy-MM-dd", CultureInfo.InvariantCulture)}";
        var intro = Ui.Text($"当前版本 {UpdateService.CurrentText}{when}{(release.IsPrerelease ? " · 测试版" : "")}。下载安装程序后 Sonus 会关闭，登录和设置保留。", "MutedTextStyle");
        intro.TextWrapping = TextWrapping.Wrap;
        var notes = new TextBlock { Text = Plain(release.Notes), TextWrapping = TextWrapping.Wrap, IsTextSelectionEnabled = true, FontSize = 13, LineHeight = 20, Foreground = Ui.Brush("TextPrimaryBrush") };
        AutomationProperties.SetName(notes, "版本说明");
        var dialog = Ui.ThemeDialog(new ContentDialog
        {
            XamlRoot = root,
            Title = $"更新到 Sonus {release.DisplayVersion}",
            Content = new StackPanel
            {
                Width = 480, Spacing = 12,
                Children = { intro, new ScrollViewer { MaxHeight = 300, Content = notes, Padding = new Thickness(0, 0, 12, 0) }, bar, status },
            },
            PrimaryButtonText = "下载并安装",
            CloseButtonText = "以后再说",
            DefaultButton = ContentDialogButton.Primary,
        });

        // not disposed: a download still finishing after the dialog closed may look at it
        var cancel = new CancellationTokenSource();
        dialog.Closing += (_, _) => cancel.Cancel(); // closed mid-download: stop it
        dialog.PrimaryButtonClick += async (_, args) =>
        {
            args.Cancel = true; // the dialog stays up to show the download
            var deferral = args.GetDeferral();
            dialog.IsPrimaryButtonEnabled = false;
            bar.Value = 0;
            bar.Visibility = status.Visibility = Visibility.Visible;
            status.Text = "正在下载安装程序…";
            try
            {
                string path = await updates.DownloadAsync(release, new Progress<double>(p => bar.Value = p), cancel.Token);
                status.Text = "下载完成，已校验。正在打开安装程序，Sonus 会关闭…";
                deferral.Complete(); deferral = null;
                await UpdateService.RunInstallerAsync(path);
            }
            catch (UpdateException ex)
            {
                status.Text = ex.Message;
                dialog.PrimaryButtonText = "重试";
                dialog.IsPrimaryButtonEnabled = true;
            }
            catch (OperationCanceledException) { } // the dialog was closed
            finally { deferral?.Complete(); }
        };
        try { await dialog.ShowAsync(); }
        finally { _open = false; }
    }

    /// <summary>
    /// The release notes' Markdown as readable plain text: no heading marks, emphasis or link syntax; a table's rows as
    /// "a · b" (its header row and rule left out); list items with a bullet.
    /// </summary>
    internal static string Plain(string markdown)
    {
        var lines = markdown.Replace("\r\n", "\n").Split('\n');
        var output = new List<string>();
        for (int i = 0; i < lines.Length; i++)
        {
            string line = lines[i];
            if (line.TrimStart().StartsWith('|'))
            {
                if (TableRule().IsMatch(line)) continue;
                if (i + 1 < lines.Length && TableRule().IsMatch(lines[i + 1])) continue; // the header row
                output.Add(string.Join(" · ", line.Trim().Trim('|').Split('|').Select(c => c.Trim()).Where(c => c.Length > 0)));
                continue;
            }
            output.Add(ListMark().Replace(HeadingMarks().Replace(line, ""), "$1• "));
        }
        string text = string.Join("\n", output).Replace("**", "").Replace("`", "");
        return Links().Replace(text, "$1").Trim();
    }

    [GeneratedRegex(@"^#{1,6}\s*")]
    private static partial Regex HeadingMarks();

    [GeneratedRegex(@"^\s*\|?(\s*:?-{3,}:?\s*\|)+\s*:?-*:?\s*\|?\s*$")]
    private static partial Regex TableRule();

    [GeneratedRegex(@"^(\s*)[-*]\s+")]
    private static partial Regex ListMark();

    [GeneratedRegex(@"\[([^\]]+)\]\([^)]+\)")]
    private static partial Regex Links();
}
