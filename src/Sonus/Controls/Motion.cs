using System.Numerics;
using Microsoft.UI.Composition;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Hosting;
using Microsoft.UI.Xaml.Input;
using Microsoft.UI.Xaml.Media;

namespace Sonus.Controls;

/// <summary>
/// The app's motion, all of it run by the compositor, so it stays smooth however busy the UI thread is.
/// <para>Comings-in (a page, its rows and cards one after another, a panel, a song's cover) are composition animations
/// started together on the first frame that draws them: their delays are kept by the compositor, not by timers on the UI
/// thread. (Timers there fired late and in bunches while a page was being built, and an animation that started before its
/// content was drawn was half over when it appeared: the twitching.) They decelerate on foobar2k's curve.</para>
/// <para>Responses to the pointer (lift, reveal, press) are implicit transitions; a like's pop is a key-frame animation.</para>
/// With Windows' animation effects off, things just appear.
/// </summary>
public static class Motion
{
    // the CreeperUX motion tokens (fb2k's vendor/creeperux-gui/tokens.json)
    public static readonly TimeSpan PressTime = TimeSpan.FromMilliseconds(60);    // --cx-motion-press
    public static readonly TimeSpan Release = TimeSpan.FromMilliseconds(120);     // --cx-motion-release
    public static readonly TimeSpan EnterTime = TimeSpan.FromMilliseconds(140);   // --cx-motion-enter
    public static readonly TimeSpan ExitTime = TimeSpan.FromMilliseconds(90);     // --cx-motion-exit
    public static readonly TimeSpan Control = TimeSpan.FromMilliseconds(200);     // --cx-motion-control
    public static readonly TimeSpan View = TimeSpan.FromMilliseconds(150);        // --cx-motion-view: content swapped in place
    public static readonly TimeSpan Push = TimeSpan.FromMilliseconds(220);        // --cx-motion-push
    public static readonly TimeSpan Sheet = TimeSpan.FromMilliseconds(320);       // --cx-motion-sheet: bigger moves
    public static readonly TimeSpan Tint = TimeSpan.FromMilliseconds(600);        // foobar2k's page colour change

    /// <summary>Windows' "Animation effects" (Settings › Accessibility › Visual effects).</summary>
    public static bool Enabled { get; } = new Windows.UI.ViewManagement.UISettings().AnimationsEnabled;

    // ---------------------------------------------------------------- comings-in, started on the frame that first draws them
    private static readonly List<Action<Compositor>> Starts = [];
    private static bool _waiting;

    /// <summary>Starts <paramref name="start"/> on the next frame (after the UI thread has built and laid out what is new).</summary>
    private static void OnNextFrame(Action<Compositor> start)
    {
        Starts.Add(start);
        if (_waiting) return;
        _waiting = true;
        int batch = ++_batch;
        CompositionTarget.Rendering += Flush;
        // never left hidden: if no frame comes, this batch starts anyway (a later batch waits for its own frame)
        After(TimeSpan.FromMilliseconds(400), () => { if (_waiting && _batch == batch) Flush(null, EventArgs.Empty); });
    }

    private static int _batch;

    private static void Flush(object? sender, object e)
    {
        CompositionTarget.Rendering -= Flush;
        if (!_waiting) return;
        _waiting = false;
        var compositor = CompositionTarget.GetCompositorForCurrentThread();
        var now = Starts.ToList();
        Starts.Clear();
        foreach (var start in now) start(compositor);
    }

    /// <summary>foobar2k's ease-out (--cx-ease-out: cubic-bezier(.2, .8, .2, 1)): quick, then settling.</summary>
    private static CompositionEasingFunction EaseOut(Compositor c) => c.CreateCubicBezierEasingFunction(new Vector2(0.2f, 0.8f), new Vector2(0.2f, 1f));

    /// <summary>foobar2k's exit curve (--cx-motion-exit: cubic-bezier(.4, 0, .9, .55)): slow to start, then away.</summary>
    private static CompositionEasingFunction EaseIn(Compositor c) => c.CreateCubicBezierEasingFunction(new Vector2(0.4f, 0f), new Vector2(0.9f, 0.55f));

