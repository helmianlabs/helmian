using System.Globalization;

namespace Helmion.VoiceDictation;

/// <summary>
/// A parsed global hotkey: the modifier bitmask and virtual-key code that
/// <c>RegisterHotKey</c> wants.
/// </summary>
/// <remarks>
/// RegisterHotKey matches modifiers EXACTLY — a hotkey registered as
/// Ctrl+Alt+Space is not triggered by Ctrl+Space. That is why the default here
/// can safely sit next to Grok Build's Ctrl+Space dictation binding without
/// stealing it (learn.microsoft.com/windows/win32/api/winuser/nf-winuser-registerhotkey).
/// </remarks>
public readonly record struct HotkeySpec(uint Modifiers, uint VirtualKey, string Text)
{
    public const uint ModAlt = 0x0001;
    public const uint ModControl = 0x0002;
    public const uint ModShift = 0x0004;
    public const uint ModWin = 0x0008;

    /// <summary>
    /// Suppresses the repeat storm a held-down hotkey would otherwise produce.
    /// Without this, leaning on the key queues dozens of WM_HOTKEY messages and
    /// the recorder toggles itself on and off many times.
    /// </summary>
    public const uint ModNoRepeat = 0x4000;

    /// <summary>
    /// Parse "ctrl+alt+space" and friends. Returns false rather than throwing —
    /// a typo in the config must degrade to "no hotkey registered, logged", not
    /// to a crash.
    /// </summary>
    public static bool TryParse(string? text, out HotkeySpec spec, out string? problem)
    {
        spec = default;
        problem = null;

        if (string.IsNullOrWhiteSpace(text))
        {
            problem = "hotkey is empty";
            return false;
        }

        uint modifiers = 0;
        string? keyToken = null;

        foreach (var raw in text.Split('+', StringSplitOptions.RemoveEmptyEntries))
        {
            var token = raw.Trim().ToLowerInvariant();
            switch (token)
            {
                case "ctrl" or "control":
                    modifiers |= ModControl;
                    break;
                case "alt":
                    modifiers |= ModAlt;
                    break;
                case "shift":
                    modifiers |= ModShift;
                    break;
                case "win" or "windows" or "super":
                    modifiers |= ModWin;
                    break;
                default:
                    if (keyToken is not null)
                    {
                        problem = $"'{text}' names more than one non-modifier key";
                        return false;
                    }

                    keyToken = token;
                    break;
            }
        }

        if (keyToken is null)
        {
            problem = $"'{text}' has modifiers but no key";
            return false;
        }

        if (!TryResolveVirtualKey(keyToken, out var virtualKey))
        {
            problem = $"'{keyToken}' is not a key name I recognise";
            return false;
        }

        // Troy explicitly asked twice (2026-08-02) for a bare backtick/tilde toggle
        // and was told the trade-off: Helmion now takes that keypress in every app,
        // so he cannot type a literal ` or ~ character anywhere while dictation is
        // running. Carved out for backtick only — every other key still refuses a
        // modifier-less binding below, so a config typo can't hijack e.g. space or
        // enter machine-wide.
        var isBareBacktickException = modifiers == 0 && (keyToken is "backtick" or "grave" or "oemtilde" or "`");

        if (modifiers == 0 && !isBareBacktickException)
        {
            // A bare key as a system-wide hotkey would swallow that key in every
            // application on the machine. Refuse rather than hijack his keyboard.
            problem = $"'{text}' has no modifier — that would capture the key everywhere";
            return false;
        }

        spec = new HotkeySpec(modifiers | ModNoRepeat, virtualKey, Describe(modifiers, keyToken));
        return true;
    }

    private static bool TryResolveVirtualKey(string token, out uint virtualKey)
    {
        virtualKey = 0;

        // Digits: "1" is Keys.D1, not Keys.D followed by a 1.
        if (token.Length == 1 && char.IsAsciiDigit(token[0]))
        {
            virtualKey = (uint)(Keys.D0 + (token[0] - '0'));
            return true;
        }

        if (token.Length == 1 && char.IsAsciiLetter(token[0]))
        {
            virtualKey = (uint)char.ToUpperInvariant(token[0]);
            return true;
        }

        var normalized = token switch
        {
            "esc" => "Escape",
            "enter" or "return" => "Return",
            "ins" => "Insert",
            "del" => "Delete",
            "pgup" => "PageUp",
            "pgdn" => "Next",
            "backtick" or "grave" => "Oemtilde",
            _ => token,
        };

        if (Enum.TryParse<Keys>(normalized, ignoreCase: true, out var parsed)
            && parsed != Keys.None)
        {
            virtualKey = (uint)parsed;
            return true;
        }

        return false;
    }

    private static string Describe(uint modifiers, string keyToken)
    {
        var parts = new List<string>(4);
        if ((modifiers & ModControl) != 0) { parts.Add("Ctrl"); }
        if ((modifiers & ModAlt) != 0) { parts.Add("Alt"); }
        if ((modifiers & ModShift) != 0) { parts.Add("Shift"); }
        if ((modifiers & ModWin) != 0) { parts.Add("Win"); }

        parts.Add(CultureInfo.InvariantCulture.TextInfo.ToTitleCase(keyToken));
        return string.Join("+", parts);
    }
}
