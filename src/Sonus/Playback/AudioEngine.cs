using Microsoft.UI.Dispatching;
using Sonus.Core.Audio;
using Windows.Devices.Enumeration;
using Windows.Media.Devices;

namespace Sonus.Playback;

/// <summary>What the engine is doing.</summary>
public enum EngineState { Stopped, Loading, Playing, Paused, Error }

/// <summary>A song for the engine: its stream and what the system media controls show.</summary>
public sealed record EngineItem(string Id, string Url, string Title, string Artist, string Album, string? CoverUrl, double StartAt = 0);

/// <summary>An audio output the computer has.</summary>
public sealed record OutputDevice(string Id, string Name, bool IsDefault);

/// <summary>
/// Audio playback engine facade preserving one stable API for <see cref="Services.MusicService"/> while
/// allowing the active backend to be switched between the built-in pure C# + WASAPI core (<see cref="AudioCore.Native"/>)
/// and the legacy Windows Media Foundation MediaPlayer core (<see cref="AudioCore.Legacy"/>).
/// </summary>
public sealed class AudioEngine : IDisposable
{
    private readonly DispatcherQueue _ui;
    private IAudioBackend _backend;
    private AudioCore _core;
    private string? _outputDeviceId;
    private double _volume = 1;
    private bool _muted;
    private double _gainMultiplier = 1;
    private bool _disposed;

    public AudioEngine(DispatcherQueue ui, AudioCore core = AudioCore.Native)
    {
        _ui = ui;
        _core = core;
        _backend = CreateBackend(core);
    }

    public AudioCore Core => _core;
    public EngineState State => _backend.State;
    /// <summary>The song the engine has loaded (playing or paused), or null.</summary>
    public string? CurrentId => _backend.CurrentId;
    /// <summary>The song loaded after it (it starts by itself when the current one ends), or null.</summary>
    public string? NextId => _backend.NextId;
    public double Position => _backend.Position;
    public double? Duration => _backend.Duration;
    public string? Error => _backend.Error;
    /// <summary>Stream headers captured by the active backend (X-Sonus-* rendition info when available).</summary>
    public StreamMetadata? ActiveStream => _backend.ActiveStream;

    public double Volume
    {
        get => _volume;
        set { _volume = Math.Clamp(value, 0, 1); _backend.Volume = _volume; }
    }

    public bool Muted
    {
        get => _muted;
        set { _muted = value; _backend.Muted = value; }
    }

    /// <summary>Additional linear gain multiplier (e.g. loudness normalization; may exceed 1.0 on the native core).</summary>
    public double GainMultiplier
    {
        get => _gainMultiplier;
        set { _gainMultiplier = Math.Max(0, value); _backend.GainMultiplier = _gainMultiplier; }
    }

    public event Action? StateChanged;
    /// <summary>The next song started by itself when the previous one ended (gapless): its id.</summary>
    public event Action<string>? Advanced;
    /// <summary>The last loaded song ended and nothing followed.</summary>
    public event Action? Ended;
    public event Action? NextRequested, PreviousRequested;

    /// <summary>Switches between the native and legacy playback cores, stopping any current stream first.</summary>
    public void SetCore(AudioCore core)
    {
        if (_disposed || core == _core) return;
        Log.Write($"[engine] switching playback core: {_core} -> {core}");
        var old = _backend;
        _core = core;
        _backend = CreateBackend(core);
        old.Stop();
        old.Dispose();
        if (!string.IsNullOrEmpty(_outputDeviceId)) _ = _backend.SetOutputAsync(_outputDeviceId);
        StateChanged?.Invoke();
    }

    private IAudioBackend CreateBackend(AudioCore core)
    {
        IAudioBackend b = core == AudioCore.Legacy ? new LegacyAudioBackend(_ui) : new NativeAudioBackend(_ui);
        b.Volume = _volume;
        b.Muted = _muted;
        b.GainMultiplier = _gainMultiplier;
        b.StateChanged += () => { if (ReferenceEquals(_backend, b)) StateChanged?.Invoke(); };
        b.Advanced += id => { if (ReferenceEquals(_backend, b)) Advanced?.Invoke(id); };
        b.Ended += () => { if (ReferenceEquals(_backend, b)) Ended?.Invoke(); };
        b.NextRequested += () => { if (ReferenceEquals(_backend, b)) NextRequested?.Invoke(); };
        b.PreviousRequested += () => { if (ReferenceEquals(_backend, b)) PreviousRequested?.Invoke(); };
        return b;
    }

    public void Load(EngineItem item, EngineItem? next, bool autoplay) => _backend.Load(item, next, autoplay);
    public void SetNext(EngineItem? next) => _backend.SetNext(next);
    public void Play() => _backend.Play();
    public void Pause() => _backend.Pause();
    public void Stop() => _backend.Stop();
    public void Seek(double seconds) => _backend.Seek(seconds);

    // ---------------------------------------------------------------- output devices
    public static async Task<List<OutputDevice>> OutputDevicesAsync()
    {
        string? defaultId = MediaDevice.GetDefaultAudioRenderId(AudioDeviceRole.Default);
        var devices = await DeviceInformation.FindAllAsync(MediaDevice.GetAudioRenderSelector());
        return [new OutputDevice("", "系统默认设备", true), .. devices.Select(d => new OutputDevice(d.Id, d.Name, d.Id == defaultId))];
    }

    /// <summary>Plays to a device; "" or null follows Windows' default.</summary>
    public Task SetOutputAsync(string? deviceId)
    {
        _outputDeviceId = deviceId;
        return _backend.SetOutputAsync(deviceId);
    }

    public void Dispose()
    {
        if (_disposed) return;
        _disposed = true;
        _backend.Dispose();
    }
}
