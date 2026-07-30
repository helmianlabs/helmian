using System.Collections.ObjectModel;
using System.ComponentModel;
using System.Runtime.CompilerServices;

namespace Helmion.Desktop.Core;

/// <summary>The four things the + button in the composer can add.</summary>
public enum PlusMenuKind
{
    Connector = 0,
    Plugin = 1,
    Skill = 2,
    Upload = 3,
}

/// <summary>
/// One row of the + menu.
///
/// <see cref="OneLiner"/> is not decoration. Troy's requirement: "Each item shows
/// a plain-language one-line description so a new user knows what it does. Do not
/// assume the user knows the difference between a connector, a plugin, and a
/// skill." Those three words mean almost the same thing to anyone who has not
/// read the docs, so the menu explains itself or it is useless.
/// </summary>
public sealed record PlusMenuEntry(
    PlusMenuKind Kind,
    string Icon,
    string Label,
    string OneLiner);

/// <summary>The four rows, in the order they appear.</summary>
public static class PlusMenuCatalog
{
    public static IReadOnlyList<PlusMenuEntry> Entries { get; } =
    [
        new(PlusMenuKind.Connector, "⇄", "Connectors",
            "Let Helmion reach an outside service — a database, GitHub, your calendar. Checked before it is trusted."),

        new(PlusMenuKind.Plugin, "🧩", "Plugins",
            "Add a bundle someone else built: commands, tools and settings in one folder."),

        new(PlusMenuKind.Skill, "📘", "Skills",
            "Teach this session a repeatable procedure of your own, and call it by name with a slash command."),

        new(PlusMenuKind.Upload, "📎", "Upload",
            "Attach a text or code file to your next message so the model can read it."),
    ];

    public static PlusMenuEntry For(PlusMenuKind kind) =>
        Entries.First(entry => entry.Kind == kind);
}

/// <summary>
/// The four states every + action must be able to show.
/// <para>
/// <see cref="Removed"/> is a real state rather than a deletion because Troy's
/// fourth requirement is "remove / undo" — an item you can put back has to still
/// exist somewhere to be put back from.
/// </para>
/// </summary>
public enum PlusActionState
{
    InProgress = 0,
    Succeeded = 1,
    Failed = 2,
    Removed = 3,
}

/// <summary>
/// One attempt to add something, and everything the row on screen needs to draw
/// itself in any of the four states.
///
/// NO SILENT ANYTHING. There is no constructor that produces an item without a
/// message, and no transition that clears one. A row is always able to say what
/// is happening to it, which is the difference between a spinner that stopped and
/// a failure nobody reported.
/// </summary>
public sealed class PlusActionItem : INotifyPropertyChanged
{
    private PlusActionState _state;
    private string _message;
    private PlusActionState? _stateBeforeRemoval;

    public PlusActionItem(PlusMenuKind kind, string title, string message)
    {
        Kind = kind;
        Entry = PlusMenuCatalog.For(kind);
        Title = string.IsNullOrWhiteSpace(title) ? Entry.Label : title;
        _state = PlusActionState.InProgress;
        _message = string.IsNullOrWhiteSpace(message) ? "Working…" : message;
        StartedAt = DateTimeOffset.Now;
    }

    public PlusMenuKind Kind { get; }

    public PlusMenuEntry Entry { get; }

    public string Title { get; }

    public DateTimeOffset StartedAt { get; }

    public PlusActionState State
    {
        get => _state;
        private set
        {
            if (_state == value) return;
            _state = value;
            Raise(nameof(State));
            Raise(nameof(StateText));
            Raise(nameof(StateKey));
            Raise(nameof(IsBusy));
            Raise(nameof(CanRemove));
            Raise(nameof(CanUndo));
        }
    }

    /// <summary>Always populated. On a failure this is the readable error.</summary>
    public string Message
    {
        get => _message;
        private set
        {
            var next = string.IsNullOrWhiteSpace(value) ? _message : value;
            if (_message == next) return;
            _message = next;
            Raise(nameof(Message));
        }
    }

    /// <summary>
    /// The state in words. Colour is never the only channel — the same reasoning
    /// as the guard panel, where a red card with healthy text taught nobody
    /// anything.
    /// </summary>
    public string StateText => State switch
    {
        PlusActionState.InProgress => "Connecting…",
        PlusActionState.Succeeded => "Added",
        PlusActionState.Failed => "Failed",
        PlusActionState.Removed => "Removed",
        _ => "Unknown",
    };

