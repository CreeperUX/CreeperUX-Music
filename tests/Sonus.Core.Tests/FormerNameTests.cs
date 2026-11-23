namespace Sonus.Core.Tests;

/// <summary>Sonus taking over what CreeperUX Music (its name up to 0.3) left: the data folder and the client name.</summary>
public sealed class FormerNameTests : IDisposable
{
    private readonly string _root = Path.Combine(Path.GetTempPath(), "sonus-former-" + Guid.NewGuid().ToString("N"));
    private string Former => Path.Combine(_root, "CreeperUX Music");
    private string New => Path.Combine(_root, "Sonus");

    public FormerNameTests()
    {
        Directory.CreateDirectory(Former);
        File.WriteAllText(Path.Combine(Former, "settings.json"), """{ "Volume": 0.42 }""");
        File.WriteAllText(Path.Combine(Former, "app.log"), "old log\n");
        Directory.CreateDirectory(Path.Combine(Former, "update"));
        File.WriteAllText(Path.Combine(Former, "update", "note.txt"), "x");
    }

    public void Dispose() { if (Directory.Exists(_root)) Directory.Delete(_root, recursive: true); }

    [Fact]
    public void TheFormerFolderMovesOnce()
    {
        string? done = AppName.AdoptFolder(Former, New);
        Assert.StartsWith("moved ", done);
        Assert.False(Directory.Exists(Former));
        Assert.Equal("""{ "Volume": 0.42 }""", File.ReadAllText(Path.Combine(New, "settings.json")));
        Assert.True(File.Exists(Path.Combine(New, "update", "note.txt")));
        Assert.Null(AppName.AdoptFolder(Former, New)); // nothing left to take
    }

    [Fact]
    public void AnExistingNewFolderIsKept()
    {
        Directory.CreateDirectory(New);
        File.WriteAllText(Path.Combine(New, "settings.json"), """{ "Volume": 0.9 }""");
        Assert.Null(AppName.AdoptFolder(Former, New));
        Assert.Equal("""{ "Volume": 0.9 }""", File.ReadAllText(Path.Combine(New, "settings.json")));
        Assert.True(Directory.Exists(Former)); // left alone
    }

    [Fact]
    public void NoFormerFolderNothingToDo()
    {
        Directory.Delete(Former, recursive: true);
        Assert.Null(AppName.AdoptFolder(Former, New));
        Assert.False(Directory.Exists(New));
    }

    [Fact]
    public void AFileHeldOpenMeansACopy()
    {
        // the former build still running, its log open: the folder can't be moved, its files are copied
        using (new FileStream(Path.Combine(Former, "app.log"), FileMode.Open, FileAccess.ReadWrite, FileShare.Read))
        {
            string? done = AppName.AdoptFolder(Former, New);
            Assert.StartsWith("copied ", done);
        }
        Assert.Equal("""{ "Volume": 0.42 }""", File.ReadAllText(Path.Combine(New, "settings.json")));
        Assert.True(File.Exists(Path.Combine(New, "update", "note.txt")));
        Assert.True(File.Exists(Path.Combine(Former, "settings.json"))); // the former folder stays as it was
    }

    [Theory]
    [InlineData("Sonus (PC)", "PC")]
    [InlineData("Sonus (测试 第二台)", "测试 第二台")]
    [InlineData("CreeperUX Music (书房)", "书房")]
    [InlineData("Symfonium", "Symfonium")]
    [InlineData("Sonus", "Sonus")]
    public void TheDeviceInAClientName(string client, string device) => Assert.Equal(device, AppName.DeviceOf(client));

    [Fact]
    public void TheClientName() => Assert.Equal("Sonus (PC)", AppName.Client("PC"));
}
