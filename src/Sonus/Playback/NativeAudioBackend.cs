using System.Collections.Concurrent;
using System.Diagnostics;
using System.Runtime.InteropServices;
using Microsoft.UI.Dispatching;
using NAudio.CoreAudioApi;
using NAudio.Wave;
using Sonus.Core.Audio;

namespace Sonus.Playback;

/// <summary>
/// Built-in Windows playback backend: pure C# decoders (FLAC, Ogg/Opus, WAV, MP3) fed by HTTP Range streaming
/// into a decoupled ring buffer and rendered directly via WASAPI (<see cref="WasapiPlayer"/>), with Windows
/// System Media Transport Controls (<see cref="SmtcBridge"/>).
///
/// Design invariants:
/// - All network I/O and decoding happen off the UI thread and off the real-time WASAPI audio thread.
/// - Seeking uses FLAC SEEKTABLE / Ogg granule bisection / WAV O(1) offset for sub-second response even on
///   96/192 kHz 24-bit FLACs, including immediate seeks right after playback starts and mid-song takeovers.
/// - Preloaded next tracks open only their 128 KB prefix so gapless transitions splice at 0 samples without
///   holding extra idle streaming sockets.
/// - Honors SONUS_E2E_SILENT=1 by running the full decode/resample/WASAPI clock while outputting digital silence,
///   preserving logical Volume/Muted values for E2E checks.
/// </summary>
internal sealed class NativeAudioBackend : IAudioBackend
{
    private const long NoPendingSeek = long.MinValue;
    private static readonly bool Silent = Environment.GetEnvironmentVariable("SONUS_E2E_SILENT") == "1";

    private readonly DispatcherQueue _ui;
    private readonly BlockingCollection<Action> _work = [];
    private readonly Thread _engineThread;
    private readonly SmtcBridge _smtc;
    private readonly ManualResetEventSlim _wakeDecode = new(false);

    // WASAPI output (created lazily on engine thread, reused across tracks until output device changes)
    private readonly object _outputLock = new();
    private WasapiPlayer? _wasapi;
    private PcmRingBuffer? _ring;
    private RenderWaveProvider? _renderProvider;
    private int _outRate = 48000;
    private int _outChannels = 2;
    private string? _outputDeviceId;

    // Headless fallback timer if the machine has no active audio render endpoint
    private Timer? _headlessClock;
    private bool _headlessMode;

    // Per-load generation and cancellation
    private int _generation;
    private int _ringGeneration; // only equals _generation once DecodeLoopAsync has cleared _ring and produced PCM for this load
    private int _firstAudioPostedGen;
    private CancellationTokenSource? _decodeCts;
    private CancellationTokenSource? _preloadCts;
    private HttpAudioStream? _activeHttp;

    // Preloaded next track handoff between preload task and decode loop
    private readonly object _preloadLock = new();
    private DecodedTrack? _readyNext;
    private HttpAudioStream? _readyNextHttp;
    private int _nextVersion;
    private bool _nextCleared;

    // Atomic seek handoff from Seek() to DecodeLoopAsync
    private long _pendingSeekBits = NoPendingSeek;
    private volatile bool _initialHeaderDone;

    // Playback state read from UI thread, updated from engine / audio threads
    private volatile EngineState _state = EngineState.Stopped;
    private volatile string? _currentId, _nextId, _error;
    private volatile StreamMetadata? _activeStream;
    private double _position;
    private double _volume = 1.0;
    private double _gainMultiplier = 1.0;
    private double? _duration;
    private volatile bool _muted;
    private volatile bool _wantPlay;
    private volatile bool _audioStartedForGen;
    private volatile bool _endedSignaledForGen;
    private volatile bool _buffering;
    private long _trackOriginFrame;
    private double _trackOriginSeconds;
    private float _smoothedGain = 1.0f;

    // Fallback legacy backend for formats outside the built-in decoders (e.g. M4A/AAC/ALAC/Vorbis)
    private LegacyAudioBackend? _fallback;
    private volatile bool _usingFallback;

    private Timer? _timelineTimer;
    private Stopwatch? _loadClock;
    private bool _disposed;

    public NativeAudioBackend(DispatcherQueue ui)
    {
        _ui = ui;
        _smtc = new SmtcBridge(ui);
        _smtc.PlayPressed += () => Play();
        _smtc.PausePressed += () => Pause();
        _smtc.NextPressed += () => Post(() => NextRequested?.Invoke());
        _smtc.PreviousPressed += () => Post(() => PreviousRequested?.Invoke());

        _engineThread = new Thread(RunEngineLoop) { IsBackground = true, Name = "audio engine (native)" };
        _engineThread.SetApartmentState(ApartmentState.MTA);
        _engineThread.Start();
        Do(() =>
        {
            _smtc.Initialize();
            _timelineTimer = new Timer(_ => Do(UpdateSmtcTimeline), null, 1000, 1000);
        });
    }

