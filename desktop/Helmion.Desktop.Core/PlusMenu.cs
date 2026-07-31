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

/// <summary>
/// Which Maestro the + menu is currently speaking for.
///
/// THE MENU IS NOT ONE FIXED LIST. Troy's correction, 2026-07-30: "depending on
/// the agent, meaning the API… I want that plus button to be identical to what it
/// would be if I was on [that provider's] CLI. So whoever the Maestro is, that's
/// whose skills, connectors, plugins, all that, exact copied and populated and
/// working."
///
/// So every lookup in this file takes a maestro key. The built-in coordinators are
/// OpenAI, Claude, Gemini and Grok (MainWindow.xaml.cs:29 BuiltInCoordinators),
/// plus any custom provider the operator has added by name.
/// </summary>
public static class MaestroKey
{
    public const string OpenAi = "OpenAI";
    public const string Claude = "Claude";
    public const string Gemini = "Gemini";
    public const string Grok = "Grok";

    /// <summary>
    /// The canonical key for a coordinator name, or null when it is a custom
    /// provider this catalog knows nothing about.
    ///
    /// Null is a real answer, not a failure to be defaulted away. Falling back to
    /// a known provider's capability list would show a user a menu of features
    /// their actual model does not have — which is the same lie as a red card over
    /// healthy text, one screen further along.
    /// </summary>
    public static string? Normalize(string? maestro)
    {
        var m = (maestro ?? string.Empty).Trim().ToLowerInvariant();
        return m switch
        {
            "openai" or "chatgpt" or "codex" or "codex cli" or "gpt" => OpenAi,
            "claude" or "claude code" or "claude code cli" or "anthropic" => Claude,
            "gemini" or "gemini cli" or "google" => Gemini,
            "grok" or "xai" or "x.ai" or "grok cli" => Grok,
            _ => null,
        };
    }

    /// <summary>What to call it on screen, custom providers included.</summary>
    public static string DisplayName(string? maestro) =>
        Normalize(maestro) ?? (string.IsNullOrWhiteSpace(maestro) ? "no Maestro selected" : maestro.Trim());
}

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
/// The states every + action must be able to show.
/// <para>
/// <see cref="Removed"/> is a real state rather than a deletion because Troy's
/// fourth requirement is "remove / undo" — an item you can put back has to still
/// exist somewhere to be put back from.
/// </para>
/// <para>
/// <see cref="Empty"/> exists because NOTHING FOUND IS NOT AN ERROR. A fresh
/// workspace has no plugins.json, no connector need typed yet, nothing pinned —
/// and reporting that in red made the one part of the screen that was working
/// correctly look like the broken one. An empty state is calm, grey, and still
/// says what to do next; a failure means something was attempted and did not
/// work. Collapsing the two teaches the user to ignore red.
/// </para>
/// </summary>
public enum PlusActionState
{
    InProgress = 0,
    Succeeded = 1,
    Failed = 2,
    Removed = 3,
    Empty = 4,
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

    public PlusActionItem(PlusMenuKind kind, string title, string message, string? sourcePath = null)
    {
        Kind = kind;
        Entry = PlusMenuCatalog.For(kind);
        Title = string.IsNullOrWhiteSpace(title) ? Entry.Label : title;
        _state = PlusActionState.InProgress;
        _message = string.IsNullOrWhiteSpace(message) ? "Working…" : message;
        StartedAt = DateTimeOffset.Now;
        SourcePath = string.IsNullOrWhiteSpace(sourcePath) ? null : sourcePath;
    }

