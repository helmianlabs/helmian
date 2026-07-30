using System.Runtime.InteropServices;
using Helmion.Desktop.Core;

namespace Helmion.Voice.Host;

/// <summary>
/// Listens for one system-wide hotkey and raises a callback when it is pressed.
/// </summary>
/// <remarks>
/// RegisterHotKey is called with a NULL window handle, which posts WM_HOTKEY to
/// the calling THREAD's message queue rather than to a window. That is the whole
/// reason this host can be windowless: a hidden window is the usual way to
/// receive WM_HOTKEY, and a hidden window is still a window.
///
/// The wait is MsgWaitForMultipleObjects rather than GetMessage so the same
/// thread can be woken either by the hotkey or by the stop event. GetMessage
/// would block on the message queue alone and only notice the stop request after
/// the next unrelated message — which, for a thread with no window, might be
/// never.
///
/// Registration is exclusive machine-wide. While this is running, the chosen
/// combination is taken away from every other application, so the chord must be
/// one nothing else wants. See docs/POWERSHELL_VOICE.md for how the default was
/// chosen and what was rejected.
/// </remarks>
internal sealed class GlobalHotkeyListener : IDisposable
{
    private const uint WmHotkey = 0x0312;
    private const uint WmQuit = 0x0012;
    private const uint PmRemove = 0x0001;
    private const uint QsAllInput = 0x04FF;
    private const uint Infinite = 0xFFFFFFFF;
    private const uint WaitObject0 = 0;
    private const uint WaitFailed = 0xFFFFFFFF;

    private const int ErrorHotkeyAlreadyRegistered = 1409;

    private const int HotkeyId = 0x48454C4D & 0xBFFF;   // 'HELM', masked into the app range

    private readonly HotkeyChord _chord;
    private bool _registered;

    public GlobalHotkeyListener(HotkeyChord chord)
    {
        _chord = chord;
    }

    /// <summary>
    /// Claim the chord. Returns false with a human-readable reason instead of
    /// throwing — "another app already owns this key" is a configuration problem
    /// the user has to solve, not a crash.
    /// </summary>
    public bool TryRegister(out string? error)
    {
        error = null;

        if (RegisterHotKey(IntPtr.Zero, HotkeyId, _chord.ModifiersForRegistration, _chord.VirtualKey))
        {
            _registered = true;
            return true;
        }

        var code = Marshal.GetLastWin32Error();
        error = code == ErrorHotkeyAlreadyRegistered
            ? $"{_chord.Display} is already registered by another application. "
              + "Pick a different chord with -Chord."
            : $"Could not register {_chord.Display} (Win32 error {code}).";
        return false;
    }

    /// <summary>
    /// Block until <paramref name="stopHandle"/> is signalled, running
    /// <paramref name="onPressed"/> on this thread for every hotkey press.
    /// </summary>
    public void Run(WaitHandle stopHandle, Action onPressed)
    {
        var handles = new[] { stopHandle.SafeWaitHandle.DangerousGetHandle() };

        while (true)
        {
            var wait = MsgWaitForMultipleObjects(1, handles, false, Infinite, QsAllInput);

            if (wait == WaitObject0 || wait == WaitFailed)
            {
                return;
            }

            while (PeekMessage(out var message, IntPtr.Zero, 0, 0, PmRemove))
            {
                if (message.message == WmQuit)
                {
                    return;
                }

                if (message.message == WmHotkey && message.wParam.ToInt64() == HotkeyId)
                {
                    onPressed();
                }
            }
        }
    }

    public void Dispose()
    {
        if (_registered)
        {
            UnregisterHotKey(IntPtr.Zero, HotkeyId);
            _registered = false;
        }
    }

    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool RegisterHotKey(IntPtr hWnd, int id, uint fsModifiers, uint vk);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool UnregisterHotKey(IntPtr hWnd, int id);

    [DllImport("user32.dll")]
    private static extern bool PeekMessage(out MSG lpMsg, IntPtr hWnd, uint filterMin, uint filterMax, uint remove);

    [DllImport("user32.dll")]
    private static extern uint MsgWaitForMultipleObjects(
        uint count,
        IntPtr[] handles,
        bool waitAll,
        uint milliseconds,
        uint wakeMask);

#pragma warning disable CS0649

    [StructLayout(LayoutKind.Sequential)]
    private struct MSG
    {
        public IntPtr hwnd;
        public uint message;
        public IntPtr wParam;
        public IntPtr lParam;
        public uint time;
        public int ptX;
        public int ptY;
    }

#pragma warning restore CS0649
}