    public EngineState State => _usingFallback && _fallback is not null ? _fallback.State : _state;
    public string? CurrentId => _usingFallback && _fallback is not null ? _fallback.CurrentId : _currentId;
    public string? NextId => _usingFallback && _fallback is not null ? _fallback.NextId : _nextId;
    public double Position => _usingFallback && _fallback is not null ? _fallback.Position : Volatile.Read(ref _position);
    public double? Duration => _usingFallback && _fallback is not null ? _fallback.Duration : _duration;
    public string? Error => _usingFallback && _fallback is not null ? _fallback.Error : _error;
    public StreamMetadata? ActiveStream => _usingFallback ? null : _activeStream;

    public double Volume
    {
        get => Volatile.Read(ref _volume);
        set
        {
            double v = Math.Clamp(value, 0, 1);
            Volatile.Write(ref _volume, v);
            if (_fallback is { } fb) fb.Volume = v;
        }
    }

    public bool Muted
    {
        get => _muted;
        set
        {
            _muted = value;
            if (_fallback is { } fb) fb.Muted = value;
        }
    }

    public double GainMultiplier
    {
        get => Volatile.Read(ref _gainMultiplier);
        set
        {
            double g = Math.Max(0, value);
            Volatile.Write(ref _gainMultiplier, g);
            if (_fallback is { } fb) fb.GainMultiplier = g;
        }
    }

    public event Action? StateChanged;
    public event Action<string>? Advanced;
    public event Action? Ended;
    public event Action? NextRequested;
    public event Action? PreviousRequested;

    private void RunEngineLoop()
    {
        foreach (var action in _work.GetConsumingEnumerable())
        {
            try { action(); }
            catch (Exception ex) { Log.Write($"[engine] {ex.GetType().Name}: {ex.Message}"); }
        }
    }

    private void Do(Action action)
    {
        try { _work.Add(action); }
        catch (InvalidOperationException) { /* disposed */ }
    }

    private void Post(int generation, Action action) => Post(() => { if (generation == Volatile.Read(ref _generation)) action(); });
    private void Post(Action action) => _ui.TryEnqueue(() => { try { action(); } catch (Exception ex) { Log.Write($"[engine ui] {ex}"); } });

    // ---------------------------------------------------------------- public commands (from UI thread, return immediately)
    public void Load(EngineItem item, EngineItem? next, bool autoplay)
    {
        int gen = Interlocked.Increment(ref _generation);
        // Immediately gate RenderAudio off the previous track's ring data before clearing _ring on the engine thread
        Volatile.Write(ref _ringGeneration, 0);
        _usingFallback = false;
        _error = null;
        _currentId = item.Id;
        _nextId = next?.Id;
        _duration = null;
        _activeStream = null;
        _wantPlay = autoplay;
        _audioStartedForGen = false;
        _endedSignaledForGen = false;
        _buffering = false;
        _initialHeaderDone = false;
        Interlocked.Exchange(ref _pendingSeekBits, NoPendingSeek);
        Volatile.Write(ref _position, Math.Max(0, item.StartAt));
        Volatile.Write(ref _trackOriginFrame, 0);
        Volatile.Write(ref _trackOriginSeconds, Math.Max(0, item.StartAt));

        CancelCurrentWorkers();
        SetState(autoplay ? EngineState.Loading : EngineState.Paused);

        Do(() =>
        {
            if (gen != Volatile.Read(ref _generation)) return;
            _fallback?.Stop();
            StopOutputLocked();
            _ring?.Clear();
            ClearReadyNext();

            _smtc.UpdateMetadata(item);
            _smtc.UpdateStatus(autoplay ? EngineState.Loading : EngineState.Paused);
            _loadClock = autoplay ? Stopwatch.StartNew() : null;

            var cts = new CancellationTokenSource();
            _decodeCts = cts;
            _ = Task.Run(() => DecodeLoopAsync(gen, item, next, autoplay, cts.Token));
        });
    }

    public void SetNext(EngineItem? next)
    {
        if (_usingFallback && _fallback is not null) { _fallback.SetNext(next); return; }
        if (next?.Id == _nextId) return;
        _nextId = next?.Id;
        int gen = Volatile.Read(ref _generation);
        Do(() =>
        {
            if (gen != Volatile.Read(ref _generation) || _currentId is null) return;
            CancelPreloadWorker();
            ClearReadyNext(markCleared: true);
            if (next is not null) StartPreload(gen, next);
            _wakeDecode.Set();
        });
    }

