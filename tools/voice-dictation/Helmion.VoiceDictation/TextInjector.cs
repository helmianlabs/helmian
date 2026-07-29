using System.Runtime.InteropServices;
using System.Text;

namespace Helmion.VoiceDictation;

/// <summary>
/// Gets transcribed text into whatever window currently has focus.
/// </summary>
/// <remarks>
/// <para><b>Why clipboard + Ctrl+V is the default.</b> Verified against Troy's own
/// machine rather than assumed: his Windows Terminal settings.json binds
/// <c>ctrl+v</c> to <c>Terminal.PasteFromClipboard</c> (lines 9-10 of
/// %LOCALAPPDATA%\Packages\Microsoft.WindowsTerminal_8wekyb3d8bbwe\LocalState\settings.json),
/// and <c>WT_SESSION</c> is set inside the shell Claude Code runs in, so the
/// terminal receiving the text is that Windows Terminal. One keystroke moves any
/// length of text atomically.</para>
///
/// <para><b>Why synthetic typing is kept as a mode, not discarded.</b> Paste
/// depends on the target having a paste binding at all. A raw conhost window, an
/// RDP session or an app that swallows Ctrl+V has none, and there the clipboard
/// route silently does nothing. <c>KEYEVENTF_UNICODE</c> input does not go through
/// any keybinding — the target receives WM_CHAR as though the characters were
/// typed — so it works where paste does not. It is slower and it clobbers nothing.</para>
///
/// <para><b>What was rejected.</b> UI Automation TextPattern: a terminal exposes
/// its screen buffer as a read-only text pattern, so there is nothing to set.
/// WM_CHAR posted directly to the target HWND: ConPTY-hosted terminals read input
/// from the pseudoconsole rather than from a plain window queue, and a posted
/// WM_CHAR is dropped by some hosts; SendInput goes through the same path a real
/// keyboard does, which is why it survives ConPTY.</para>
/// </remarks>
[System.Runtime.Versioning.SupportedOSPlatform("windows")]
public static class TextInjector
{
    private const uint InputKeyboard = 1;
    private const uint KeyEventKeyUp = 0x0002;
    private const uint KeyEventUnicode = 0x0004;

    private const ushort VkControl = 0x11;
    private const ushort VkShift = 0x10;
    private const ushort VkMenu = 0x12;      // Alt
    private const ushort VkLWin = 0x5B;
    private const ushort VkRWin = 0x5C;
    private const ushort VkV = 0x56;
    private const ushort VkReturn = 0x0D;

    private static readonly ushort[] ModifierKeys =
        { VkControl, VkShift, VkMenu, VkLWin, VkRWin };

    /// <summary>
    /// Send <paramref name="text"/> to the foreground window. Returns false and
    /// logs on failure; it never throws and never shows a dialog.
    /// </summary>
    public static bool Inject(string text, DictationConfig config)
    {
        if (string.IsNullOrEmpty(text))
        {
            return false;
        }

        // A newline in dictated text would submit the prompt in Claude Code
        // before Troy could read what was heard. Whisper does not normally emit
        // one, but a mis-decode must not be able to press Enter for him.
        var payload = text
            .Replace("\r\n", " ", StringComparison.Ordinal)
            .Replace('\r', ' ')
            .Replace('\n', ' ')
            .Trim();

        if (payload.Length == 0)
        {
            return false;
        }

        if (config.AppendTrailingSpace)
        {
            payload += " ";
        }

        // The hotkey that triggered this is Ctrl+Alt+something. If Troy is still
        // leaning on those keys, a "Ctrl+V" arrives at the target as Ctrl+Alt+V —
        // not a paste — and unicode characters arrive as control codes. Clearing
        // the physical modifier state first is what makes injection reliable
        // rather than intermittent.
        WaitForModifiersReleased();

        var target = DescribeForegroundWindow();
        var ok = config.UsesPasteInjection
            ? InjectByPaste(payload, config)
            : InjectByTyping(payload);

        if (ok && config.AutoSubmit)
        {
            TapKey(VkReturn);
        }

        DictationLog.Info(
            $"Injected {payload.Length} chars via {(config.UsesPasteInjection ? "paste" : "typing")} "
            + $"into {target} — {(ok ? "ok" : "FAILED")}");

        return ok;
    }

