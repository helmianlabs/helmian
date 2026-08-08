using System.Diagnostics;
using System.Media;
using System.Runtime.InteropServices;

namespace Helmion.VoiceDictation;

/// <summary>
/// The whole application: a window that is never shown, whose only job is to own
/// a handle that <c>RegisterHotKey</c> can post <c>WM_HOTKEY</c> to.
/// </summary>
/// <remarks>
/// <para>RegisterHotKey needs a window handle and a running message pump; it has
/// no console-friendly form. A Form that overrides <see cref="SetVisibleCore"/>
/// to force its handle into existence while refusing to become visible gives both
/// with no window on screen and no taskbar entry.</para>
///
/// <para><b>Toggle, not push-to-talk, and that is a considered choice.</b>
/// WM_HOTKEY fires on key DOWN only — the API delivers no key-up event, so a real
/// hold-to-talk would need a WH_KEYBOARD_LL global hook. That hook sits in the
/// path of every keystroke on the machine, and if this process ever stalled while
/// holding it, Troy's typing would stall with it. Requirement 4 says never block
/// his keyboard, so the hook was rejected and the hotkey toggles instead.</para>
/// </remarks>
[System.Runtime.Versioning.SupportedOSPlatform("windows")]
public sealed class DictationHost : Form
{
    private const int WmHotkey = 0x0312;
    private const int DictateHotkeyId = 0xA71;
    private const int CancelHotkeyId = 0xA72;
    private const int ConversationHotkeyId = 0xA73;

    private readonly DictationConfig _config;
    private readonly HotkeySpec _dictateHotkey;
    private readonly HotkeySpec? _cancelHotkey;
    private readonly HotkeySpec? _conversationHotkey;
    private readonly string _voiceStateFile;
    private readonly MicRecorder _recorder = new();
    private readonly VocabularyTranscriber _transcriber;
    private readonly System.Windows.Forms.Timer _capTimer = new();
    private readonly System.Windows.Forms.Timer _silenceTimer = new();

    private TrayIndicator? _tray;
    private DictationButtonOverlay? _button;
    private bool _busy;

    // "send it" checkpoint state — see OnSilencePoll/HandleSendItCheck.
    private int _lastSubmitSampleIndex;
    private bool _checkingSendIt;
    private bool _checkedThisPause;
    private double _prevSilenceMs;

    public DictationHost(
        DictationConfig config,
        HotkeySpec dictateHotkey,
        HotkeySpec? cancelHotkey,
        HotkeySpec? conversationHotkey,
        VocabularyTranscriber transcriber)
    {
        _config = config;
        _dictateHotkey = dictateHotkey;
        _cancelHotkey = cancelHotkey;
        _conversationHotkey = conversationHotkey;
        _voiceStateFile = ConversationMode.ResolveStateFile(config.VoiceStateFile);
        _transcriber = transcriber;

        FormBorderStyle = FormBorderStyle.None;
        ShowInTaskbar = false;
        WindowState = FormWindowState.Minimized;
        Opacity = 0d;
        Text = "Helmion Voice Dictation";

        _recorder.Faulted += OnRecorderFaulted;

        _capTimer.Interval = Math.Max(1, _config.MaxRecordingSeconds) * 1000;
        _capTimer.Tick += OnRecordingCapReached;

        // Polls rather than a callback from MicRecorder itself: the recorder's
        // audio-thread lock is held for microseconds at a time and has no
        // business also deciding UI-facing policy. Runs the whole time the mic
        // is open, checking for a spoken "send it" after every pause — it never
        // stops the recording, only the hotkey does that.
        _silenceTimer.Interval = 150;
        _silenceTimer.Tick += OnSilencePoll;
    }

    /// <summary>
    /// Never visible, but the handle must exist before RegisterHotKey can target
    /// it. Application.Run sets Visible = true, which lands here.
    /// </summary>
    protected override void SetVisibleCore(bool value)
    {
        if (!IsHandleCreated)
        {
            CreateHandle();
        }

        base.SetVisibleCore(false);
    }

