using Sonus.Core.Audio;

namespace Sonus.Playback;

/// <summary>
/// Internal contract implemented by both <see cref="NativeAudioBackend"/> (built-in pure C# decoders over WASAPI)
/// and <see cref="LegacyAudioBackend"/> (Windows Media Foundation MediaPlayer). <see cref="AudioEngine"/>
/// delegates to the active backend so upper layers see one stable API.
/// </summary>
internal interface IAudioBackend : IDisposable
{
    EngineState State { get; }
    string? CurrentId { get; }
    string? NextId { get; }
    double Position { get; }
    double? Duration { get; }
    string? Error { get; }
    StreamMetadata? ActiveStream { get; }
    double Volume { get; set; }
    bool Muted { get; set; }
    double GainMultiplier { get; set; }

    event Action? StateChanged;
    event Action<string>? Advanced;
    event Action? Ended;
    event Action? NextRequested;
    event Action? PreviousRequested;

    void Load(EngineItem item, EngineItem? next, bool autoplay);
    void SetNext(EngineItem? next);
    void Play();
    void Pause();
    void Stop();
    void Seek(double seconds);
    Task SetOutputAsync(string? deviceId);
}
