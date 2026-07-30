namespace Helmion.Desktop.Core;

/// <summary>What the host should do to the focused window for one utterance.</summary>
public enum DictationActionKind
{
    /// <summary>Inject <see cref="DictationAction.Text"/> as literal characters.</summary>
    TypeText,

    /// <summary>Press <see cref="DictationAction.Chord"/>, <see cref="DictationAction.Repeat"/> times.</summary>
    PressKey,

    /// <summary>Leave dictation mode. The host stops capture and exits.</summary>
    StopDictation,
}

/// <summary>
/// The only key presses dictation is allowed to synthesize. Deliberately a tiny
/// closed set: anything that could reach a shell as a control character, a
/// shortcut, or a modifier combination is not expressible here.
/// </summary>
public enum DictationKeyChord
{
    /// <summary>Submit. This is the ONLY chord that can send a message.</summary>
    Enter,

    /// <summary>Insert a line break without submitting.</summary>
    ShiftEnter,

    /// <summary>Erase one character to the left.</summary>
    Backspace,
}

/// <summary>One keyboard action. <see cref="Text"/> is empty for key presses.</summary>
public readonly record struct DictationAction(
    DictationActionKind Kind,
    string Text,
    DictationKeyChord Chord,
    int Repeat)
{
    public static DictationAction Type(string text) =>
        new(DictationActionKind.TypeText, text, DictationKeyChord.Enter, 0);

    public static DictationAction Press(DictationKeyChord chord, int repeat = 1) =>
        new(DictationActionKind.PressKey, string.Empty, chord, repeat);

    public static DictationAction Stop() =>
        new(DictationActionKind.StopDictation, string.Empty, DictationKeyChord.Enter, 0);
}

/// <summary>
/// Turns a stream of dictated utterances into the keystrokes that reproduce them
/// in whatever window has focus.
/// </summary>
/// <remarks>
/// Pure and stateful-but-testable on purpose: no P/Invoke, no window handle, no
/// audio. The host owns the actual injection, so every rule below can be proven
/// headlessly, which matters because the rules are destructive — a wrong verdict
/// here erases text out of a real editor.
///
/// The load-bearing rule is the scratch bound. This class counts the characters
/// IT typed and will never emit more backspaces than that, so "scratch that"
/// cannot eat a single character the user typed by hand. A newline or a send
/// resets the count to zero, because after either one the previous chunk is no
/// longer to the left of the caret and backspacing would chew through whatever
/// is.
///
/// Typing and sending are separate, exactly as
/// <see cref="DictationCommands"/> separates them: literal speech only ever
/// produces <see cref="DictationActionKind.TypeText"/>. The single path to
/// <see cref="DictationKeyChord.Enter"/> is the explicit "send it" command.
/// </remarks>
public sealed class DictationTypist
{
    private readonly bool _appendSpace;
    private int _erasableChars;

    /// <param name="appendSpace">
    /// Append one space after each dictated chunk so consecutive utterances do
    /// not run together ("bookthe" instead of "book the"). The space is counted
    /// as erasable, so scratching removes it too.
    /// </param>
    public DictationTypist(bool appendSpace = true)
    {
        _appendSpace = appendSpace;
    }

    /// <summary>
    /// How many characters "scratch that" would currently erase. Zero means the
    /// caret is sitting on text this typist did not produce.
    /// </summary>
    public int ErasableCharacters => _erasableChars;

    /// <summary>
    /// Classify one transcript and return the keystrokes for it. An empty result
    /// means the utterance produced nothing — silence, noise, or a scratch with
    /// nothing of ours left to erase.
    /// </summary>
    public IReadOnlyList<DictationAction> Translate(string? transcript)
    {
        var command = DictationCommands.Detect(transcript);

        switch (command.Kind)
        {
            case DictationCommandKind.Literal:
                if (command.Text.Length == 0)
                {
                    return [];
                }

                var text = _appendSpace ? command.Text + " " : command.Text;
                _erasableChars = text.Length;
                return [DictationAction.Type(text)];

            case DictationCommandKind.Scratch:
                // Only ever as far back as our own last chunk.
                if (_erasableChars <= 0)
                {
                    return [];
                }

                var count = _erasableChars;
                _erasableChars = 0;
                return [DictationAction.Press(DictationKeyChord.Backspace, count)];

            case DictationCommandKind.Newline:
                _erasableChars = 0;
                return [DictationAction.Press(DictationKeyChord.ShiftEnter)];

            case DictationCommandKind.Send:
                _erasableChars = 0;
                return [DictationAction.Press(DictationKeyChord.Enter)];

            case DictationCommandKind.Stop:
                _erasableChars = 0;
                return [DictationAction.Stop()];

            default:
                return [];
        }
    }

    /// <summary>
    /// Forget what was typed, without typing anything. Called when focus may have
    /// moved — the caret is no longer guaranteed to be after our last chunk, so
    /// backspacing from here would erase somebody else's text.
    /// </summary>
    public void ForgetTypedHistory() => _erasableChars = 0;
}