    protected override void OnHandleCreated(EventArgs e)
    {
        base.OnHandleCreated(e);

        _tray = new TrayIndicator(
            _config.ShowTrayIcon,
            _dictateHotkey.Text,
            _conversationHotkey?.Text ?? "voice.ps1 -Conversation",
            onQuit: () => Close(),
            onOpenLog: OpenLog);

        // TROY-APPROVED 2026-08-08 — a second, more visible way to see the same
        // state and trigger the same toggle as the hotkey. Click behaves
        // identically to pressing _dictateHotkey; both call ToggleDictation().
        if (_config.ShowFloatingButton)
        {
            _button = new DictationButtonOverlay(ToggleDictation);
            _button.Show();
        }

        RegisterHotkeys();

        // Conversation mode survives a restart, because the switch is a file. Show
        // the state that is really on disk rather than assuming off, and make sure
        // the speaker is up if it says on — otherwise replies would queue silently.
        var conversationOn = ConversationMode.IsOn(_voiceStateFile);
        _tray?.SetConversation(conversationOn);

        if (conversationOn)
        {
            DictationLog.Info($"Conversation mode was already ON at startup ({_voiceStateFile}).");
            ConversationMode.EnsureSpeakerRunning(_config.SpeakExePath);
        }

        // The 141 MB model takes a couple of seconds to load. Doing it now means
        // the first dictation is not the slow one.
        Task.Run(() =>
        {
            if (_transcriber.Warmup())
            {
                DictationLog.Info($"Whisper model ready: {_transcriber.ModelPath}");
            }
            else
            {
                DictationLog.Error("Whisper model did not load; dictation will produce no text.");
                BeginInvoke(() => SetState(DictationState.Error, "Whisper model failed to load"));
            }
        });
    }

    protected override void WndProc(ref Message m)
    {
        if (m.Msg == WmHotkey)
        {
            var id = m.WParam.ToInt32();
            if (id == DictateHotkeyId)
            {
                ToggleDictation();
                return;
            }

            if (id == CancelHotkeyId)
            {
                CancelDictation();
                return;
            }

            if (id == ConversationHotkeyId)
            {
                ToggleConversation();
                return;
            }
        }

        base.WndProc(ref m);
    }

    protected override void OnFormClosing(FormClosingEventArgs e)
    {
        base.OnFormClosing(e);

        UnregisterHotKey(Handle, DictateHotkeyId);
        UnregisterHotKey(Handle, CancelHotkeyId);
        UnregisterHotKey(Handle, ConversationHotkeyId);

        _capTimer.Stop();
        _silenceTimer.Stop();
        _recorder.Dispose();
        _transcriber.Dispose();
        _tray?.Dispose();
        _button?.Close();
        _button?.Dispose();

        DictationLog.Info("Dictation stopped.");
    }

    /// <summary>
    /// The one place that updates BOTH the tray dot and the floating button, so
    /// they can never drift out of sync with each other.
    /// </summary>
    private void SetState(DictationState state, string? detail = null)
    {
        _tray?.Show(state, detail);
        _button?.Show(state);
    }

