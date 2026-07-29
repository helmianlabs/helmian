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
    private readonly NotifyIcon? _notifyIcon;
    private readonly Dictionary<DictationState, Icon> _icons = new();
    private readonly List<IntPtr> _iconHandles = new();
    private readonly string _hotkeyText;

    private bool _disposed;

    public TrayIndicator(bool enabled, string hotkeyText, Action onQuit, Action onOpenLog)
    {
        _hotkeyText = hotkeyText;

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

        try
        {
            if (_icons.TryGetValue(state, out var icon))
            {
                _notifyIcon.Icon = icon;
            }

            var label = state switch
            {
                DictationState.Recording => $"Recording… {_hotkeyText} to stop.",
                DictationState.Transcribing => "Transcribing…",
                DictationState.Error => detail ?? "Something failed — see the log.",
                _ => $"Idle. {_hotkeyText} to talk.",
            };

            _notifyIcon.Text = Truncate($"Helmion Dictation — {label}");
        }
        catch (Exception ex)
        {
            DictationLog.Warn($"Could not update the tray icon: {ex.Message}");
        }
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