    public void Play()
    {
        if (_usingFallback && _fallback is not null) { _fallback.Play(); return; }
        if (_state is EngineState.Error or EngineState.Stopped) return;
        _wantPlay = true;
        int gen = Volatile.Read(ref _generation);
        if (_state == EngineState.Paused) SetState(EngineState.Loading);
        Do(() =>
        {
            if (gen != Volatile.Read(ref _generation)) return;
            _wantPlay = true;
            if (Volatile.Read(ref _ringGeneration) == gen && (_ring is { AvailableFrames: > 0 } || _ring is { ProducerEof: true }))
            {
                EnsureOutputInitialized();
                StartOutputLocked();
                SetState(EngineState.Playing);
                _smtc.UpdateStatus(EngineState.Playing);
            }
            _wakeDecode.Set();
        });
    }

    public void Pause()
    {
        if (_usingFallback && _fallback is not null) { _fallback.Pause(); return; }
        _wantPlay = false;
        if (_state is EngineState.Playing or EngineState.Loading) SetState(EngineState.Paused);
        Do(() =>
        {
            _wantPlay = false;
            PauseOutputLocked();
            _smtc.UpdateStatus(EngineState.Paused);
        });
    }

    public void Stop()
    {
        Interlocked.Increment(ref _generation);
        Volatile.Write(ref _ringGeneration, 0);
        _usingFallback = false;
        _wantPlay = false;
        _currentId = null;
        _nextId = null;
        _duration = null;
        _activeStream = null;
        _error = null;
        CancelCurrentWorkers();
        SetState(EngineState.Stopped);
        Do(() =>
        {
            _fallback?.Stop();
            StopOutputLocked();
            _ring?.Clear();
            ClearReadyNext();
            _smtc.Clear();
        });
    }

    public void Seek(double seconds)
    {
        if (_usingFallback && _fallback is not null) { _fallback.Seek(seconds); return; }
        double target = Math.Max(0, seconds);
        Volatile.Write(ref _position, target);
        Interlocked.Exchange(ref _pendingSeekBits, BitConverter.DoubleToInt64Bits(target));
        // If we are already past header parsing, abort any blocked sequential HTTP read so seek runs at once
        if (_initialHeaderDone)
        {
            try { _activeHttp?.AbortActiveStream(); } catch { }
        }
        _wakeDecode.Set();
    }

    public async Task SetOutputAsync(string? deviceId)
    {
        var done = new TaskCompletionSource();
        Do(() =>
        {
            try
            {
                _outputDeviceId = string.IsNullOrEmpty(deviceId) ? null : deviceId;
                bool wasPlaying = _wantPlay && _state == EngineState.Playing;
                RecreateOutputLocked(wasPlaying);
                done.SetResult();
            }
            catch (Exception ex) { done.SetException(ex); }
        });
        await done.Task;
        if (_fallback is { } fb) await fb.SetOutputAsync(deviceId);
    }