    private void RegisterHotkeys()
    {
        if (RegisterHotKey(Handle, DictateHotkeyId, _dictateHotkey.Modifiers, _dictateHotkey.VirtualKey))
        {
            DictationLog.Info(
                $"Hotkey registered: {_dictateHotkey.Text} — pure on/off for the mic. "
                + "Say \"send it\" any time while it's open to submit without closing it.");
        }
        else
        {
            // ERROR_HOTKEY_ALREADY_REGISTERED is 1409 and means another app owns
            // the combination. Keep running so the tray icon can say so, rather
            // than vanishing without explanation.
            DictationLog.Error(
                $"Could not register {_dictateHotkey.Text} — Win32 error {Marshal.GetLastWin32Error()} "
                + "(1409 means another application already owns that combination). "
                + "Edit \"hotkey\" in voice-dictation.config.json and restart.");
            SetState(DictationState.Error, $"{_dictateHotkey.Text} is taken by another app");
        }

        if (_cancelHotkey is { } cancel
            && !RegisterHotKey(Handle, CancelHotkeyId, cancel.Modifiers, cancel.VirtualKey))
        {
            DictationLog.Warn(
                $"Could not register the cancel hotkey {cancel.Text} — Win32 error {Marshal.GetLastWin32Error()}. "
                + "Dictation still works; there is just no discard shortcut.");
        }
        else if (_cancelHotkey is { } registered)
        {
            DictationLog.Info($"Cancel hotkey registered: {registered.Text} (throws the recording away).");
        }

        if (_conversationHotkey is { } conversation)
        {
            if (RegisterHotKey(Handle, ConversationHotkeyId, conversation.Modifiers, conversation.VirtualKey))
            {
                // A clean registration IS the collision proof. RegisterHotKey is
                // exclusive machine-wide and returns ERROR_HOTKEY_ALREADY_REGISTERED
                // (1409) to the second caller, so nothing else on this machine owns
                // this combination at the moment this line was written.
                DictationLog.Info(
                    $"Conversation hotkey registered: {conversation.Text} "
                    + "(toggles spoken replies on and off).");
            }
            else
            {
                DictationLog.Warn(
                    $"Could not register the conversation hotkey {conversation.Text} — Win32 error "
                    + $"{Marshal.GetLastWin32Error()} (1409 means another application owns it). "
                    + "Dictation still works; toggle with voice.ps1 -Conversation instead.");
            }
        }
    }

    private void ToggleDictation()
    {
        if (_busy)
        {
            DictationLog.Warn("Hotkey ignored — still transcribing the previous recording.");
            // TROY-APPROVED 2026-08-08 — this used to be completely silent (only a
            // log line and the tray dot's colour), which is exactly why Troy
            // couldn't tell whether a press had registered while a slow
            // transcription (small.en model, up to ~80s for a full 300s
            // recording) was still running. SystemSounds.Play() is fire-and
            // -forget/non-blocking, so it doesn't violate this app's "never
            // block the hotkey thread" requirement — it just gives an audible
            // "that didn't count, try again in a moment" instead of silence.
            SystemSounds.Asterisk.Play();
            return;
        }

        if (_recorder.IsRecording)
        {
            // TROY-APPROVED 2026-08-08 — the stop press had no audible confirmation
            // at all, so a missed/late press was indistinguishable from "still
            // recording, I just haven't said anything." A distinct tone here (not
            // the same one as the busy-ignored beep above) means every successful
            // stop is heard the instant it registers, not inferred later from how
            // long the mic seemed to stay open.
            SystemSounds.Question.Play();
            StopAndTranscribe();
            return;
        }

        if (_transcriber.LoadFailed)
        {
            DictationLog.Error("Refusing to record: the Whisper model is not loaded.");
            SetState(DictationState.Error, "Whisper model failed to load");
            return;
        }

        if (_recorder.Start())
        {
            _lastSubmitSampleIndex = 0;
            _checkedThisPause = false;
            _prevSilenceMs = 0;

            _capTimer.Start();
            _silenceTimer.Start();

            SetState(DictationState.Recording);
            DictationLog.Info("Recording started — mic stays open until the hotkey is pressed again.");
            // Same reasoning as the stop tone above: a third distinct sound so
            // "started" is never confused with "stopped" or "ignored, still busy."
            SystemSounds.Beep.Play();
        }
        else
        {
            SetState(DictationState.Error, "Microphone unavailable");
        }
    }

    private void CancelDictation()
    {
        if (!_recorder.IsRecording)
        {
            return;
        }

        _capTimer.Stop();
        _silenceTimer.Stop();
        _recorder.Cancel();
        SetState(DictationState.Idle);
        DictationLog.Info("Recording discarded by the cancel hotkey.");
    }