    /// <summary>
    /// Fades <paramref name="e"/> in while it moves <paramref name="rise"/> px up (or <paramref name="slide"/> px left) into
    /// place, <paramref name="delay"/> after the frame that first draws it: a page, a panel, a row, a card.
    /// An element whose Translation is in use (a toast, for its shadow) asks for <paramref name="transitions"/>: the same
    /// with implicit transitions, since one element cannot be moved both ways.
    /// </summary>
    public static void Enter(UIElement e, float rise = 12, float slide = 0, TimeSpan delay = default, TimeSpan? move = null, bool transitions = false)
    {
        if (!Enabled) return;
        if (transitions) { EnterByTransitions(e, rise, slide, delay); return; }
        var visual = ElementCompositionPreview.GetElementVisual(e);
        ElementCompositionPreview.SetIsTranslationEnabled(e, true);
        var from = new Vector3(slide, rise, 0);
        // hidden and moved from the very first frame it is drawn in
        visual.Opacity = 0;
        visual.Properties.InsertVector3("Translation", from);
        var moving = move ?? TimeSpan.FromMilliseconds(300);
        OnNextFrame(c =>
        {
            var fade = c.CreateScalarKeyFrameAnimation();
            fade.InsertKeyFrame(0, 0);
            fade.InsertKeyFrame(1, 1, c.CreateLinearEasingFunction());
            fade.Duration = moving > Push ? TimeSpan.FromMilliseconds(200) : TimeSpan.FromMilliseconds(180);
            var slideIn = c.CreateVector3KeyFrameAnimation();
            slideIn.InsertKeyFrame(0, from);
            slideIn.InsertKeyFrame(1, Vector3.Zero, EaseOut(c));
            slideIn.Duration = moving;
            foreach (var a in new KeyFrameAnimation[] { fade, slideIn })
            {
                a.DelayTime = delay;
                a.DelayBehavior = AnimationDelayBehavior.SetInitialValueBeforeDelay;
            }
            visual.StartAnimation("Opacity", fade);
            visual.StartAnimation("Translation", slideIn);
        });
    }

    private static void EnterByTransitions(UIElement e, float rise, float slide, TimeSpan delay)
    {
        float z = e.Translation.Z;
        e.OpacityTransition = new ScalarTransition { Duration = TimeSpan.FromMilliseconds(180) };
        e.TranslationTransition = new Vector3Transition { Duration = Push };
        e.Opacity = 0;
        e.Translation = new Vector3(slide, rise, z);
        OnNextFrame(_ =>
        {
            void Go() { e.Opacity = 1; e.Translation = new Vector3(0, 0, z); }
            if (delay > TimeSpan.Zero) After(delay, Go); else Go();
        });
    }

    /// <summary>Content swapped in place (the right panel: now playing, the queue, the devices): the new content fades in,
    /// opacity only; the old one has left at once (--cx-motion-view, --cx-motion-viewExit).</summary>
    public static void Swap(UIElement e)
    {
        if (!Enabled) return;
        var visual = ElementCompositionPreview.GetElementVisual(e);
        visual.Opacity = 0;
        OnNextFrame(c =>
        {
            var fade = c.CreateScalarKeyFrameAnimation();
            fade.InsertKeyFrame(0, 0);
            fade.InsertKeyFrame(1, 1, EaseOut(c));
            fade.Duration = View;
            visual.StartAnimation("Opacity", fade);
        });
    }

    /// <summary>A panel or a sheet closing: it moves <paramref name="slide"/> px to the right (or <paramref name="drop"/> px
    /// down) as it fades out, from wherever it is (one closed while it was still coming in leaves from there), then
    /// <paramref name="done"/>.</summary>
    public static void SlideOut(UIElement e, Action done, float slide = 0, float drop = 0)
    {
        if (!Enabled) { done(); return; }
        var visual = ElementCompositionPreview.GetElementVisual(e);
        ElementCompositionPreview.SetIsTranslationEnabled(e, true);
        var c = visual.Compositor;
        var fade = c.CreateScalarKeyFrameAnimation();
        fade.InsertExpressionKeyFrame(0, "this.StartingValue");
        fade.InsertKeyFrame(1, 0, c.CreateLinearEasingFunction());
        fade.Duration = Control;
        var away = c.CreateVector3KeyFrameAnimation();
        away.InsertExpressionKeyFrame(0, "this.StartingValue");
        away.InsertKeyFrame(1, new Vector3(slide, drop, 0), EaseIn(c));
        away.Duration = Control;
        visual.StartAnimation("Opacity", fade);
        visual.StartAnimation("Translation", away);
        After(Control + TimeSpan.FromMilliseconds(40), done);
    }

