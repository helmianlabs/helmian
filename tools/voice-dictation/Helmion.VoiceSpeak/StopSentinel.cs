namespace Helmion.VoiceSpeak;

/// <summary>
/// Makes Troy's existing stop button silence this process too.
/// </summary>
/// <remarks>
/// <para><b>Why this class exists at all.</b> Troy's stop path is already built and
/// already wired: <c>~/.claude/settings.json</c> line 109 runs
/// <c>scripts/stop_voice.ps1</c> on every <c>UserPromptSubmit</c>, and that script
/// does exactly two things (stop_voice.ps1:9-11) — it stamps
/// <c>~/.claude/_voice/STOP</c>, and it force-kills <c>ffplay</c>. Killing ffplay
/// silences the Edge-TTS path because that path plays through ffplay. This process
/// plays through WASAPI inside its own .NET process, so the ffplay kill does
/// nothing to it. Without this class a new voice would keep talking straight
/// through the stop button, which is the single behaviour Troy has said enrages
/// him most (CLAUDE.md rule 0.0124). So the sentinel file, not the process kill,
/// is the signal this honours.</para>
///
/// <para><b>Why a timestamp comparison and not "does the file exist".</b> The hook
/// fires on EVERY prompt submit, so STOP is present and freshly stamped most of
/// the time — a plain existence check would mute this process permanently. The
/// real question is "was stop pressed AFTER this utterance began", which is a
/// timestamp comparison against the moment the utterance started. A STOP left over
/// from the prompt that ASKED for this speech is older than the utterance and is
/// correctly ignored; a STOP stamped mid-sentence is newer and cancels.</para>
///
/// <para><b>Why the file is never deleted here.</b> <c>_voice/autoplayer.ps1</c>
/// consumes and deletes STOP when it is running (autoplayer.ps1:29-34). If both
/// processes deleted it, whichever polled first would swallow the signal and the
/// other would never see it. Comparing timestamps needs no deletion, so the two
/// can honour the same signal without racing. It also means a stale STOP — there
/// is one on disk right now, stamped 2026-07-29 00:25, with no autoplayer running
/// to clear it — cannot permanently mute this process.</para>
/// </remarks>
public sealed class StopSentinel
{
    /// <summary>
    /// The sentinel written by <c>~/.claude/scripts/stop_voice.ps1</c>. Hard-coded
    /// to the same absolute path that script and autoplayer.ps1 both use, rather
    /// than derived, so a different USERPROFILE cannot silently point this at a
    /// file nobody writes.
    /// </summary>
    public const string DefaultPath = @"C:\Users\troyh\.claude\_voice\STOP";

    private readonly string _path;

    public StopSentinel(string? path = null)
    {
        _path = string.IsNullOrWhiteSpace(path) ? DefaultPath : path;
    }

    public string Path => _path;

    /// <summary>
    /// When the stop button was last pressed, or null when it never has been.
    /// Never throws: an unreadable sentinel must not stop speech, it must only
    /// fail to cancel it.
    /// </summary>
    public DateTime? LastPressedUtc()
    {
        try
        {
            return File.Exists(_path) ? File.GetLastWriteTimeUtc(_path) : null;
        }
        catch
        {
            return null;
        }
    }

    /// <summary>
    /// True when stop was pressed after <paramref name="startedUtc"/> — that is,
    /// after the utterance now playing began.
    /// </summary>
    public bool PressedSince(DateTime startedUtc)
    {
        var pressed = LastPressedUtc();
        return pressed is not null && pressed.Value > startedUtc;
    }

    /// <summary>
    /// Watch for a press and cancel <paramref name="cancellation"/> the moment one
    /// lands. Returns a disposable that ends the watch.
    /// </summary>
    /// <remarks>
    /// Polls at 50 ms. KokoroSpeechSynthesizer checks its cancellation token every
    /// 20 ms while draining the audio device (KokoroSpeechSynthesizer.cs:391-415)
    /// and between segments, so a press is heard as silence well inside the 250 ms
    /// the autoplayer path achieves — Troy should not be able to tell the two
    /// apart by ear.
    /// </remarks>
    public IDisposable CancelOnPress(DateTime startedUtc, CancellationTokenSource cancellation)
    {
        var timer = new Timer(
            _ =>
            {
                try
                {
                    if (!cancellation.IsCancellationRequested && PressedSince(startedUtc))
                    {
                        SpeakLog.Info("Stop button pressed — cutting the current utterance.");
                        cancellation.Cancel();
                    }
                }
                catch
                {
                    // A failed poll must never take the process down mid-sentence.
                }
            },
            state: null,
            dueTime: 0,
            period: 50);

        return timer;
    }
}