    /// <summary>Colour key for the template. A string so no converter is needed.</summary>
    public string StateKey => State switch
    {
        PlusActionState.InProgress => "Busy",
        PlusActionState.Succeeded => "Ok",
        PlusActionState.Failed => "Failed",
        PlusActionState.Removed => "Removed",
        _ => "Unknown",
    };

    public bool IsBusy => State == PlusActionState.InProgress;

    /// <summary>Removable once it has settled. You cannot remove something mid-flight.</summary>
    public bool CanRemove => State is PlusActionState.Succeeded or PlusActionState.Failed;

    public bool CanUndo => State == PlusActionState.Removed;

    internal void Succeed(string message) { State = PlusActionState.Succeeded; Message = message; }

    internal void Fail(string message) { State = PlusActionState.Failed; Message = message; }

    internal void MarkRemoved(string message)
    {
        _stateBeforeRemoval = State;
        State = PlusActionState.Removed;
        Message = message;
    }

    internal void Restore(string message)
    {
        State = _stateBeforeRemoval ?? PlusActionState.Succeeded;
        _stateBeforeRemoval = null;
        Message = message;
    }

    public event PropertyChangedEventHandler? PropertyChanged;

    private void Raise([CallerMemberName] string? name = null) =>
        PropertyChanged?.Invoke(this, new PropertyChangedEventArgs(name!));
}

/// <summary>
/// Holds the rows the composer shows under the + button and moves them between
/// states.
///
/// It does no I/O. The window owns the file dialog, the MCP scan and the bridge
/// call; this owns what the user SEES while those happen. That split is what
/// makes all four states provable from the smoke suite with no window open —
/// which matters here, because the states that are never tested are exactly the
/// two Troy called out: in-progress and failed.
/// </summary>
public sealed class PlusMenuController
{
    /// <summary>Rows currently on screen, newest last.</summary>
    public ObservableCollection<PlusActionItem> Items { get; } = [];

    public IReadOnlyList<PlusMenuEntry> Entries => PlusMenuCatalog.Entries;

    /// <summary>Starts a row in the in-progress state and returns it.</summary>
    public PlusActionItem Begin(PlusMenuKind kind, string title, string? message = null)
    {
        var entry = PlusMenuCatalog.For(kind);
        var item = new PlusActionItem(
            kind,
            title,
            message ?? kind switch
            {
                PlusMenuKind.Connector => "Checking this connector before trusting it…",
                PlusMenuKind.Plugin => "Reading the plugin folder…",
                PlusMenuKind.Skill => "Loading the skills this session can use…",
                PlusMenuKind.Upload => "Checking the file…",
                _ => $"Working on {entry.Label}…",
            });
        Items.Add(item);
        return item;
    }

    public PlusActionItem Succeed(PlusActionItem item, string message)
    {
        ArgumentNullException.ThrowIfNull(item);
        item.Succeed(message);
        return item;
    }

    /// <summary>
    /// Fails a row with a sentence. An empty message is refused rather than
    /// accepted, because "Failed" with no reason is the silent failure this
    /// feature exists to prevent, wearing a red label.
    /// </summary>
    public PlusActionItem Fail(PlusActionItem item, string message)
    {
        ArgumentNullException.ThrowIfNull(item);
        item.Fail(string.IsNullOrWhiteSpace(message)
            ? "It failed, and the reason was not reported. That is a bug in Helmion, not in what you tried to add."
            : message);
        return item;
    }

    /// <summary>
    /// Removes a settled row. The row stays in the list in the Removed state so
    /// it can be undone; it is not deleted until <see cref="Discard"/>.
    /// </summary>
    public bool Remove(PlusActionItem item)
    {
        if (item is null || !item.CanRemove) return false;
        item.MarkRemoved($"{item.Title} removed. Undo puts it back.");
        return true;
    }

    public bool Undo(PlusActionItem item)
    {
        if (item is null || !item.CanUndo) return false;
        item.Restore($"{item.Title} restored.");
        return true;
    }

    /// <summary>Drops a removed row for good. Nothing else deletes.</summary>
    public bool Discard(PlusActionItem item)
    {
        if (item is null || item.State != PlusActionState.Removed) return false;
        return Items.Remove(item);
    }

    public void Clear() => Items.Clear();

    /// <summary>Attachments still live — what actually rides along with the next prompt.</summary>
    public IReadOnlyList<PlusActionItem> ActiveAttachments => Items
        .Where(item => item.Kind == PlusMenuKind.Upload && item.State == PlusActionState.Succeeded)
        .ToList();
}