    /// <summary>
    /// Turn spoken replies on or off. This is the whole hands-free loop's switch.
    /// </summary>
    /// <remarks>
    /// <para>Turning ON writes "local" to the file the Claude Code Stop hook reads
    /// (stop_hook_speak.py:139-144), starts the Kokoro watcher if it is not up, and
    /// says two words so Troy knows it took — a hotkey with no window has no other
    /// way to answer him.</para>
    ///
    /// <para>Turning OFF does the reverse AND silences whatever is speaking right
    /// now, because the realistic reason to reach for this key is that he wants the
    /// talking to stop this second, not after the current paragraph. It is
    /// deliberately silent on the way out: confirming "voice off" out loud would be
    /// one more sentence he did not ask for.</para>
    /// </remarks>
    private void ToggleConversation()
    {
        var nowOn = ConversationMode.Toggle(_voiceStateFile, out var problem);

        if (problem is not null)
        {
            DictationLog.Error(problem);
            SetState(DictationState.Error, "Could not switch conversation mode");
            return;
        }

        if (nowOn)
        {
            ConversationMode.EnsureSpeakerRunning(_config.SpeakExePath);
            // His name, not a status line. See ConversationMode.AttentionUtterance.
            ConversationMode.Announce(ConversationMode.AttentionUtterance);
            DictationLog.Info($"Conversation mode ON — replies will be spoken. ({_voiceStateFile} = local)");
        }
        else
        {
            ConversationMode.SilenceNow();
            DictationLog.Info($"Conversation mode OFF — audio cut and queue cleared. ({_voiceStateFile} = off)");
        }

        _tray?.SetConversation(nowOn);
    }

    private void OnRecordingCapReached(object? sender, EventArgs e)
    {
        if (!_recorder.IsRecording)
        {
            _capTimer.Stop();
            return;
        }

        DictationLog.Warn(
            $"Recording hit the {_config.MaxRecordingSeconds}s safety cap; transcribing what there is.");
        StopAndTranscribe();
    }

    /// <summary>
    /// Polled the entire time the mic is open. NEVER stops the recording —
    /// that is the hotkey's job alone. All this does is notice a pause, peek at
    /// the audio since the last submit, and see whether Troy just said "send
    /// it". Fires at most once per distinct pause (<see cref="_checkedThisPause"/>
    /// resets the moment new speech is heard), so a long silence does not spam
    /// Whisper every 150 ms.
    /// </summary>
    private void OnSilencePoll(object? sender, EventArgs e)
    {
        if (!_recorder.IsRecording)
        {
            _silenceTimer.Stop();
            return;
        }

        var silentFor = _recorder.SilenceElapsedMs;
        if (silentFor is null)
        {
            // No speech heard yet at all this recording — nothing to check.
            _prevSilenceMs = 0;
            _checkedThisPause = false;
            return;
        }

        if (silentFor.Value < _prevSilenceMs)
        {
            // Silence clock reset under us, meaning he started talking again.
            _checkedThisPause = false;
        }

        _prevSilenceMs = silentFor.Value;

        if (_checkedThisPause || _checkingSendIt || silentFor.Value < _config.SendItCheckSilenceMs)
        {
            return;
        }

        var currentCount = _recorder.SampleCount;
        var newSeconds = (currentCount - _lastSubmitSampleIndex) / (double)MicRecorder.SampleRate;
        if (newSeconds < 0.4d)
        {
            // Nothing meaningfully new since the last submit — nothing to check.
            return;
        }

        _checkedThisPause = true;
        _checkingSendIt = true;
        var segment = _recorder.SamplesSince(_lastSubmitSampleIndex);

        Task.Run(() =>
        {
            var text = _transcriber.Transcribe(segment);
            BeginInvoke(() => HandleSendItCheck(text, currentCount));
        });
    }

