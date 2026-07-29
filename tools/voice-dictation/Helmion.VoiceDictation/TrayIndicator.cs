using System.Drawing;
using System.Drawing.Drawing2D;
using System.Runtime.InteropServices;

namespace Helmion.VoiceDictation;

/// <summary>What the app is doing right now.</summary>
public enum DictationState
{
    Idle,
    Recording,
    Transcribing,
    Error,
}

/// <summary>
/// A coloured dot beside the clock. This is the ONLY thing this application ever
/// puts on screen.
/// </summary>
/// <remarks>
/// There is no window, no console, no taskbar button and no balloon notification.
/// A tray icon was worth it because the alternative — reading a log file to find
/// out whether the microphone is live — is not something anyone will do mid-
/// sentence. The icons are drawn in code so the tool ships without an .ico asset.
/// </remarks>
[System.Runtime.Versioning.SupportedOSPlatform("windows")]
public sealed class TrayIndicator : IDisposable
{
    /// <summary>
    /// Dictionary key for the green "replies are spoken" dot.
    /// </summary>
    /// <remarks>
    /// Deliberately NOT a member of <see cref="DictationState"/>. Conversation mode
    /// is orthogonal to what the microphone is doing — replies can be spoken while
    /// a recording is in progress — so putting it in the enum would invent
    /// combinations ("Recording and Conversation") that every switch in the code
    /// would then have to handle. A private key gives the icon a slot without
    /// making the state machine lie.
    /// </remarks>
    private const DictationState ConversationIconKey = (DictationState)100;

    private readonly NotifyIcon? _notifyIcon;
    private readonly Dictionary<DictationState, Icon> _icons = new();
    private readonly List<IntPtr> _iconHandles = new();
    private readonly string _hotkeyText;
    private readonly string _conversationHotkeyText;

    private bool _disposed;

    /// <summary>Whether spoken replies are on, which changes the idle dot to green.</summary>
    private bool _conversationOn;

    /// <summary>
    /// The last state passed to <see cref="Show"/>, so <see cref="SetConversation"/>
    /// can re-render without the caller having to tell it what it was.
    /// </summary>
    private DictationState _lastState = DictationState.Idle;

    public TrayIndicator(
        bool enabled,
        string hotkeyText,
        string conversationHotkeyText,
        Action onQuit,
        Action onOpenLog)
    {
        _hotkeyText = hotkeyText;
        _conversationHotkeyText = conversationHotkeyText;

        if (!enabled)
        {
            return;
        }

        try
        {
            BuildIcons();

            var menu = new ContextMenuStrip();
            menu.Items.Add("Open log", null, (_, _) => onOpenLog());
            menu.Items.Add(new ToolStripSeparator());
            menu.Items.Add("Quit dictation", null, (_, _) => onQuit());

            _notifyIcon = new NotifyIcon
            {
                Icon = _icons[DictationState.Idle],
                Visible = true,
                ContextMenuStrip = menu,
                Text = Truncate($"Helmion Dictation — idle. {hotkeyText} to talk."),
            };
        }
        catch (Exception ex)
        {
            // A tray icon that cannot be created must not stop dictation working.
            DictationLog.Warn($"Tray icon unavailable: {ex.Message}. Running with the log file only.");
            _notifyIcon = null;
        }
    }

    public void Show(DictationState state, string? detail = null)
    {
        if (_notifyIcon is null || _disposed)
        {
            return;
        }

        _lastState = state;

        try
        {
            // Green while idle means "replies are being spoken" — the one piece of
            // state a terminal user cannot otherwise see, since conversation mode
            // has no window and produces no output until Claude answers.
            var key = state == DictationState.Idle && _conversationOn
                ? ConversationIconKey
                : state;

            if (_icons.TryGetValue(key, out var icon))
            {
                _notifyIcon.Icon = icon;
            }

            var label = state switch
            {
                DictationState.Recording => $"Recording… {_hotkeyText} to stop.",
                DictationState.Transcribing => "Transcribing…",
                DictationState.Error => detail ?? "Something failed — see the log.",
                _ when _conversationOn => $"replies spoken. {_conversationHotkeyText} = off",
                _ => $"idle. {_hotkeyText} to talk.",
            };

            _notifyIcon.Text = Truncate($"Helmion — {label}");
        }
        catch (Exception ex)
        {
            DictationLog.Warn($"Could not update the tray icon: {ex.Message}");
        }
    }

    /// <summary>
    /// Record whether spoken replies are on and re-render the dot immediately.
    /// </summary>
    public void SetConversation(bool on)
    {
        _conversationOn = on;
        Show(_lastState);
    }

    public void Dispose()
    {
        if (_disposed)
        {
            return;
        }

        _disposed = true;

        try
        {
            if (_notifyIcon is not null)
            {
                _notifyIcon.Visible = false;
                _notifyIcon.Dispose();
            }
        }
        catch
        {
            // ignore
        }

        foreach (var icon in _icons.Values)
        {
            try { icon.Dispose(); } catch { /* ignore */ }
        }

        foreach (var handle in _iconHandles)
        {
            try { DestroyIcon(handle); } catch { /* ignore */ }
        }

        _icons.Clear();
        _iconHandles.Clear();
    }

    private void BuildIcons()
    {
        _icons[DictationState.Idle] = MakeDot(Color.FromArgb(150, 150, 150));
        _icons[DictationState.Recording] = MakeDot(Color.FromArgb(220, 40, 40));
        _icons[DictationState.Transcribing] = MakeDot(Color.FromArgb(230, 160, 30));
        _icons[DictationState.Error] = MakeDot(Color.FromArgb(120, 10, 10));
        _icons[ConversationIconKey] = MakeDot(Color.FromArgb(40, 180, 70));
    }

    /// <summary>
    /// Draw a filled circle and turn it into an Icon. Icon.FromHandle does not
    /// take ownership of the HICON, so the handle is tracked and destroyed in
    /// Dispose — otherwise this leaks a GDI object per icon for process lifetime.
    /// </summary>
    private Icon MakeDot(Color color)
    {
        using var bitmap = new Bitmap(32, 32);
        using (var graphics = Graphics.FromImage(bitmap))
        {
            graphics.SmoothingMode = SmoothingMode.AntiAlias;
            graphics.Clear(Color.Transparent);

            using var fill = new SolidBrush(color);
            using var edge = new Pen(Color.FromArgb(210, 20, 20, 20), 2f);
            graphics.FillEllipse(fill, 4, 4, 24, 24);
            graphics.DrawEllipse(edge, 4, 4, 24, 24);
        }

        var handle = bitmap.GetHicon();
        _iconHandles.Add(handle);
        return Icon.FromHandle(handle);
    }

    /// <summary>NotifyIcon.Text throws above 63 characters.</summary>
    private static string Truncate(string text) =>
        text.Length <= 63 ? text : text[..60] + "...";

    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool DestroyIcon(IntPtr handle);
}