    /// <summary>
    /// The file on disk this row stands for, for an Upload. Null for every other
    /// kind, which have no file behind them.
    ///
    /// WITHOUT THIS THE UPLOAD IS DECORATIVE. The row used to keep only
    /// <see cref="Title"/> — the bare file NAME — so nothing downstream could
    /// ever open the file the user picked. A green "attached" row and no way to
    /// read what was attached is the silent lie this field exists to end.
    /// </summary>
    public string? SourcePath { get; }

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
        PlusActionState.Empty => "Nothing yet",
        _ => "Unknown",
    };

    /// <summary>Colour key for the template. A string so no converter is needed.</summary>
    public string StateKey => State switch
    {
        PlusActionState.InProgress => "Busy",
        PlusActionState.Succeeded => "Ok",
        PlusActionState.Failed => "Failed",
        PlusActionState.Removed => "Removed",
        PlusActionState.Empty => "Empty",
        _ => "Unknown",
    };

    public bool IsBusy => State == PlusActionState.InProgress;

    /// <summary>
    /// Removable once it has settled. You cannot remove something mid-flight.
    /// An empty row is settled too — the user has read "nothing yet" and is
    /// entitled to clear it off the list.
    /// </summary>
    public bool CanRemove =>
        State is PlusActionState.Succeeded or PlusActionState.Failed or PlusActionState.Empty;

    public bool CanUndo => State == PlusActionState.Removed;

    internal void Succeed(string message) { State = PlusActionState.Succeeded; Message = message; }

    internal void Fail(string message) { State = PlusActionState.Failed; Message = message; }

    internal void MarkEmpty(string message) { State = PlusActionState.Empty; Message = message; }

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

    /// <summary>
    /// Starts a row in the in-progress state and returns it.
    /// </summary>
    /// <param name="sourcePath">
    /// For an Upload, the FULL path of the file the user picked — not the name.
    /// This is what lets <see cref="PromptAttachments"/> reopen the file at send
    /// time; without it an attachment can only ever be a label.
    /// </param>
    public PlusActionItem Begin(
        PlusMenuKind kind,
        string title,
        string? message = null,
        string? sourcePath = null)
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
            },
            sourcePath);
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
    /// Settles a row as EMPTY — the thing was looked for and is not there yet.
    ///
    /// Not a failure, and deliberately not a success either: "Added" over an empty
    /// registry would be its own small lie. The message is still mandatory, on the
    /// same reasoning as <see cref="Fail"/>, because an empty state that does not
    /// say what to do next is just a dead end with better manners.
    /// </summary>
    public PlusActionItem Empty(PlusActionItem item, string message)
    {
        ArgumentNullException.ThrowIfNull(item);
        item.MarkEmpty(string.IsNullOrWhiteSpace(message)
            ? "There is nothing here yet, and Helmion did not say what would put something here. That is a bug in Helmion."
            : message);
        return item;
    }

    /// <summary>
    /// Applies an outcome decided by <see cref="FirstRunStates"/>.
    ///
    /// THE POINT OF THIS METHOD is that the level and the row are set from the SAME
    /// object the smoke suite asserts on. Before, the window decided the level at
    /// the call site, so a headless test could prove the classifier said "empty"
    /// while the window still drew red — the two could drift and nothing would
    /// catch it. Routing both through here makes the tested value and the rendered
    /// value the same value.
    /// </summary>
    public PlusActionItem Settle(PlusActionItem item, PlusOutcome outcome)
    {
        ArgumentNullException.ThrowIfNull(item);
        ArgumentNullException.ThrowIfNull(outcome);

        return outcome.State switch
        {
            PlusActionState.Succeeded => Succeed(item, outcome.Message),
            PlusActionState.Empty => Empty(item, outcome.Message),
            PlusActionState.Failed => Fail(item, outcome.Message),

            // InProgress and Removed are not outcomes, and a state this method does
            // not recognise must not be silently rendered as success.
            _ => Fail(item,
                $"Helmion could not settle this row: it produced the state "
                + $"\"{outcome.State}\", which is not an outcome. That is a bug in Helmion. "
                + $"The underlying message was: {outcome.Message}"),
        };
    }

    /// <summary>
    /// Where a removed row was sitting, so Undo can put it back in its own place
    /// rather than at the bottom. Keyed by identity, not by value.
    /// </summary>
    private readonly Dictionary<PlusActionItem, int> _removedFrom = new(ReferenceEqualityComparer.Instance);

    /// <summary>
    /// Removes a settled row — and TAKES IT OFF THE LIST.
    ///
    /// <para>
    /// This used to only flip the state to Removed and leave the row sitting
    /// there with an Undo button on it. Troy, 2026-07-30, with a screenshot of
    /// eleven stacked "New project — Removed" bars: "When you hit Remove, those
    /// need to go away." He is right. A row whose entire content is a note that
    /// it is gone is worse than no row: it takes the same space as real output
    /// and it is what the console fills up with.
    /// </para>
    /// <para>
    /// Undo still works. The row is held here with the index it came from, so
    /// <see cref="Undo"/> puts it back exactly where it was — which is why this
    /// remembers a position rather than just appending on restore.
    /// </para>
    /// </summary>
    public bool Remove(PlusActionItem item)
    {
        if (item is null || !item.CanRemove) return false;
        item.MarkRemoved($"{item.Title} removed. Undo puts it back.");

        var at = Items.IndexOf(item);
        if (at >= 0)
        {
            _removedFrom[item] = at;
            Items.RemoveAt(at);
        }
        return true;
    }

    /// <summary>
    /// Puts a removed row back, in its original position.
    ///
    /// Re-inserting is what makes removal safe to make invisible: an upload that
    /// was taken off the list stops riding along with the next prompt, and comes
    /// back attached when it is restored. <see cref="ActiveAttachments"/> reads
    /// <see cref="Items"/>, so membership IS the attachment.
    /// </summary>
    public bool Undo(PlusActionItem item)
    {
        if (item is null || !item.CanUndo) return false;
        item.Restore($"{item.Title} restored.");

        if (!Items.Contains(item))
        {
            var at = _removedFrom.TryGetValue(item, out var was) ? was : Items.Count;
            Items.Insert(Math.Clamp(at, 0, Items.Count), item);
        }
        _removedFrom.Remove(item);
        return true;
    }

    /// <summary>
    /// Drops a removed row for good — forgets its undo position so it cannot come
    /// back. Since Remove now takes the row off Items itself, this is about giving
    /// up the ability to restore, not about the row disappearing.
    /// </summary>
    public bool Discard(PlusActionItem item)
    {
        if (item is null || item.State != PlusActionState.Removed) return false;
        Items.Remove(item);
        return _removedFrom.Remove(item) || true;
    }

    public void Clear() => Items.Clear();

    /// <summary>Attachments still live — what actually rides along with the next prompt.</summary>
    public IReadOnlyList<PlusActionItem> ActiveAttachments => Items
        .Where(item => item.Kind == PlusMenuKind.Upload && item.State == PlusActionState.Succeeded)
        .ToList();
}
