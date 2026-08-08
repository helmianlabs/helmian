using System.Drawing.Drawing2D;

namespace Helmion.VoiceDictation;

/// <summary>
/// A small, always-on-top, round button floating on the desktop that shows the
/// SAME state colours as <see cref="TrayIndicator"/> (idle grey, recording red,
/// transcribing amber, error dark red) and can be clicked to toggle dictation —
/// the same action the hotkey performs.
/// </summary>
/// <remarks>
/// TROY-APPROVED 2026-08-08 — the tray dot next to the clock is easy to miss or
/// forget is even there; Troy asked for something visible on screen he can look
/// at (and click) directly, matching the "mic button" experience from Helmion's
/// own app. This does not replace the tray icon or the hotkey — both keep
/// working exactly as before; this is a second, more visible way to see the
/// same state and trigger the same action.
///
/// Draggable so Troy can put it wherever it doesn't cover anything he's working
/// in; position persists only for the running session (no config write-back —
/// keeps this simple, matching the tool's existing "restart to change config"
/// pattern for everything else).
/// </remarks>
[System.Runtime.Versioning.SupportedOSPlatform("windows")]
public sealed class DictationButtonOverlay : Form
{
    private const int Diameter = 56;
    private const int EdgeMargin = 24;

    private readonly Action _onClick;
    private DictationState _state = DictationState.Idle;
    private bool _dragging;
    private Point _dragStart;
    private bool _moved;

    public DictationButtonOverlay(Action onClick)
    {
        _onClick = onClick;

        FormBorderStyle = FormBorderStyle.None;
        ShowInTaskbar = false;
        TopMost = true;
        StartPosition = FormStartPosition.Manual;
        Size = new Size(Diameter, Diameter);
        // VERIFIED 2026-08-08 — TransparencyKey color-keying (the original
        // approach) reported as IsWindowVisible=true with the correct on-screen
        // rect via direct Win32 EnumWindows/GetWindowRect, yet Troy could not
        // see it at all. Color-keyed layered windows are known to render
        // unreliably on some DWM/GPU combos. Switched to a Region-clipped
        // OPAQUE window instead — no color key, no WS_EX_LAYERED dependency,
        // just a real circular window with a real background, which is the
        // simplest thing that can't silently fail to composite.
        BackColor = Color.FromArgb(30, 30, 34);
        DoubleBuffered = true;

        // TROY-APPROVED 2026-08-08 — left side, not right. Draggable afterward if
        // he ever wants it somewhere else; this is just where it starts.
        var area = Screen.PrimaryScreen?.WorkingArea ?? new Rectangle(0, 0, 1920, 1080);
        Location = new Point(area.Left + EdgeMargin, area.Bottom - Diameter - EdgeMargin);

        using (var path = new GraphicsPath())
        {
            path.AddEllipse(0, 0, Diameter, Diameter);
            Region = new Region(path);
        }

        MouseDown += OnMouseDown;
        MouseMove += OnMouseMove;
        MouseUp += OnMouseUp;
        Paint += OnPaint;

        var tip = new ToolTip();
        tip.SetToolTip(this, "Helmion dictation — click to talk");
    }

    /// <summary>Mirrors <see cref="TrayIndicator.Show"/> so both stay in sync.</summary>
    public void Show(DictationState state)
    {
        _state = state;
        Invalidate();
    }

    private void OnMouseDown(object? sender, MouseEventArgs e)
    {
        if (e.Button != MouseButtons.Left)
        {
            return;
        }

        _dragging = true;
        _moved = false;
        _dragStart = e.Location;
    }

    private void OnMouseMove(object? sender, MouseEventArgs e)
    {
        if (!_dragging)
        {
            return;
        }

        // A few pixels of slop before it counts as a drag, so a click that
        // trembles slightly doesn't get eaten as a move-and-ignore.
        if (!_moved
            && Math.Abs(e.X - _dragStart.X) < 3
            && Math.Abs(e.Y - _dragStart.Y) < 3)
        {
            return;
        }

        _moved = true;
        Location = new Point(Location.X + (e.X - _dragStart.X), Location.Y + (e.Y - _dragStart.Y));
    }

    private void OnMouseUp(object? sender, MouseEventArgs e)
    {
        if (e.Button != MouseButtons.Left)
        {
            return;
        }

        _dragging = false;

        if (!_moved)
        {
            _onClick();
        }
    }

    private void OnPaint(object? sender, PaintEventArgs e)
    {
        var g = e.Graphics;
        g.SmoothingMode = SmoothingMode.AntiAlias;
        g.Clear(BackColor);

        var color = _state switch
        {
            DictationState.Recording => Color.FromArgb(220, 40, 40),
            DictationState.Transcribing => Color.FromArgb(230, 160, 30),
            DictationState.Error => Color.FromArgb(120, 10, 10),
            _ => Color.FromArgb(150, 150, 150),
        };

        using var fill = new SolidBrush(Color.FromArgb(235, color));
        using var edge = new Pen(Color.FromArgb(230, 20, 20, 20), 3f);
        var rect = new Rectangle(3, 3, Diameter - 6, Diameter - 6);
        g.FillEllipse(fill, rect);
        g.DrawEllipse(edge, rect);

        // A small mic glyph so it reads as "voice" even at a glance, not just a
        // coloured blob — two rounded strokes and a stem, drawn in code like the
        // tray icons so this ships with no image asset either.
        using var glyph = new Pen(Color.White, 3f) { StartCap = LineCap.Round, EndCap = LineCap.Round };
        var cx = Diameter / 2f;
        var cy = Diameter / 2f;
        g.DrawArc(glyph, cx - 8, cy - 14, 16, 20, 0, 180);
        g.DrawLine(glyph, cx, cy + 6, cx, cy + 14);
        g.DrawLine(glyph, cx - 6, cy + 14, cx + 6, cy + 14);
    }

    protected override CreateParams CreateParams
    {
        get
        {
            const int WS_EX_TOOLWINDOW = 0x80;
            // TROY-APPROVED 2026-08-08 — bugfix, same night. Without this, being
            // TopMost let this window steal the foreground/keyboard focus, which
            // meant Ctrl+V (the dictation paste) landed IN THIS BUTTON instead of
            // wherever Troy was actually typing — dictated text silently vanished
            // instead of appearing anywhere. WS_EX_NOACTIVATE tells Windows this
            // window must never become the active/focused window, no matter what
            // — clicking it still fires MouseDown/MouseUp (that's all ToggleDictation
            // needs), it just never takes keyboard focus away from whatever app
            // Troy was already in.
            const int WS_EX_NOACTIVATE = 0x08000000;
            var cp = base.CreateParams;
            // WS_EX_TOOLWINDOW keeps it out of the taskbar and Alt+Tab, same
            // intent as ShowInTaskbar=false but also hides it from Alt+Tab.
            cp.ExStyle |= WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE;
            return cp;
        }
    }

    protected override bool ShowWithoutActivation => true;
}