    // ---------------------------------------------------------------- decode producer loop (thread pool)
    private async Task DecodeLoopAsync(int gen, EngineItem item, EngineItem? initialNext, bool autoplay, CancellationToken ct)
    {
        GaplessAudioPipeline? pipeline = null;
        HttpAudioStream? http = null;
        try
        {
            // Ensure WASAPI output format is known before constructing the pipeline
            EnsureOutputInitialized();
            if (ct.IsCancellationRequested || gen != Volatile.Read(ref _generation)) return;

            int outRate = _outRate;
            int outCh = _outChannels;

            // Open HTTP stream: use header-only probe when starting mid-song so we never download audio before StartAt
            bool midStart = item.StartAt > 0.25;
            http = await HttpAudioStream.OpenAsync(HttpAudioStream.SharedClient, new Uri(item.Url), initialProbeOnly: midStart, ct: ct)
                .ConfigureAwait(false);
            http.OnDiagnostic = msg => Log.Write($"[engine] {item.Id}: {msg}");
            _activeHttp = http;

            if (ct.IsCancellationRequested || gen != Volatile.Read(ref _generation))
            {
                http.Dispose();
                return;
            }

            var meta = http.Metadata;
            IAudioDecoder decoder;
            try
            {
                decoder = AudioDecoderFactory.Open(http, meta.ContentType, ownsStream: true,
                    onDiagnostic: msg => Log.Write($"[engine] {item.Id}: {msg}"));
                http = null; // owned by decoder now
            }
            catch (UnsupportedAudioFormatException ex)
            {
                Log.Write($"[engine] {item.Id}: {ex.Message} -> delegating to legacy backend");
                http?.Dispose();
                http = null;
                if (!ct.IsCancellationRequested && gen == Volatile.Read(ref _generation))
                    DelegateToFallback(gen, item, initialNext, autoplay);
                return;
            }

            var currentTrack = new DecodedTrack(item.Id, decoder, meta, item);
            pipeline = new GaplessAudioPipeline(outRate, outCh) { ApplyGainInPipeline = false };

            double actualStart = 0;
            if (item.StartAt > 0 && decoder.CanSeek)
            {
                long targetSample = (long)Math.Round(item.StartAt * decoder.SampleRate);
                decoder.SeekSample(targetSample);
                actualStart = decoder.SampleRate > 0 ? decoder.CurrentSample / (double)decoder.SampleRate : item.StartAt;
            }
            pipeline.SetCurrent(currentTrack, actualStart);
            _initialHeaderDone = true;

            if (ct.IsCancellationRequested || gen != Volatile.Read(ref _generation)) return;

            _duration = decoder.DurationSeconds > 0 ? decoder.DurationSeconds : null;
            _activeStream = currentTrack.Metadata;
            Volatile.Write(ref _trackOriginFrame, 0);
            Volatile.Write(ref _trackOriginSeconds, actualStart);
            Volatile.Write(ref _position, actualStart);
            // Only now (after the old ring has been cleared) allow RenderAudio to consume this generation's frames
            _ring?.Clear();
            Volatile.Write(ref _ringGeneration, gen);

            // Start preloading the next song right away (128 KB prefix only, zero idle connections)
            if (initialNext is not null)
                Do(() => { if (gen == Volatile.Read(ref _generation)) StartPreload(gen, initialNext); });

            float[] chunk = new float[2048 * outCh];
            var transitions = new List<TrackTransition>(2);
            int seenNextVersion = -1;
            bool outputStarted = false;
            int minStartFrames = Math.Max(1024, outRate / 20); // ~50 ms before unpausing WASAPI

            while (!ct.IsCancellationRequested && gen == Volatile.Read(ref _generation))
            {
                // 1. Handle any pending Seek immediately
                long seekBits = Interlocked.Exchange(ref _pendingSeekBits, NoPendingSeek);
                if (seekBits != NoPendingSeek)
                {
                    double targetSec = BitConverter.Int64BitsToDouble(seekBits);
                    try
                    {
                        double landed = pipeline.SeekCurrent(targetSec);
                        lock (_outputLock)
                        {
                            if (_wasapi is not null && _wasapi.PlaybackState == PlaybackState.Playing)
                                _wasapi.Stop();
                            _ring?.Clear();
                        }
                        Volatile.Write(ref _trackOriginFrame, 0);
                        Volatile.Write(ref _trackOriginSeconds, landed);
                        Volatile.Write(ref _position, landed);
                        _buffering = false;
                        _endedSignaledForGen = false;
                        outputStarted = false;
                    }
                    catch (OperationCanceledException) { break; }
                    catch (Exception ex) when (ex is not OperationCanceledException)
                    {
                        Log.Write($"[engine] seek to {targetSec:0.0}s failed on {_currentId}: {ex.Message}");
                    }
                }

                // 2. Attach or clear preloaded Next track whenever SetNext updated it
                AttachPendingNext(pipeline, ref seenNextVersion);

                var ring = _ring;
                if (ring is null) break;

                // 3. Produce PCM into ring buffer if there is room
                if (!ring.ProducerEof && ring.FreeFrames >= 2048)
                {
                    transitions.Clear();
                    int got;
                    try
                    {
                        got = pipeline.Read(chunk, transitions);
                    }
                    catch (OperationCanceledException) { break; }
                    catch (IOException) when (Interlocked.Read(ref _pendingSeekBits) != NoPendingSeek)
                    {
                        // Active HTTP stream was intentionally aborted by Seek(): loop back to execute seek!
                        continue;
                    }

                    if (got > 0)
                    {
                        int framesWritten = ring.Write(chunk.AsSpan(0, got), transitions.Count > 0 ? transitions : null);
                        // When a preloaded next track is promoted to current, immediately open its streaming
                        // connection past the 64 KB prefix so playback continues smoothly without delay.
                        if (transitions.Count > 0)
                        {
                            HttpAudioStream? promotedHttp;
                            lock (_preloadLock) { promotedHttp = _attachedNextHttp; _attachedNextHttp = null; }
                            _activeHttp = promotedHttp;
                            try { promotedHttp?.PromoteToStreaming(); } catch (OperationCanceledException) { break; } catch { }
                        }

                        // Start WASAPI output as soon as ~50 ms is buffered and playback is wanted
                        if (_wantPlay && !outputStarted && ring.AvailableFrames >= minStartFrames)
                        {
                            outputStarted = true;
                            Do(() =>
                            {
                                if (gen != Volatile.Read(ref _generation) || !_wantPlay) return;
                                StartOutputLocked();
                            });
                        }
                        else if (_buffering && _wantPlay && ring.AvailableFrames >= minStartFrames)
                        {
                            _buffering = false;
                            Do(() =>
                            {
                                if (gen != Volatile.Read(ref _generation) || !_wantPlay) return;
                                SetState(EngineState.Playing);
                                _smtc.UpdateStatus(EngineState.Playing);
                            });
                        }
                        if (framesWritten > 0) continue;
                    }
                    else
                    {
                        ring.MarkEof();
                        // Very short track (< 50 ms) that already hit EOF: still start WASAPI so it plays & fires Ended
                        if (_wantPlay && !outputStarted)
                        {
                            outputStarted = true;
                            Do(() =>
                            {
                                if (gen != Volatile.Read(ref _generation) || !_wantPlay) return;
                                StartOutputLocked();
                            });
                        }
                    }
                }

                // 4. Ring is full or at EOF: sleep until consumer frees space or Seek/SetNext/Stop wakes us
                _wakeDecode.Reset();
                if (Interlocked.Read(ref _pendingSeekBits) != NoPendingSeek) continue;
                try { _wakeDecode.Wait(25, ct); }
                catch (OperationCanceledException) { break; }
            }
        }
        catch (OperationCanceledException)
        {
            // Normal cancellation on Load/Stop/Dispose
        }
        catch (Exception ex)
        {
            if (!ct.IsCancellationRequested && gen == Volatile.Read(ref _generation))
            {
                string msg = DescribeException(ex);
                Log.Write($"[engine] {item.Id} failed ({ex.GetType().Name}): {ex.Message}");
                Do(() =>
                {
                    if (gen != Volatile.Read(ref _generation)) return;
                    _error = msg;
                    _wantPlay = false;
                    StopOutputLocked();
                    SetState(EngineState.Error);
                    _smtc.UpdateStatus(EngineState.Stopped);
                });
            }
        }
        finally
        {
            _activeHttp = null;
            http?.Dispose();
            pipeline?.Dispose();
        }
    }

