using System.Runtime.InteropServices;
using Helmion.Desktop.Core;

namespace Helmion.Voice.Host;

/// <summary>
/// Types dictated text into whatever window currently has focus, using SendInput.
/// </summary>
/// <remarks>
/// SendInput posts into the system input queue, so the characters land in the
/// foreground window exactly as if they had been typed. That is why this host
/// needs no window of its own and no cooperation from the target application —
/// a terminal, an editor and a browser text box all receive it the same way.
///
/// Characters go out as KEYEVENTF_UNICODE scan codes rather than virtual keys,
/// so the text is reproduced literally regardless of the active keyboard layout.
/// A US-layout VK_A would become something else entirely on a Dvorak or a German
/// layout; a Unicode code unit is a code unit everywhere.
///
/// Only three chords are expressible (<see cref="DictationKeyChord"/>), and only
/// one of them submits. Nothing here can synthesize Ctrl, Alt or Win — dictation
/// must never be able to fire an application shortcut.
/// </remarks>
internal static class KeyboardInjector
{
    private const uint InputKeyboard = 1;
    private const uint KeyEventKeyUp = 0x0002;
    private const uint KeyEventUnicode = 0x0004;

    private const ushort VkBack = 0x08;
    private const ushort VkReturn = 0x0D;
    private const ushort VkShift = 0x10;

    /// <summary>
    /// One SendInput call carries at most this many events. Long dictated
    /// sentences are split so a single oversized batch cannot be rejected
    /// wholesale, which would drop the entire utterance rather than part of it.
    /// </summary>
    private const int MaxEventsPerCall = 512;

    /// <summary>Handle of the window that currently has keyboard focus.</summary>
    public static IntPtr ForegroundWindow => GetForegroundWindow();

    /// <summary>
    /// Perform one action. Returns false when the OS refused the injection, which
    /// happens when a higher-integrity window (UAC prompt, secure desktop) has
    /// focus — the caller reports it rather than silently losing the words.
    /// </summary>
    public static bool Perform(DictationAction action)
    {
        return action.Kind switch
        {
            DictationActionKind.TypeText => TypeText(action.Text),
            DictationActionKind.PressKey => PressChord(action.Chord, action.Repeat),
            _ => true,
        };
    }

    private static bool TypeText(string text)
    {
        if (text.Length == 0)
        {
            return true;
        }

        // Two events per UTF-16 code unit: key down, key up. Surrogate pairs are
        // emitted as their two code units, which is what the API expects.
        var events = new List<INPUT>(Math.Min(text.Length * 2, MaxEventsPerCall));
        var ok = true;

        foreach (var unit in text)
        {
            if (unit == '\n' || unit == '\r')
            {
                // A raw newline in dictated text would submit in a terminal. The
                // only path to Enter is the explicit "send it" command.
                continue;
            }

            events.Add(UnicodeEvent(unit, keyUp: false));
            events.Add(UnicodeEvent(unit, keyUp: true));

            if (events.Count >= MaxEventsPerCall)
            {
                ok &= Send(events);
                events.Clear();
            }
        }

        if (events.Count > 0)
        {
            ok &= Send(events);
        }

        return ok;
    }

    private static bool PressChord(DictationKeyChord chord, int repeat)
    {
        if (repeat <= 0)
        {
            return true;
        }

        var events = new List<INPUT>(repeat * 4);

        switch (chord)
        {
            case DictationKeyChord.Backspace:
                for (var i = 0; i < repeat; i++)
                {
                    events.Add(VirtualKeyEvent(VkBack, keyUp: false));
                    events.Add(VirtualKeyEvent(VkBack, keyUp: true));
                }

                break;

            case DictationKeyChord.Enter:
                for (var i = 0; i < repeat; i++)
                {
                    events.Add(VirtualKeyEvent(VkReturn, keyUp: false));
                    events.Add(VirtualKeyEvent(VkReturn, keyUp: true));
                }

                break;

            case DictationKeyChord.ShiftEnter:
                for (var i = 0; i < repeat; i++)
                {
                    events.Add(VirtualKeyEvent(VkShift, keyUp: false));
                    events.Add(VirtualKeyEvent(VkReturn, keyUp: false));
                    events.Add(VirtualKeyEvent(VkReturn, keyUp: true));
                    events.Add(VirtualKeyEvent(VkShift, keyUp: true));
                }

                break;

            default:
                return true;
        }

        var ok = true;
        for (var offset = 0; offset < events.Count; offset += MaxEventsPerCall)
        {
            ok &= Send(events.GetRange(offset, Math.Min(MaxEventsPerCall, events.Count - offset)));
        }

        return ok;
    }

    private static bool Send(List<INPUT> events)
    {
        if (events.Count == 0)
        {
            return true;
        }

        var buffer = events.ToArray();
        var sent = SendInput((uint)buffer.Length, buffer, Marshal.SizeOf<INPUT>());
        return sent == (uint)buffer.Length;
    }

    private static INPUT UnicodeEvent(char unit, bool keyUp) => new()
    {
        type = InputKeyboard,
        u = new InputUnion
        {
            ki = new KEYBDINPUT
            {
                wVk = 0,
                wScan = unit,
                dwFlags = KeyEventUnicode | (keyUp ? KeyEventKeyUp : 0),
                time = 0,
                dwExtraInfo = IntPtr.Zero,
            },
        },
    };

    private static INPUT VirtualKeyEvent(ushort virtualKey, bool keyUp) => new()
    {
        type = InputKeyboard,
        u = new InputUnion
        {
            ki = new KEYBDINPUT
            {
                wVk = virtualKey,
                wScan = 0,
                dwFlags = keyUp ? KeyEventKeyUp : 0,
                time = 0,
                dwExtraInfo = IntPtr.Zero,
            },
        },
    };

    [DllImport("user32.dll", SetLastError = true)]
    private static extern uint SendInput(uint cInputs, INPUT[] pInputs, int cbSize);

    [DllImport("user32.dll")]
    private static extern IntPtr GetForegroundWindow();

    // The interop structs below mirror the Win32 layout exactly. Several members
    // are never assigned by this file (see MOUSEINPUT), which is the point — they
    // are there for size and offset, not for us to write.
#pragma warning disable CS0649

    [StructLayout(LayoutKind.Sequential)]
    private struct INPUT
    {
        public uint type;
        public InputUnion u;
    }

    [StructLayout(LayoutKind.Explicit)]
    private struct InputUnion
    {
        [FieldOffset(0)]
        public MOUSEINPUT mi;

        [FieldOffset(0)]
        public KEYBDINPUT ki;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct KEYBDINPUT
    {
        public ushort wVk;
        public ushort wScan;
        public uint dwFlags;
        public uint time;
        public IntPtr dwExtraInfo;
    }

    /// <summary>
    /// Never populated. It exists only so <see cref="InputUnion"/> is the size the
    /// OS expects — MOUSEINPUT is the largest member, and a union sized to
    /// KEYBDINPUT alone makes SendInput reject every call with ERROR_INVALID_PARAMETER.
    /// </summary>
    [StructLayout(LayoutKind.Sequential)]
    private struct MOUSEINPUT
    {
        public int dx;
        public int dy;
        public uint mouseData;
        public uint dwFlags;
        public uint time;
        public IntPtr dwExtraInfo;
    }

#pragma warning restore CS0649
}
