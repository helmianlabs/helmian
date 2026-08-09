namespace Helmion.Desktop.Core;

/// <summary>
/// A parsed global-hotkey combination: Win32 modifier flags plus a virtual-key
/// code, ready to hand to RegisterHotKey.
/// </summary>
/// <remarks>
/// Pure by design — no P/Invoke here, only the numbers. That keeps the parser
/// testable without registering anything, which matters because a global hotkey
/// registration STEALS the combination from every other application on the
/// machine for as long as it is held. Getting the parse wrong is not a cosmetic
/// bug; it silently breaks a key the user relies on somewhere else.
/// </remarks>
public readonly record struct HotkeyChord(uint Modifiers, uint VirtualKey, string Display)
{
    public const uint ModAlt = 0x0001;
    public const uint ModControl = 0x0002;
    public const uint ModShift = 0x0004;
    public const uint ModWin = 0x0008;

    /// <summary>Suppresses the auto-repeat storm from a held key.</summary>
    public const uint ModNoRepeat = 0x4000;

    /// <summary>
    /// Helmion's dictation toggle. CHANGED 2026-08-04 at Troy's explicit direction, back to a
    /// single Tilde/backquote key — he reported the prior 4-key chord ("ctrl+shift+alt+h", the
    /// only value ever committed here; docs/POWERSHELL_VOICE.md referenced above it does not
    /// exist in this repo, so its stated reasoning could not be verified) as a regression from a
    /// simpler single-key binding he had working before. TryParseKey already supports "backquote"
    /// /"grave" (VK_OEM_3, 0xC0) as a lone key with zero modifiers.
    /// </summary>
    public const string DefaultChord = "grave";

    /// <summary>Modifier flags with auto-repeat suppressed, as RegisterHotKey wants them.</summary>
    public uint ModifiersForRegistration => Modifiers | ModNoRepeat;

    /// <summary>
    /// Parse a chord such as "ctrl+shift+alt+h". Case and spacing are ignored.
    /// Returns false with a reason rather than throwing, because this parses user
    /// input from a command line.
    /// </summary>
    public static bool TryParse(string? text, out HotkeyChord chord, out string? error)
    {
        chord = default;
        error = null;

        if (string.IsNullOrWhiteSpace(text))
        {
            error = "No hotkey given.";
            return false;
        }

        uint modifiers = 0;
        uint virtualKey = 0;
        var keyToken = string.Empty;
        var parts = text.Split('+', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);

        foreach (var raw in parts)
        {
            var token = raw.ToLowerInvariant();
            switch (token)
            {
                case "ctrl" or "control":
                    modifiers |= ModControl;
                    continue;
                case "shift":
                    modifiers |= ModShift;
                    continue;
                case "alt":
                    modifiers |= ModAlt;
                    continue;
                case "win" or "windows" or "super":
                    modifiers |= ModWin;
                    continue;
            }

            if (virtualKey != 0)
            {
                error = $"'{text}' names more than one non-modifier key.";
                return false;
            }

            if (!TryParseKey(token, out virtualKey))
            {
                error = $"'{raw}' is not a key this parser knows.";
                return false;
            }

            keyToken = token;
        }

        if (virtualKey == 0)
        {
            error = $"'{text}' has modifiers but no key.";
            return false;
        }

        chord = new HotkeyChord(modifiers, virtualKey, Describe(modifiers, keyToken));
        return true;
    }

    private static bool TryParseKey(string token, out uint virtualKey)
    {
        virtualKey = 0;

        if (token.Length == 1)
        {
            var c = char.ToUpperInvariant(token[0]);
            if (c is >= 'A' and <= 'Z' or >= '0' and <= '9')
            {
                virtualKey = c;
                return true;
            }

            return false;
        }

        if (token.Length is 2 or 3
            && token[0] == 'f'
            && int.TryParse(token[1..], out var fn)
            && fn is >= 1 and <= 24)
        {
            virtualKey = (uint)(0x70 + fn - 1);   // VK_F1 = 0x70
            return true;
        }

        virtualKey = token switch
        {
            "space" => 0x20,
            "enter" or "return" => 0x0D,
            "tab" => 0x09,
            "escape" or "esc" => 0x1B,
            "insert" or "ins" => 0x2D,
            "delete" or "del" => 0x2E,
            "home" => 0x24,
            "end" => 0x23,
            "pageup" => 0x21,
            "pagedown" => 0x22,
            "scrolllock" => 0x91,
            "pause" => 0x13,
            "backquote" or "grave" => 0xC0,
            _ => 0,
        };

        return virtualKey != 0;
    }

    private static string Describe(uint modifiers, string keyToken)
    {
        var names = new List<string>(4);
        if ((modifiers & ModControl) != 0) names.Add("Ctrl");
        if ((modifiers & ModShift) != 0) names.Add("Shift");
        if ((modifiers & ModAlt) != 0) names.Add("Alt");
        if ((modifiers & ModWin) != 0) names.Add("Win");

        names.Add(keyToken.Length == 1
            ? keyToken.ToUpperInvariant()
            : char.ToUpperInvariant(keyToken[0]) + keyToken[1..]);

        return string.Join("+", names);
    }
}