    private void StartPreload(int gen, EngineItem next)
    {
        CancelPreloadWorker();
        var cts = new CancellationTokenSource();
        _preloadCts = cts;
        var ct = cts.Token;

        _ = Task.Run(async () =>
        {
            HttpAudioStream? http = null;
            try
            {
                // Fetch only the first 128 KB prefix so headers + SEEKTABLE + first audio frames are cached in RAM
                // without keeping an extra streaming TCP connection open while the current song plays.
                http = await HttpAudioStream.OpenAsync(HttpAudioStream.SharedClient, new Uri(next.Url), initialProbeOnly: true, ct: ct)
                    .ConfigureAwait(false);
                http.OnDiagnostic = msg => Log.Write($"[engine] preload {next.Id}: {msg}");
                if (ct.IsCancellationRequested || gen != Volatile.Read(ref _generation)) { http.Dispose(); return; }

                var meta = http.Metadata;
                var httpRef = http;
                var decoder = AudioDecoderFactory.Open(http, meta.ContentType, ownsStream: true,
                    onDiagnostic: msg => Log.Write($"[engine] {next.Id}: {msg}"));
                http = null;
                StoreReadyNext(gen, next, decoder, meta, httpRef);
            }
            catch (OperationCanceledException)
            {
                http?.Dispose();
            }
            catch (Exception ex)
            {
                http?.Dispose();
                // Preloaded next song failed (e.g. missing file or unsupported format): drop silently now so it is
                // loaded fresh (and properly reported or delegated) when its turn comes.
                Log.Write($"[engine] preload {next.Id} skipped ({ex.GetType().Name}): {ex.Message}");
                if (gen == Volatile.Read(ref _generation) && _nextId == next.Id) _nextId = null;
            }
        });
    }

    private HttpAudioStream? _attachedNextHttp;

    private void StoreReadyNext(int gen, EngineItem item, IAudioDecoder decoder, StreamMetadata meta, HttpAudioStream httpRef)
    {
        lock (_preloadLock)
        {
            if (gen != Volatile.Read(ref _generation)) { decoder.Dispose(); return; }
            _readyNext?.Dispose();
            _readyNext = new DecodedTrack(item.Id, decoder, meta, item);
            _readyNextHttp = httpRef;
            _nextCleared = false;
            _nextVersion++;
        }
        _wakeDecode.Set();
    }

    private void ClearReadyNext(bool markCleared = false)
    {
        lock (_preloadLock)
        {
            _readyNext?.Dispose();
            _readyNext = null;
            _readyNextHttp = null;
            if (markCleared) { _nextCleared = true; _nextVersion++; }
        }
    }

    private void AttachPendingNext(GaplessAudioPipeline pipeline, ref int seenVersion)
    {
        DecodedTrack? toAttach = null;
        HttpAudioStream? toAttachHttp = null;
        bool shouldClear = false;
        lock (_preloadLock)
        {
            if (_nextVersion == seenVersion) return;
            seenVersion = _nextVersion;
            if (_nextCleared)
            {
                shouldClear = true;
                _nextCleared = false;
                _attachedNextHttp = null;
            }
            else if (_readyNext is not null)
            {
                toAttach = _readyNext;
                toAttachHttp = _readyNextHttp;
                _readyNext = null;
                _readyNextHttp = null;
                _attachedNextHttp = toAttachHttp;
            }
        }
        if (shouldClear) pipeline.SetNext(null);
        else if (toAttach is not null) pipeline.SetNext(toAttach);
    }

