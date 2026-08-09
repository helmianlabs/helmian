using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;

namespace Helmion.Desktop;

/// <summary>
/// The slash-command picker under the composer.
///
/// WHY IT EXISTS. The Skills row has been telling Troy "Type / in the box to see
/// them" while typing / did nothing at all. He typed "/////" and sat there. That
/// is the same defect as the Ctrl+K tooltip promising a shortcut that was never
/// bound: the app making a promise the code does not keep.
///
/// WHAT IT DELIBERATELY IS NOT. It does not invent commands. It shows exactly what
/// the bridge reported for this workspace and nothing else — if the list is empty,
/// it says so and closes rather than opening an empty box. Troy's standing rule
/// tonight is that nothing may be mock, stubbed or decorative, and a picker padded
/// with plausible-looking entries would be precisely that.
/// </summary>
public partial class MainWindow
{
    /// <summary>One row in the picker. Name is inserted; Detail is only read.</summary>
    private sealed record SlashPick(string Name, string Detail);

    /// <summary>
    /// Fill and open the picker, or say plainly that there is nothing to show.
    ///
    /// Called after the command list has been fetched, so it renders real data or
    /// nothing. Never opens on stale state.
    /// </summary>
    private void ShowSlashPicker()
    {
        if (SlashCommandPopup is null || SlashCommandList is null) return;

        var picks = _knownCommands
            .OrderBy(name => name, StringComparer.OrdinalIgnoreCase)
            .Select(name => new SlashPick(
                "/" + name,
                _knownCommandDetails.TryGetValue(name, out var detail) && detail.Length > 0
                    ? detail
                    : "No description was provided for this command."))
            .ToList();

        if (picks.Count == 0)
        {
            SlashCommandPopup.IsOpen = false;
            return;
        }

        SlashCommandList.ItemsSource = picks;
        SlashCommandList.SelectedIndex = 0;
        SlashCommandPopup.IsOpen = true;
    }

    private void HideSlashPicker()
    {
        if (SlashCommandPopup is not null) SlashCommandPopup.IsOpen = false;
    }

    /// <summary>
    /// Keep the picker honest as he types: filter it, and close it the moment the
    /// text stops being a bare command.
    ///
    /// A picker that stays open over a sentence he is writing is worse than none,
    /// so it closes as soon as the line no longer starts with "/" or he has typed
    /// a space (at which point he is writing arguments, not choosing a command).
    /// </summary>
    private void ConsoleInputBox_TextChanged(object sender, TextChangedEventArgs e)
    {
        UpdateConsoleInputPlaceholderVisibility();

        if (SlashCommandPopup is null || SlashCommandList is null) return;
        if (!SlashCommandPopup.IsOpen) return;

        var text = ConsoleInputBox?.Text ?? string.Empty;

        if (!text.StartsWith('/') || text.Contains(' '))
        {
            HideSlashPicker();
            return;
        }

        var typed = text[1..];
        var matches = _knownCommands
            .Where(name => name.StartsWith(typed, StringComparison.OrdinalIgnoreCase))
            .OrderBy(name => name, StringComparer.OrdinalIgnoreCase)
            .Select(name => new SlashPick(
                "/" + name,
                _knownCommandDetails.TryGetValue(name, out var detail) && detail.Length > 0
                    ? detail
                    : "No description was provided for this command."))
            .ToList();

        if (matches.Count == 0)
        {
            HideSlashPicker();
            return;
        }

        SlashCommandList.ItemsSource = matches;
        SlashCommandList.SelectedIndex = 0;
    }

    /// <summary>Enter or Tab inserts the highlighted command; Escape closes.</summary>
    private void SlashCommandList_KeyDown(object sender, KeyEventArgs e)
    {
        switch (e.Key)
        {
            case Key.Enter:
            case Key.Tab:
                e.Handled = true;
                CommitSlashPick();
                break;

            case Key.Escape:
                e.Handled = true;
                HideSlashPicker();
                ConsoleInputBox?.Focus();
                break;
        }
    }

    private void SlashCommandList_Commit(object sender, MouseButtonEventArgs e)
    {
        e.Handled = true;
        CommitSlashPick();
    }

    /// <summary>
    /// Put the chosen command in the box and leave the caret after it, with a
    /// trailing space so arguments can be typed straight away. It does NOT send —
    /// he chooses a command, then decides what to do with it.
    /// </summary>
    private void CommitSlashPick()
    {
        if (SlashCommandList?.SelectedItem is not SlashPick pick || ConsoleInputBox is null)
        {
            HideSlashPicker();
            return;
        }

        ConsoleInputBox.Text = pick.Name + " ";
        ConsoleInputBox.CaretIndex = ConsoleInputBox.Text.Length;
        HideSlashPicker();
        ConsoleInputBox.Focus();
    }
}
