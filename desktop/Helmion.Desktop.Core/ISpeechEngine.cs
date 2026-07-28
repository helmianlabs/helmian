namespace Helmion.Desktop.Core;

/// <summary>
/// Coarse health of the voice stack, surfaced so the UI can show a status pill
/// and so a hardware fault degrades the app instead of killing it.
/// </summary>
public enum VoiceState
{
    /// <summary>Engine is alive but neither listening nor speaking.</summary>
    Idle,

    /// <summary>Microphone capture is running.</summary>
    Listening,

    /// <summary>Synthesized audio is playing.</summary>
    Speaking,

    /// <summary>
    /// An audio device or model failed. The engine stays constructed and every
    /// call remains safe to make, but voice is unavailable until a device
    /// returns — the app continues text-only.
    /// </summary>
    Degraded,
}

/// <summary>
/// Result of a voice-readiness pre-flight.
/// </summary>
/// <param name="HasOutputDevice">At least one active render endpoint exists (or the probe was inconclusive).</param>
/// <param name="RenderDeviceCount">Active output endpoints, or -1 when the probe could not determine a count.</param>
/// <param name="VoiceCount">Kokoro voices loaded and available for synthesis.</param>
/// <param name="PreferredVoiceName">The voice synthesis will use, when known.</param>
/// <param name="IsReadyForTts">False only when TTS positively cannot run.</param>
/// <param name="Warning">Human-readable reason, when something is wrong or unknown.</param>
public sealed record AudioEndpointStatus(
    bool HasOutputDevice,
    int RenderDeviceCount,
    int VoiceCount,
    string? PreferredVoiceName,
    bool IsReadyForTts,
    string? Warning);

/// <summary>
/// The swap seam for Helmion's voice stack: continuous dictation in, synthesized
/// speech out. <see cref="VoiceSession"/> is the only consumer and depends on
/// this contract rather than on any particular STT/TTS implementation.
/// </summary>
/// <remarks>
/// Two behaviours are load-bearing and any implementation must honour them:
/// <list type="bullet">
/// <item><see cref="Speak"/> BLOCKS until playback has finished. VoiceSession
/// resumes the microphone when it returns.</item>
/// <item>No method throws for a missing or faulted audio device. Failures are
/// reported through <see cref="Error"/> and <see cref="State"/>, so a bad device
/// never reaches the UI thread as an exception.</item>
/// </list>
/// </remarks>
public interface ISpeechEngine : IDisposable
{
    /// <summary>Final transcript for one complete utterance.</summary>
    event EventHandler<string>? SpeechRecognized;

    /// <summary>Speech onset detected by the VAD — fires before the transcript.</summary>
    event EventHandler? SpeechDetected;

    /// <summary>Non-fatal fault, already handled. Informational for the UI/console.</summary>
    event EventHandler<string>? Error;

    /// <summary>Microphone capture stopped, whether requested or unexpected.</summary>
    event EventHandler? DictationStopped;

    /// <summary>Fires whenever <see cref="State"/> changes.</summary>
    event EventHandler<VoiceState>? StateChanged;

    /// <summary>Current coarse health of the stack.</summary>
    VoiceState State { get; }

    /// <summary>True while the microphone is actively capturing.</summary>
    bool IsDictationRunning { get; }

    /// <summary>True while synthesized audio is playing.</summary>
    bool IsSpeaking { get; }

    /// <summary>
    /// Start (or resume) continuous dictation on the default microphone. The mic
    /// is a persistent toggle — capture runs until <see cref="StopDictation"/>,
    /// with no silence timeout that stops it on its own.
    /// </summary>
    void StartDictation();

    /// <summary>Stop dictation and release the capture device.</summary>
    void StopDictation();

    /// <summary>
    /// Suspend recognition without releasing the device, so the microphone does
    /// not transcribe our own speech while TTS plays. Resume with
    /// <see cref="StartDictation"/>.
    /// </summary>
    void PauseDictation();

    /// <summary>
    /// Synthesize and play <paramref name="text"/>, blocking until playback
    /// completes. Never throws for device faults.
    /// </summary>
    void Speak(string text, CancellationToken cancellationToken = default);

    /// <summary>Stop playback immediately and discard anything queued.</summary>
    void CancelSpeak();

    /// <summary>Check whether speech output can run, without producing sound.</summary>
    AudioEndpointStatus ProbeAudioEndpoints();
}