    /// <summary>Clipboard route: set text, tap Ctrl+V, put the old clipboard back.</summary>
    private static bool InjectByPaste(string payload, DictationConfig config)
    {
        string? previous = null;
        var hadRestorableClipboard = false;

        try
        {
            if (config.RestoreClipboard && Clipboard.ContainsText())
            {
                previous = Clipboard.GetText();
                hadRestorableClipboard = true;
            }
            else if (config.RestoreClipboard && Clipboard.ContainsData(DataFormats.Bitmap))
            {
                // Honest limitation: an image on the clipboard is not restored.
                // Round-tripping arbitrary clipboard formats is unreliable, and a
                // corrupted restore is worse than a documented one.
                DictationLog.Warn(
                    "Clipboard held an image; it will be replaced by the dictated text and not restored.");
            }
        }
        catch (Exception ex)
        {
            DictationLog.Warn($"Could not read the existing clipboard: {ex.Message}");
        }

        try
        {
            // Retries because the clipboard is a machine-wide lock any process can
            // be holding for a few milliseconds.
            Clipboard.SetDataObject(payload, copy: true, retryTimes: 10, retryDelay: 25);
        }
        catch (Exception ex)
        {
            DictationLog.Error("Could not put the transcript on the clipboard", ex);
            return false;
        }

        SendCtrlV();

        if (!hadRestorableClipboard || previous is null)
        {
            return true;
        }

        // The paste is asynchronous from this process's point of view: the target
        // reads the clipboard on ITS message loop when it handles the keystroke,
        // and nothing signals when that read is done. Restoring too early makes
        // the target paste the OLD contents — a silent wrong-text bug. This
        // measured 120 ms as too short; see DictationConfig.ClipboardRestoreDelayMs.
        Thread.Sleep(Math.Max(50, config.ClipboardRestoreDelayMs));

        try
        {
            // Only put the old contents back if OUR payload is still sitting
            // there. If anything else has written to the clipboard in the
            // meantime, that is the user's data and it stays.
            if (!Clipboard.ContainsText()
                || !string.Equals(Clipboard.GetText(), payload, StringComparison.Ordinal))
            {
                DictationLog.Info("Clipboard changed after the paste; leaving it as it is.");
                return true;
            }

            Clipboard.SetDataObject(previous, copy: true, retryTimes: 10, retryDelay: 25);
        }
        catch (Exception ex)
        {
            DictationLog.Warn($"Could not restore the previous clipboard: {ex.Message}");
        }

        return true;
    }

    /// <summary>
    /// Typing route: one keydown/keyup pair per character with KEYEVENTF_UNICODE.
    /// No virtual-key code and no keyboard layout is involved, so this types the
    /// same characters on any layout.
    /// </summary>
    private static bool InjectByTyping(string payload)
    {
        // Sent in chunks rather than one giant array: a very long dictation would
        // otherwise hand the target thousands of input events in a single burst,
        // and ConPTY-backed terminals drop input when their queue overruns.
        const int chunkSize = 200;

        for (var offset = 0; offset < payload.Length; offset += chunkSize)
        {
            var slice = payload.AsSpan(offset, Math.Min(chunkSize, payload.Length - offset));
            var inputs = new List<INPUT>(slice.Length * 2);

            foreach (var ch in slice)
            {
                inputs.Add(UnicodeInput(ch, keyUp: false));
                inputs.Add(UnicodeInput(ch, keyUp: true));
            }

            if (!Send(inputs.ToArray()))
            {
                return false;
            }

            Thread.Sleep(5);
        }

        return true;
    }

    private static void SendCtrlV()
    {
        Send(new[]
        {
            KeyInput(VkControl, keyUp: false),
            KeyInput(VkV, keyUp: false),
            KeyInput(VkV, keyUp: true),
            KeyInput(VkControl, keyUp: true),
        });
    }

    private static void TapKey(ushort virtualKey)
    {
        Send(new[]
        {
            KeyInput(virtualKey, keyUp: false),
            KeyInput(virtualKey, keyUp: true),
        });
    }

