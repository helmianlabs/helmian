namespace Helmion.Desktop.Core;

/// <summary>
/// Which keys the shell's non-modifier half of a chord can be. Deliberately NOT
/// <c>System.Windows.Input.Key</c>: Core does not reference WPF, and the whole
/// point of this file is that the chord table can be asserted by the headless
/// smoke suite, which cannot construct a WPF key event.
/// </summary>
public enum ShellKey
{
    Other = 0,
    OemPlus,
    Add,
    OemMinus,
    Subtract,
    D0,
    NumPad0,
    K,
    F11,
    Escape,
}

/// <summary>What the shell should do about a chord. <see cref="None"/> means "not ours".</summary>
public enum ShellShortcut
{
    None = 0,
    TextLarger,
    TextSmaller,
    TextDefault,
    ToggleConsoleFullScreen,
    ExitConsoleFullScreen,

    /// <summary>Ctrl+K — put the caret in the left panel's project search box.</summary>
    FocusProjectSearch,
}

/// <summary>
/// The window's keyboard chord table.
///
/// WHY THIS IS NOT INLINE IN MainWindow_PreviewKeyDown. It used to be, and that
/// is precisely how the Ctrl+K defect survived: the search box's own tooltip
/// said "Filter projects by name (Ctrl+K)" (MainWindow.xaml:1147) and a comment
/// above it said "Ctrl+K focuses this" (:1134), while the handler had no K case
/// at all. Nothing could assert the gap, because a WPF key handler cannot be
/// driven from a headless suite. A chord table that is a pure function CAN be,
/// so a shortcut the UI advertises is now provable without opening a window.
///
/// This owns only the DECISION. Focusing a control and resizing text stay in the
/// window, where they belong.
/// </summary>
public static class ShellShortcuts
{
    /// <summary>
    /// The action a chord asks for, or <see cref="ShellShortcut.None"/>.
    /// </summary>
    /// <param name="control">Whether Ctrl is held.</param>
    /// <param name="key">The non-modifier key.</param>
    /// <param name="consoleFullScreen">
    /// Whether the console is currently immersive. Escape is only ours while it
    /// is — otherwise Escape belongs to whatever has focus, and swallowing it
    /// would break every text box and popup in the app.
    /// </param>
    public static ShellShortcut Resolve(bool control, ShellKey key, bool consoleFullScreen)
    {
        if (control)
        {
            switch (key)
            {
                // OemPlus/OemMinus are the main row; Add/Subtract are the numeric pad.
                // Ctrl+= / Ctrl+- / Ctrl+0 is the browser convention, so nobody has
                // to be taught it.
                case ShellKey.OemPlus:
                case ShellKey.Add:
                    return ShellShortcut.TextLarger;

                case ShellKey.OemMinus:
                case ShellKey.Subtract:
                    return ShellShortcut.TextSmaller;

                case ShellKey.D0:
                case ShellKey.NumPad0:
                    return ShellShortcut.TextDefault;

                case ShellKey.K:
                    return ShellShortcut.FocusProjectSearch;
            }
        }

        // F11 toggles regardless of Ctrl, the way a browser does.
        if (key == ShellKey.F11)
        {
            return ShellShortcut.ToggleConsoleFullScreen;
        }

        if (key == ShellKey.Escape && consoleFullScreen)
        {
            return ShellShortcut.ExitConsoleFullScreen;
        }

        return ShellShortcut.None;
    }
}
