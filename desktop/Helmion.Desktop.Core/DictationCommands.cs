using System.Text.RegularExpressions;

namespace Helmion.Desktop.Core;

/// <summary>What a dictated utterance turned out to be.</summary>
public enum DictationCommandKind
{
    /// <summary>Ordinary text — type it.</summary>
    Literal,

    /// <summary>Insert a line break.</summary>
    Newline,

    /// <summary>Erase the previous dictated chunk.</summary>
    Scratch,

    /// <summary>Submit what has been dictated so far.</summary>
    Send,

    /// <summary>Leave dictation mode.</summary>
    Stop,
}

/// <summary>
/// One classified utterance. <see cref="Text"/> carries the words to insert for
/// <see cref="DictationCommandKind.Literal"/> and is empty for every command.
/// </summary>
public readonly record struct DictationCommand(DictationCommandKind Kind, string Text)
{
    public static DictationCommand Literal(string text) => new(DictationCommandKind.Literal, text);

    public static DictationCommand Command(DictationCommandKind kind) => new(kind, string.Empty);
}

/// <summary>
/// Classifies a dictation transcript as either a reserved command or literal text.
/// </summary>
/// <remarks>
/// Deliberately a pure function of the transcript so it is testable without a
/// microphone, a model, or a UI. The UI layer decides what to DO with the result
/// (route to a caret, clear the box, submit) — this only decides what was said.
///
/// Matching is intentionally strict: a command must be the ENTIRE utterance.
/// "send it" is a command; "send it to the vendor tomorrow" is dictated text.
/// Being conservative here matters because a false command silently destroys
/// what the user was typing, while a missed command is merely an annoyance.
/// </remarks>
public static class DictationCommands
{
    // Whisper emits leading/trailing spaces and sentence punctuation it inferred
    // from prosody, so "New line." and " new line " must reach the same verdict.
    private static readonly Regex TrimmablePunctuation =
        new(@"^[\s\p{P}]+|[\s\p{P}]+$", RegexOptions.Compiled);

    private static readonly Regex CollapseWhitespace =
        new(@"\s+", RegexOptions.Compiled);

    private static readonly Dictionary<string, DictationCommandKind> Reserved =
        new(StringComparer.OrdinalIgnoreCase)
        {
            ["new line"] = DictationCommandKind.Newline,
            ["newline"] = DictationCommandKind.Newline,
            ["next line"] = DictationCommandKind.Newline,
            ["new paragraph"] = DictationCommandKind.Newline,

            ["scratch that"] = DictationCommandKind.Scratch,
            ["delete that"] = DictationCommandKind.Scratch,
            ["undo that"] = DictationCommandKind.Scratch,

            ["send it"] = DictationCommandKind.Send,
            ["send message"] = DictationCommandKind.Send,
            ["send that"] = DictationCommandKind.Send,
            ["submit"] = DictationCommandKind.Send,

            ["stop listening"] = DictationCommandKind.Stop,
            ["stop dictation"] = DictationCommandKind.Stop,
            ["stop dictating"] = DictationCommandKind.Stop,
            ["voice off"] = DictationCommandKind.Stop,
        };

    /// <summary>
    /// Classify one utterance. Null, empty, or punctuation-only input yields
    /// <see cref="DictationCommandKind.Literal"/> with empty text, which callers
    /// should ignore.
    /// </summary>
    public static DictationCommand Detect(string? transcript)
    {
        if (string.IsNullOrWhiteSpace(transcript))
        {
            return DictationCommand.Literal(string.Empty);
        }

        var normalized = Normalize(transcript);
        if (normalized.Length == 0)
        {
            return DictationCommand.Literal(string.Empty);
        }

        if (Reserved.TryGetValue(normalized, out var kind))
        {
            return DictationCommand.Command(kind);
        }

        // Not a command — hand back the original words, only trimmed. Casing and
        // internal punctuation are Whisper's and should survive into the caret.
        return DictationCommand.Literal(transcript.Trim());
    }

    /// <summary>
    /// Lowercased, punctuation-stripped, single-spaced form used for matching.
    /// Exposed so tests can assert the normalization itself.
    /// </summary>
    public static string Normalize(string transcript)
    {
        if (string.IsNullOrWhiteSpace(transcript))
        {
            return string.Empty;
        }

        var s = TrimmablePunctuation.Replace(transcript, string.Empty);
        s = CollapseWhitespace.Replace(s, " ");
        return s.ToLowerInvariant();
    }
}