    // ---------------------------------------------------------------- WASAPI output management
    private void EnsureOutputInitialized()
    {
        lock (_outputLock)
        {
            if (_wasapi is not null || _headlessMode) return;
            CreateOutputLocked();
        }
    }

    private void RecreateOutputLocked(bool restartPlaying)
    {
        lock (_outputLock)
        {
            DisposeOutputLocked();
            CreateOutputLocked();
            if (restartPlaying) StartOutputLocked();
        }
    }

    private void CreateOutputLocked()
    {
        try
        {
            WasapiPlayer player;
            if (string.IsNullOrEmpty(_outputDeviceId))
            {
                player = new WasapiPlayerBuilder()
                    .WithDefaultDeviceStreamRouting()
                    .WithSharedMode()
                    .WithEventSync()
                    .WithLatency(60)
                    .WithCategory(AudioStreamCategory.Media)
                    .WithMmcssThreadPriority("Audio")
                    .BuildAsync()
                    .ConfigureAwait(false).GetAwaiter().GetResult();
            }
            else
            {
                using var mm = FindMmDevice(_outputDeviceId);
                if (mm is not null)
                {
                    player = new WasapiPlayerBuilder()
                        .WithDevice(mm)
                        .WithSharedMode()
                        .WithEventSync()
                        .WithLatency(60)
                        .WithCategory(AudioStreamCategory.Media)
                        .WithMmcssThreadPriority("Audio")
                        .Build();
                }
                else
                {
                    Log.Write($"[engine] output device '{_outputDeviceId}' not found, using system default");
                    player = new WasapiPlayerBuilder()
                        .WithDefaultDeviceStreamRouting()
                        .WithSharedMode()
                        .WithEventSync()
                        .WithLatency(60)
                        .WithCategory(AudioStreamCategory.Media)
                        .WithMmcssThreadPriority("Audio")
                        .BuildAsync()
                        .ConfigureAwait(false).GetAwaiter().GetResult();
                }
            }

            // Query mix format safely (fall back to 48 kHz stereo float which shared-mode WASAPI always accepts)
            int rate = 48000, ch = 2;
            try
            {
                var mix = player.DeviceMixFormat;
                if (mix is { SampleRate: >= 8000 and <= 384000, Channels: >= 1 and <= 2 })
                {
                    rate = mix.SampleRate;
                    ch = mix.Channels;
                }
                else if (mix is { SampleRate: >= 8000 and <= 384000 })
                {
                    rate = mix.SampleRate;
                }
            }
            catch { }

            _outRate = rate;
            _outChannels = ch;
            // 1.0 s ring buffer (~384 KB at 48 kHz stereo): smooth jitter absorption & prompt streaming on gapless promotion
            _ring = new PcmRingBuffer(rate, ch);
            _renderProvider = new RenderWaveProvider(this, rate, ch);
            player.Init(_renderProvider);
            _wasapi = player;
            _headlessMode = false;
        }
        catch (Exception ex)
        {
            Log.Write($"[engine] WASAPI init unavailable ({ex.Message}); falling back to silent clock");
            _outRate = 48000;
            _outChannels = 2;
            _ring = new PcmRingBuffer((int)(48000 * 0.6), 2);
            _renderProvider = new RenderWaveProvider(this, 48000, 2);
            _headlessMode = true;
        }
    }

    private static MMDevice? FindMmDevice(string winRtDeviceId)
    {
        try
        {
            using var enumerator = new MMDeviceEnumerator();
            foreach (var d in enumerator.EnumerateAudioEndPoints(DataFlow.Render, DeviceState.Active))
            {
                if (winRtDeviceId.Equals(d.ID, StringComparison.OrdinalIgnoreCase) ||
                    winRtDeviceId.Contains(d.ID, StringComparison.OrdinalIgnoreCase))
                    return d;
                d.Dispose();
            }
        }
        catch (Exception ex)
        {
            Log.Write($"[engine] device lookup failed: {ex.Message}");
        }
        return null;
    }

    private void StartOutputLocked()
    {
        lock (_outputLock)
        {
            if (_headlessMode)
            {
                _headlessClock ??= new Timer(_ => PumpHeadless(), null, 20, 20);
                return;
            }
            if (_wasapi is null) CreateOutputLocked();
            if (_wasapi is not null && _wasapi.PlaybackState != PlaybackState.Playing)
                _wasapi.Play();
        }
    }

    private void PauseOutputLocked()
    {
        lock (_outputLock)
        {
            _headlessClock?.Dispose();
            _headlessClock = null;
            if (_wasapi is not null && _wasapi.PlaybackState == PlaybackState.Playing)
                _wasapi.Pause();
        }
    }