    /// <summary>A panel or a sheet opened again before it had gone: back into place from where it is.</summary>
    public static void SlideBack(UIElement e, TimeSpan? move = null)
    {
        if (!Enabled) return;
        var visual = ElementCompositionPreview.GetElementVisual(e);
        ElementCompositionPreview.SetIsTranslationEnabled(e, true);
        var c = visual.Compositor;
        var fade = c.CreateScalarKeyFrameAnimation();
        fade.InsertExpressionKeyFrame(0, "this.StartingValue");
        fade.InsertKeyFrame(1, 1, c.CreateLinearEasingFunction());
        fade.Duration = TimeSpan.FromMilliseconds(180);
        var back = c.CreateVector3KeyFrameAnimation();
        back.InsertExpressionKeyFrame(0, "this.StartingValue");
        back.InsertKeyFrame(1, Vector3.Zero, EaseOut(c));
        back.Duration = move ?? Sheet;
        visual.StartAnimation("Opacity", fade);
        visual.StartAnimation("Translation", back);
    }

    /// <summary>The <paramref name="index"/>th of a list's first rows or cards coming in, each a little after the one before
    /// (the first eight; the rest come with the eighth).</summary>
    public static void Stagger(UIElement e, int index, float rise = 16) =>
        Enter(e, rise, delay: TimeSpan.FromMilliseconds(Math.Min(index, 8) * 24));

    /// <summary>Grows <paramref name="e"/> from <paramref name="from"/> to its size (a page's cover, a new song's cover).
    /// It keeps its own Translation and shadow, so this is a transition, started on the frame that draws it.</summary>
    public static void ScaleIn(FrameworkElement e, float from = 0.92f)
    {
        if (!Enabled) return;
        Vector3 Center() => new((float)(double.IsNaN(e.Width) ? e.ActualWidth : e.Width) / 2, (float)(double.IsNaN(e.Height) ? e.ActualHeight : e.Height) / 2, 0);
        e.ScaleTransition = new Vector3Transition { Duration = TimeSpan.FromMilliseconds(360) };
        e.CenterPoint = Center();
        e.Scale = new Vector3(from, from, 1);
        OnNextFrame(_ => { e.CenterPoint = Center(); e.Scale = Vector3.One; });
    }

    // ---------------------------------------------------------------- responses to the pointer
    /// <summary>Lifts a card's art under the pointer, as Lumen's tiles: it grows a little and rises (its shadow deepens).</summary>
    public static void Lift(FrameworkElement art, bool up)
    {
        if (!Enabled) return;
        art.ScaleTransition ??= new Vector3Transition { Duration = Control };
        art.TranslationTransition ??= new Vector3Transition { Duration = Control };
        art.Shadow ??= new ThemeShadow();
        art.CenterPoint = new Vector3((float)art.ActualWidth / 2, (float)art.ActualHeight / 2, 0);
        art.Scale = up ? new Vector3(1.035f, 1.035f, 1) : Vector3.One;
        art.Translation = new Vector3(0, up ? -2 : 0, up ? 20 : 0);
    }

    /// <summary>Fades <paramref name="e"/> out, then <paramref name="remove"/>s it (a toast).</summary>
    public static void Exit(UIElement e, Action remove)
    {
        if (!Enabled) { remove(); return; }
        e.OpacityTransition = new ScalarTransition { Duration = ExitTime };
        e.TranslationTransition ??= new Vector3Transition { Duration = Control };
        e.Opacity = 0;
        e.Translation = new Vector3(e.Translation.X, 6, e.Translation.Z);
        After(ExitTime + TimeSpan.FromMilliseconds(40), remove);
    }

    /// <summary>Shows or hides a control that appears under the pointer (a card's Play button): it fades and slides up.</summary>
    public static void Reveal(UIElement e, bool show)
    {
        if (Enabled)
        {
            e.OpacityTransition ??= new ScalarTransition { Duration = EnterTime };
            e.TranslationTransition ??= new Vector3Transition { Duration = Control };
        }
        e.Opacity = show ? 1 : 0;
        e.Translation = new Vector3(0, show ? 0 : 8, e.Translation.Z);
    }

