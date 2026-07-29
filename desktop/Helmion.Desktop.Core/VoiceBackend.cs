namespace Helmion.Desktop.Core;

/// <summary>
/// Which voice stack is driving the microphone and the speaker.
/// </summary>
/// <remarks>
/// Exactly one of these is ever live. The two backends cannot share the capture
/// and render devices: a half-started second backend is how you end up with two
/// stacks fighting over the same microphone, which presents as a mic that hears
/// nothing and a speaker that stutters. <see cref="VoiceBackendSelector"/> owns
/// that invariant.
/// </remarks>
public enum VoiceBackend
{
    /// <summary>No backend is running — voice is off, the app is text-only.</summary>
    None,

    /// <summary>
    /// Turn-based Whisper (STT) + Kokoro (TTS) behind <see cref="ISpeechEngine"/>,
    /// driven by <see cref="VoiceSession"/>. The reply text comes from Helmion's
    /// own model and tool loop.
    /// </summary>
    WhisperKokoro,

    /// <summary>
    /// Full-duplex speech-to-speech through an external Moshi server, driven by
    /// <see cref="IDuplexVoiceSession"/>. Moshi generates the reply itself.
    /// </summary>
    Moshi,
}

/// <summary>
/// What the UI renders for the voice stack: which backend is live, how healthy
/// it is, and whether we are on it by preference or because the preferred one
/// was unavailable.
/// </summary>
/// <param name="Backend">The single live backend, or <see cref="VoiceBackend.None"/>.</param>
/// <param name="State">Coarse health of that backend.</param>
/// <param name="IsFallback">True when the preferred backend was unavailable and we degraded to this one.</param>
/// <param name="Display">Short label for a status pill.</param>
/// <param name="Detail">Why, when something is wrong or unusual. Null when nothing needs explaining.</param>
public sealed record VoiceBackendStatus(
    VoiceBackend Backend,
    VoiceState State,
    bool IsFallback,
    string Display,
    string? Detail)
{
    /// <summary>Nothing is running.</summary>
    public static VoiceBackendStatus Off { get; } =
        new(VoiceBackend.None, VoiceState.Idle, false, "Voice off", null);

    /// <summary>
    /// Voice could not be started at all. The app stays fully usable in text —
    /// this status exists so that fact is visible rather than silent.
    /// </summary>
    public static VoiceBackendStatus Degraded(string? detail) =>
        new(VoiceBackend.None, VoiceState.Degraded, true, "Voice degraded — text only", detail);

    /// <summary>Moshi is live and holding the full-duplex stream.</summary>
    public static VoiceBackendStatus MoshiActive(VoiceState state) =>
        new(VoiceBackend.Moshi, state, false, "Moshi active (full duplex)", null);

    /// <summary>
    /// The turn-based stack is live. <paramref name="fallbackReason"/> is null
    /// when it was chosen deliberately, and carries the reason Moshi could not
    /// be used when it was not.
    /// </summary>
    public static VoiceBackendStatus WhisperKokoroActive(VoiceState state, string? fallbackReason) =>
        new(
            VoiceBackend.WhisperKokoro,
            state,
            fallbackReason is not null,
            fallbackReason is null
                ? "Whisper+Kokoro active (turn-based)"
                : "Whisper+Kokoro active (fallback)",
            fallbackReason);
}
