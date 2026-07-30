namespace Helmion.Voice.Host;

/// <summary>
/// The machine-wide "the speakers are busy" flag, and the text currently coming
/// out of them.
/// </summary>
/// <remarks>
/// THIS EXISTS BECAUSE THE ECHO IS A CROSS-PROCESS PROBLEM, and that is not
/// obvious from either side on its own.
///
/// When Troy dictates, one process is running `type` (or `hotkey`, or now
/// `converse`) and holds the microphone. When an assistant speaks a reply, a
/// SECOND, SEPARATE process runs `speak` — Invoke-HelmionSpeak shells out to the
/// executable per utterance (Helmion.Voice.psm1:152), and `speak` deliberately
/// does not take the single-instance guard (Program.cs), because if it did it
/// could never run while dictation was live.
///
/// So the dictating process has no in-process way to know that audio is playing.
/// It keeps capturing, the microphone hears the speakers, and Whisper transcribes
/// the assistant's own sentence back into the box — which is exactly what
/// happened to Troy on 2026-07-30, verbatim, in the middle of a conversation.
/// Pausing the recognizer "while we speak" is a no-op when the speaking happens
/// somewhere else entirely.
///
/// A named event fixes it because a kernel object is the one thing both processes
/// can see. `speak` raises it before the first sample and drops it after the last;
/// `converse` watches it and keeps capture closed the whole time.
///
/// Local\ rather than Global\ so this needs no elevation and cannot collide with
/// another user's session, matching VoiceHostSignals.
/// </remarks>
internal static class SpeechFloor
{
    /// <summary>Set for as long as some helmion-voice process owns the speakers.</summary>
    public const string EventName = @"Local\Helmion.Voice.Host.Speaking";

    /// <summary>
    /// What is being spoken, written beside the flag so a listening host can arm
    /// the near-match echo guard against the actual words.
    /// </summary>
    /// <remarks>
    /// A file rather than shared memory because it is written once per utterance
    /// and read once per utterance, and because a stale file is harmless: the
    /// guard only consults it inside a few seconds of the flag dropping
    /// (ConversationTurnPolicy.EchoTextWindowMs), and only to DISCARD input.
    /// Failing to read it costs the second guard, never the first.
    /// </remarks>
    public static string SpokenTextPath => Path.Combine(
        Path.GetTempPath(),
        "helmion-voice-spoken.txt");

    /// <summary>
    /// Take the floor. Dispose the returned handle to release it.
    /// </summary>
    /// <remarks>
    /// Returns null rather than throwing when the event cannot be created: a
    /// machine that will not give us a kernel object must still be able to SPEAK.
    /// The caller loses echo suppression, not its voice.
    /// </remarks>
    public static IDisposable? Claim(string spokenText)
    {
        try
        {
            var handle = new EventWaitHandle(
                false,
                EventResetMode.ManualReset,
                EventName,
                out _);

            // Text first, flag second. A listener that sees the flag rise must
            // find the words already there, not a file from the previous reply.
            TryWriteSpokenText(spokenText);
            handle.Set();
            return new FloorHold(handle);
        }
        catch (Exception ex) when (ex is UnauthorizedAccessException or IOException)
        {
            return null;
        }
    }

    /// <summary>
    /// Open a read-only view of the flag, or null when there is nothing to watch.
    /// </summary>
    public static EventWaitHandle? TryOpenForWatching()
    {
        try
        {
            // Created rather than merely opened, so a listener that starts BEFORE
            // the first speaker still holds a handle to the same object. Opening
            // only would race: OpenExisting throws until someone speaks, and the
            // object would then be a different one each time.
            return new EventWaitHandle(false, EventResetMode.ManualReset, EventName, out _);
        }
        catch (Exception ex) when (ex is UnauthorizedAccessException or IOException)
        {
            return null;
        }
    }

    /// <summary>
    /// The text most recently claimed, or empty when it cannot be read. Never
    /// throws — a missing file simply disarms the near-match guard.
    /// </summary>
    public static string ReadSpokenText()
    {
        try
        {
            return File.Exists(SpokenTextPath)
                ? File.ReadAllText(SpokenTextPath)
                : string.Empty;
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            return string.Empty;
        }
    }

    private static void TryWriteSpokenText(string spokenText)
    {
        try
        {
            File.WriteAllText(SpokenTextPath, spokenText);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            // The first guard does not depend on this.
        }
    }

    private sealed class FloorHold : IDisposable
    {
        private readonly EventWaitHandle _handle;

        public FloorHold(EventWaitHandle handle) => _handle = handle;

        public void Dispose()
        {
            // Reset before closing. Closing alone does not clear a named event
            // that another process still holds a handle to, and a flag left
            // standing would leave `converse` deaf until its staleness cap fires.
            try { _handle.Reset(); } catch (ObjectDisposedException) { /* already gone */ }
            _handle.Dispose();
        }
    }
}