    /// <summary>A quick swell and settle (a like; <paramref name="amount"/> smaller for a changing Play / Pause icon): one
    /// key-frame animation, so it never stays swollen waiting for the UI thread.</summary>
    /// <remarks>Animates the element's composition visual. Never on an element that has <see cref="Press"/> (or any other
    /// use of UIElement.Scale / CenterPoint): once those are set, touching the visual's Scale throws
    /// UnauthorizedAccessException. Pop the icon inside instead (<see cref="PopIcon"/>).</remarks>
    public static void Pop(UIElement e, float amount = 1.28f)
    {
        if (!Enabled || e is not FrameworkElement fe) return;
        var visual = ElementCompositionPreview.GetElementVisual(e);
        var c = visual.Compositor;
        visual.CenterPoint = CenterOf(fe);
        var pop = c.CreateVector3KeyFrameAnimation();
        pop.InsertKeyFrame(0, Vector3.One);
        pop.InsertKeyFrame(0.35f, new Vector3(amount, amount, 1), EaseOut(c));
        pop.InsertKeyFrame(1, Vector3.One, EaseOut(c));
        pop.Duration = TimeSpan.FromMilliseconds(280);
        visual.StartAnimation("Scale", pop);
    }

    /// <summary>A restrained swell on the icon inside a toggle or button (shuffle, repeat, panel toggles).</summary>
    public static void PopIcon(Microsoft.UI.Xaml.Controls.ContentControl c, float amount = 1.15f)
    {
        var icon = c.Content as KitIcon ?? (c.Content as Microsoft.UI.Xaml.Controls.Panel)?.Children.OfType<KitIcon>().FirstOrDefault();
        if (icon is not null) Pop(icon, amount);
    }

    /// <summary>Grows a little under the pointer and gives when pressed (round Play and Home buttons: foobar2k's 1.04 and
    /// .97).</summary>
    public static void Press(UIElement e, float hover = 1.04f, float pressed = 0.97f)
    {
        if (!Enabled) return;
        e.ScaleTransition = new Vector3Transition { Duration = Release };
        bool over = false;
        void To(float s) { Center(e); e.Scale = new Vector3(s, s, 1); }
        e.PointerEntered += (_, _) => { over = true; To(hover); };
        e.PointerExited += (_, _) => { over = false; To(1); };
        e.PointerCanceled += (_, _) => { over = false; To(1); };
        e.PointerCaptureLost += (_, _) => To(over ? hover : 1);
        // Button marks presses handled: listen to handled ones too
        e.AddHandler(UIElement.PointerPressedEvent, new PointerEventHandler((_, _) => To(pressed)), true);
        e.AddHandler(UIElement.PointerReleasedEvent, new PointerEventHandler((_, _) => To(over ? hover : 1)), true);
    }

    /// <summary>Background changes of <paramref name="e"/> (a row, a tile) cross-fade instead of jumping.</summary>
    public static void BrushFade(Microsoft.UI.Xaml.Controls.Panel e) { if (Enabled) e.BackgroundTransition = new BrushTransition { Duration = Control }; }

    /// <summary>Changes of <paramref name="e"/>'s opacity (a lyric line lighting up) fade.</summary>
    public static void OpacityFade(UIElement e, TimeSpan? duration = null) { if (Enabled) e.OpacityTransition = new ScalarTransition { Duration = duration ?? Control }; }

    /// <summary>Changes of <paramref name="e"/>'s scale (a lyric line coming forward) are animated.</summary>
    public static void ScaleFade(UIElement e) { if (Enabled) e.ScaleTransition = new Vector3Transition { Duration = Sheet }; }

    private static Vector3 CenterOf(FrameworkElement fe)
    {
        // fall back to explicit Width/Height before the first layout pass so animations never scale around (0, 0)
        float w = fe.ActualWidth > 0 ? (float)fe.ActualWidth : double.IsNaN(fe.Width) ? 0 : (float)fe.Width;
        float h = fe.ActualHeight > 0 ? (float)fe.ActualHeight : double.IsNaN(fe.Height) ? 0 : (float)fe.Height;
        return new Vector3(w / 2, h / 2, 0);
    }

    private static void Center(UIElement e)
    {
        if (e is FrameworkElement fe) e.CenterPoint = CenterOf(fe);
    }

    internal static void After(TimeSpan delay, Action action)
    {
        var timer = new DispatcherTimer { Interval = delay };
        timer.Tick += (_, _) => { timer.Stop(); action(); };
        timer.Start();
    }
}