    private void StopOutputLocked()
    {
        lock (_outputLock)
        {
            _headlessClock?.Dispose();
            _headlessClock = null;
            if (_wasapi is not null && _wasapi.PlaybackState != PlaybackState.Stopped)
                _wasapi.Stop();
        }
    }

    private void DisposeOutputLocked()
    {
        _headlessClock?.Dispose();
        _headlessClock = null;
        if (_wasapi is not null)
        {
            try { _wasapi.Stop(); } catch { }
            try { _wasapi.Dispose(); } catch { }
            _wasapi = null;
        }
    }

    private void PumpHeadless()
    {
        if (!_wantPlay || _renderProvider is null) return;
        byte[] dummy = new byte[(_outRate / 50) * _outChannels * sizeof(float)];
        _renderProvider.Read(dummy);
    }

    // ---------------------------------------------------------------- real-time WASAPI render callback
    private int RenderAudio(Span<byte> destBytes, List<RingTrackBoundary> crossedScratch)
    {
        var destFloats = MemoryMarshal.Cast<byte, float>(destBytes);
        var ring = _ring;
        int gen = Volatile.Read(ref _generation);

        if (ring is null || !_wantPlay || gen != Volatile.Read(ref _ringGeneration))
        {
            destFloats.Clear();
            return destBytes.Length;
        }

        crossedScratch.Clear();
        int got = ring.Read(destFloats, crossedScratch, out long totalReadFrames, out bool isEof);

        if (got == 0)
        {
            destFloats.Clear();
            if (isEof)
            {
                if (!_endedSignaledForGen)
                {
                    _endedSignaledForGen = true;
                    Do(() => OnPlaybackDrained(gen));
                }
            }
            else if (!_buffering)
            {
                _buffering = true;
                Do(() =>
                {
                    if (gen != Volatile.Read(ref _generation) || !_wantPlay) return;
                    SetState(EngineState.Loading);
                    _smtc.UpdateStatus(EngineState.Loading);
                });
            }
            return destBytes.Length;
        }

        if (got < destFloats.Length)
            destFloats[got..].Clear();

        // Apply instant volume / mute / loudness gain + soft limiter (or zero output when SONUS_E2E_SILENT=1)
        GaplessAudioPipeline.ApplyGainBuffer(
            destFloats[..got],
            _outChannels,
            _outRate,
            (float)Volatile.Read(ref _volume),
            _muted,
            (float)Volatile.Read(ref _gainMultiplier),
            Silent,
            ref _smoothedGain);

        // Handle exact sample-accurate gapless track transitions as the speaker crosses the boundary
        for (int i = 0; i < crossedScratch.Count; i++)
        {
            var b = crossedScratch[i];
            _currentId = b.TrackId;
            _nextId = null;
            _duration = b.DurationSeconds > 0 ? b.DurationSeconds : null;
            _activeStream = b.Metadata;
            Volatile.Write(ref _trackOriginFrame, b.FrameIndex);
            Volatile.Write(ref _trackOriginSeconds, 0.0);
            var boundaryCopy = b;
            Do(() => OnTrackAdvanced(gen, boundaryCopy));
        }

        // Update audible playback position unless a seek is currently in flight (avoids 1-frame snap-back)
        if (Interlocked.Read(ref _pendingSeekBits) == NoPendingSeek)
        {
            double latencySec = 0;
            try { if (_wasapi is { } w) latencySec = Math.Clamp(w.CurrentLatency.TotalSeconds, 0, 0.25); } catch { }
            long playedFramesInTrack = Math.Max(0, totalReadFrames - Volatile.Read(ref _trackOriginFrame));
            double pos = Volatile.Read(ref _trackOriginSeconds) + Math.Max(0, (playedFramesInTrack / (double)_outRate) - latencySec);
            if (_duration is { } d && d > 0 && pos > d) pos = d;
            Volatile.Write(ref _position, pos);
        }

        // Wake producer so it refills the ring buffer promptly
        _wakeDecode.Set();

        if (!_audioStartedForGen || _state == EngineState.Loading)
        {
            _audioStartedForGen = true;
            if (Interlocked.Exchange(ref _firstAudioPostedGen, gen) != gen || _state == EngineState.Loading)
                Do(() => OnFirstAudioRendered(gen));
        }

        if (isEof && !_endedSignaledForGen)
        {
            _endedSignaledForGen = true;
            Do(() => OnPlaybackDrained(gen));
        }

        return destBytes.Length;
    }

    private void OnFirstAudioRendered(int gen)
    {
        if (gen != Volatile.Read(ref _generation) || !_wantPlay) return;
        if (_loadClock is { } c)
        {
            Log.Write($"[engine] {_currentId} playing (native) after {c.ElapsedMilliseconds} ms");
            _loadClock = null;
        }
        SetState(EngineState.Playing);
        _smtc.UpdateStatus(EngineState.Playing);
        UpdateSmtcTimeline();
    }

