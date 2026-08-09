namespace Helmion.Desktop.Core;

/// <summary>
/// Session-local shell presentation state. Full screen and the two side panels
/// are deliberately independent: entering F11 must not silently reopen a panel,
/// and hiding Guard must never hide Projects (or vice versa).
/// </summary>
public readonly record struct ShellLayoutState(
    bool IsFullScreen,
    bool LeftPanelVisible,
    bool RightPanelVisible)
{
    public static ShellLayoutState Default => new(
        IsFullScreen: false,
        LeftPanelVisible: true,
        RightPanelVisible: false);

    public bool ShowWindowsCaption => !IsFullScreen;

    public bool ShowAppHeaderAndFooter => !IsFullScreen;

    public ShellLayoutState WithFullScreen(bool enabled) => this with
    {
        IsFullScreen = enabled
    };

    public ShellLayoutState ToggleLeftPanel() => this with
    {
        LeftPanelVisible = !LeftPanelVisible
    };

    public ShellLayoutState ToggleRightPanel() => this with
    {
        RightPanelVisible = !RightPanelVisible
    };
}