    /// <summary>
    /// Wait briefly for Troy to let go of the hotkey modifiers, then force-release
    /// anything still held so the injected keystrokes are read cleanly.
    /// </summary>
    private static void WaitForModifiersReleased()
    {
        const int maxWaitMs = 600;
        var waited = 0;

        while (waited < maxWaitMs && AnyModifierDown())
        {
            Thread.Sleep(20);
            waited += 20;
        }

        if (!AnyModifierDown())
        {
            return;
        }

        // Still down after the grace period — he is holding the key. Send keyups
        // so this process's view of the modifier state is clean. This does not
        // fight his physical key: the moment he releases it, Windows sends its own
        // keyup and everything is consistent again.
        var releases = ModifierKeys
            .Where(IsDown)
            .Select(key => KeyInput(key, keyUp: true))
            .ToArray();

        if (releases.Length > 0)
        {
            DictationLog.Warn(
                $"Hotkey modifiers were still held after {maxWaitMs} ms; releasing {releases.Length} synthetically.");
            Send(releases);
            Thread.Sleep(30);
        }
    }

    private static bool AnyModifierDown() => ModifierKeys.Any(IsDown);

    private static bool IsDown(ushort virtualKey) => (GetAsyncKeyState(virtualKey) & 0x8000) != 0;

    private static INPUT KeyInput(ushort virtualKey, bool keyUp) => new()
    {
        Type = InputKeyboard,
        Data = new InputUnion
        {
            Keyboard = new KEYBDINPUT
            {
                VirtualKey = virtualKey,
                Scan = 0,
                Flags = keyUp ? KeyEventKeyUp : 0,
                Time = 0,
                ExtraInfo = IntPtr.Zero,
            },
        },
    };

    private static INPUT UnicodeInput(char ch, bool keyUp) => new()
    {
        Type = InputKeyboard,
        Data = new InputUnion
        {
            Keyboard = new KEYBDINPUT
            {
                VirtualKey = 0,
                Scan = ch,
                Flags = KeyEventUnicode | (keyUp ? KeyEventKeyUp : 0),
                Time = 0,
                ExtraInfo = IntPtr.Zero,
            },
        },
    };

    private static bool Send(INPUT[] inputs)
    {
        if (inputs.Length == 0)
        {
            return true;
        }

        var sent = SendInput((uint)inputs.Length, inputs, Marshal.SizeOf<INPUT>());
        if (sent == inputs.Length)
        {
            return true;
        }

        // The usual cause is UIPI: this process runs asInvoker, so it cannot
        // inject into a window running at a higher integrity level.
        DictationLog.Error(
            $"SendInput accepted {sent} of {inputs.Length} events "
            + $"(Win32 error {Marshal.GetLastWin32Error()}). "
            + "If the focused window is running as administrator, injection is blocked by design.");
        return false;
    }

    /// <summary>Foreground window title and class, for the log. Never throws.</summary>
    private static string DescribeForegroundWindow()
    {
        try
        {
            var hwnd = GetForegroundWindow();
            if (hwnd == IntPtr.Zero)
            {
                return "<no foreground window>";
            }

            var title = new StringBuilder(256);
            _ = GetWindowText(hwnd, title, title.Capacity);

            var className = new StringBuilder(256);
            _ = GetClassName(hwnd, className, className.Capacity);

            return $"\"{title}\" [{className}]";
        }
        catch
        {
            return "<unknown window>";
        }
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct INPUT
    {
        public uint Type;
        public InputUnion Data;
    }

    [StructLayout(LayoutKind.Explicit)]
    private struct InputUnion
    {
        [FieldOffset(0)]
        public MOUSEINPUT Mouse;

        [FieldOffset(0)]
        public KEYBDINPUT Keyboard;

        [FieldOffset(0)]
        public HARDWAREINPUT Hardware;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct KEYBDINPUT
    {
        public ushort VirtualKey;
        public ushort Scan;
        public uint Flags;
        public uint Time;
        public IntPtr ExtraInfo;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct MOUSEINPUT
    {
        public int X;
        public int Y;
        public uint MouseData;
        public uint Flags;
        public uint Time;
        public IntPtr ExtraInfo;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct HARDWAREINPUT
    {
        public uint Msg;
        public ushort ParamL;
        public ushort ParamH;
    }

    [DllImport("user32.dll", SetLastError = true)]
    private static extern uint SendInput(uint count, INPUT[] inputs, int size);

    [DllImport("user32.dll")]
    private static extern short GetAsyncKeyState(int virtualKey);

    [DllImport("user32.dll")]
    private static extern IntPtr GetForegroundWindow();

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int GetWindowText(IntPtr hwnd, StringBuilder text, int count);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int GetClassName(IntPtr hwnd, StringBuilder text, int count);
}