    /// <summary>
    /// Result of a mid-recording checkpoint. TROY-APPROVED 2026-08-08 (final
    /// correction) — this injects on EVERY pause, not only when "send it" is
    /// heard. The mic opening is supposed to put words on the screen as he
    /// talks; "send it" only additionally presses Enter. The mic is never
    /// stopped for any of this — only the hotkey does that.
    /// </summary>
    private void HandleSendItCheck(string text, int checkpointSampleCount)
    {
        _checkingSendIt = false;
        _lastSubmitSampleIndex = checkpointSampleCount;

        if (!_recorder.IsRecording)
        {
            // Hotkey closed the mic while this check was still decoding;
            // StopAndTranscribe already owns flushing whatever is left.
            return;
        }

        if (string.IsNullOrWhiteSpace(text))
        {
            return;
        }

        var forceSubmit = TextInjector.TryStripTrailingSendIt(text, out var toInject);
        DictationLog.Info(
            $"Live chunk ({(forceSubmit ? "ends in \"send it\"" : "mid-dictation")}): {text}");

        if (forceSubmit)
        {
            SystemSounds.Question.Play();
        }

        TextInjector.Inject(toInject, _config, forceSubmit);
    }

    private void StopAndTranscribe()
    {
        _capTimer.Stop();
        _silenceTimer.Stop();

        var all = _recorder.Stop();
        // Only what has not already gone out via a mid-recording "send it" —
        // that audio was submitted the moment it was heard, not held for here.
        var pendingStart = Math.Min(_lastSubmitSampleIndex, all.Length);
        var samples = all[pendingStart..];
        var seconds = samples.Length / (double)MicRecorder.SampleRate;

        if (samples.Length == 0 || seconds < 0.25d)
        {
            DictationLog.Info("Mic closed — nothing pending beyond what was already submitted.");
            SetState(DictationState.Idle);
            return;
        }

        _busy = true;
        SetState(DictationState.Transcribing);
        DictationLog.Info($"Mic closed: {seconds:F2}s pending. Transcribing…");

        // Off the UI thread: a decode takes seconds and would freeze the message
        // pump, which is the thread the hotkey itself is delivered on.
        Task.Run(() =>
        {
            var started = Stopwatch.StartNew();
            var text = _transcriber.Transcribe(samples);
            started.Stop();

            // Back to the UI thread. The clipboard requires STA, and this form's
            // thread is the only STA thread in the process.
            BeginInvoke(() => FinishDictation(text, seconds, started.Elapsed.TotalSeconds));
        });
    }

    private void FinishDictation(string text, double audioSeconds, double decodeSeconds)
    {
        try
        {
            if (string.IsNullOrWhiteSpace(text))
            {
                DictationLog.Warn(
                    $"Transcript was empty after {decodeSeconds:F2}s of decoding on {audioSeconds:F2}s of audio.");
                SetState(DictationState.Idle);
                return;
            }

            DictationLog.Info(
                $"Transcript ({decodeSeconds:F2}s decode, {audioSeconds:F2}s audio): {text}");

            // TROY-APPROVED 2026-08-08 — TextInjector.TryStripTrailingSendIt and
            // Inject's forceSubmit parameter were both already fully built and
            // documented, but nothing ever called them: FinishDictation always
            // passed the raw transcript straight through with no submit. Ending a
            // dictation with "send it" now strips that phrase and presses Enter
            // right after the paste, same as if Troy had pressed Enter himself.
            var forceSubmit = TextInjector.TryStripTrailingSendIt(text, out var toInject);
            TextInjector.Inject(toInject, _config, forceSubmit);
            SetState(DictationState.Idle);
        }
        catch (Exception ex)
        {
            // Nothing in a dictation is worth taking the process down for.
            DictationLog.Error("Finishing the dictation failed", ex);
            SetState(DictationState.Error, "Injection failed — see the log");
        }
        finally
        {
            _busy = false;
        }
    }

    private void OnRecorderFaulted(object? sender, string message)
    {
        DictationLog.Error(message);

        if (IsHandleCreated)
        {
            BeginInvoke(() => SetState(DictationState.Error, "Microphone problem"));
        }
    }

    private static void OpenLog()
    {
        try
        {
            var path = DictationLog.Path_;
            if (!File.Exists(path))
            {
                File.WriteAllText(path, string.Empty);
            }

            // UseShellExecute so this opens in his editor, not as a child console.
            Process.Start(new ProcessStartInfo(path) { UseShellExecute = true });
        }
        catch (Exception ex)
        {
            DictationLog.Warn($"Could not open the log: {ex.Message}");
        }
    }

    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool RegisterHotKey(IntPtr hwnd, int id, uint modifiers, uint virtualKey);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool UnregisterHotKey(IntPtr hwnd, int id);
}