    private void OnTrackAdvanced(int gen, RingTrackBoundary boundary)
    {
        if (gen != Volatile.Read(ref _generation)) return;
        Log.Write($"[engine] gapless -> {boundary.TrackId} (duration {boundary.DurationSeconds:0.0} s)");
        if (boundary.Tag is EngineItem nextItem)
            _smtc.UpdateMetadata(nextItem);
        _smtc.UpdateStatus(EngineState.Playing);
        UpdateSmtcTimeline();
        Post(gen, () => Advanced?.Invoke(boundary.TrackId));
    }

    private void OnPlaybackDrained(int gen)
    {
        if (gen != Volatile.Read(ref _generation) || _state == EngineState.Error) return;
        _wantPlay = false;
        StopOutputLocked();
        SetState(EngineState.Stopped);
        _smtc.UpdateStatus(EngineState.Stopped);
        Post(gen, () => Ended?.Invoke());
    }

    private void UpdateSmtcTimeline()
    {
        if (_state is EngineState.Playing or EngineState.Paused)
            _smtc.UpdateTimeline(Volatile.Read(ref _position), _duration);
    }

    // ---------------------------------------------------------------- fallback delegation for exotic containers
    private void DelegateToFallback(int gen, EngineItem item, EngineItem? next, bool autoplay)
    {
        Do(() =>
        {
            if (gen != Volatile.Read(ref _generation)) return;
            StopOutputLocked();
            if (_fallback is null)
            {
                var fb = new LegacyAudioBackend(_ui)
                {
                    Volume = Volume,
                    Muted = Muted,
                    GainMultiplier = GainMultiplier,
                };
                fb.StateChanged += () => { if (_usingFallback) StateChanged?.Invoke(); };
                fb.Advanced += id => { if (_usingFallback) Advanced?.Invoke(id); };
                fb.Ended += () => { if (_usingFallback) Ended?.Invoke(); };
                fb.NextRequested += () => { if (_usingFallback) NextRequested?.Invoke(); };
                fb.PreviousRequested += () => { if (_usingFallback) PreviousRequested?.Invoke(); };
                if (_outputDeviceId is { } dev) _ = fb.SetOutputAsync(dev);
                _fallback = fb;
            }
            _usingFallback = true;
            _fallback.Load(item, next, autoplay);
        });
    }

    // ---------------------------------------------------------------- helpers & cleanup
    private void CancelCurrentWorkers()
    {
        CancelPreloadWorker();
        var oldDecode = Interlocked.Exchange(ref _decodeCts, null);
        if (oldDecode is not null)
        {
            try { oldDecode.Cancel(); } catch { }
            try { oldDecode.Dispose(); } catch { }
        }
        try { _activeHttp?.Cancel(); } catch { }
        _wakeDecode.Set();
    }

    private void CancelPreloadWorker()
    {
        var oldPreload = Interlocked.Exchange(ref _preloadCts, null);
        if (oldPreload is not null)
        {
            try { oldPreload.Cancel(); } catch { }
            try { oldPreload.Dispose(); } catch { }
        }
    }

    private void SetState(EngineState s)
    {
        if (_state == s) return;
        _state = s;
        Post(() => StateChanged?.Invoke());
    }

    private static string DescribeException(Exception ex) => ex switch
    {
        HttpRequestException => "网络错误，服务器没有给出音频",
        IOException => "网络错误，音频流中断",
        InvalidDataException => "解码失败，文件格式受损或无法读取",
        NotSupportedException => "格式不受支持或文件无法读取",
        _ => ex.Message,
    };

    public void Dispose()
    {
        if (_disposed) return;
        _disposed = true;
        Interlocked.Increment(ref _generation);
        _wantPlay = false;
        CancelCurrentWorkers();
        Do(() =>
        {
            _timelineTimer?.Dispose();
            lock (_outputLock) DisposeOutputLocked();
            ClearReadyNext();
            _smtc.Dispose();
            _fallback?.Dispose();
        });
        _work.CompleteAdding();
    }

    /// <summary>Zero-allocation NAudio 3.3 <see cref="IWaveProvider"/> feeding WASAPI from the ring buffer.</summary>
    private sealed class RenderWaveProvider(NativeAudioBackend owner, int rate, int channels) : IWaveProvider
    {
        private readonly List<RingTrackBoundary> _crossedScratch = new(2);
        public WaveFormat WaveFormat { get; } = WaveFormat.CreateIeeeFloatWaveFormat(rate, channels);

        public int Read(byte[] buffer, int offset, int count) => Read(buffer.AsSpan(offset, count));
        public int Read(Span<byte> buffer) => owner.RenderAudio(buffer, _crossedScratch);
    }
}
