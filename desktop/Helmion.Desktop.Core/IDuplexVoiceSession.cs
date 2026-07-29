namespace Helmion.Desktop.Core;

/// <summary>Who produced a piece of duplex transcript.</summary>
public enum DuplexSpeaker
{
    /// <summary>The person at the microphone.</summary>
    User,

    /// <summary>The model's own spoken reply, as text.</summary>
    Assistant,
}

/// <summary>One line of transcript from a full-duplex conversation.</summary>
/// <param name="Speaker">Who said it.</param>
/// <param name="Text">What was said.</param>
public sealed record DuplexTranscript(DuplexSpeaker Speaker, string Text);

/// <summary>
/// The full-duplex speech-to-speech boundary — a peer of <see cref="VoiceSession"/>,
/// deliberately NOT an <see cref="ISpeechEngine"/>.
/// </summary>
/// <remarks>
/// <para>
/// The distinction is architectural, not cosmetic, and it is the reason this
/// interface exists at all (see docs/VOICE_STACK_ASSESSMENT.md section f).
/// <see cref="ISpeechEngine"/> is the STT and TTS halves of a turn structure:
/// mic → text → <em>Helmion's model and tool loop</em> → text → speaker. A duplex
/// model like Moshi streams audio continuously in both directions and
/// <em>generates the reply itself</em>. There is no seam in that loop where
/// Helmion's model, permission prompt, or tool dispatcher can sit.
/// </para>
/// <para>
/// So there is no <c>Speak(text)</c> here on purpose. Handing a duplex model your
/// own model's text to read aloud is a category error, and an adapter that
/// pretended otherwise would be lying about which brain answered.
/// </para>
/// <para>
/// The product consequence is explicit: in duplex mode the voice brain is the
/// duplex model, not Helmion's selected model, and
/// <see cref="TranscriptReceived"/> is a record of that conversation rather than
/// an input to Helmion's own loop.
/// </para>
/// </remarks>
public interface IDuplexVoiceSession : IDisposable
{
    /// <summary>A line of transcript, from either side of the conversation.</summary>
    event EventHandler<DuplexTranscript>? TranscriptReceived;

    /// <summary>The user spoke over the model and playback was cut short.</summary>
    event EventHandler? Interrupted;

    /// <summary>Non-fatal fault, already handled. Informational for the UI/console.</summary>
    event EventHandler<string>? Error;

    /// <summary>Fires whenever <see cref="State"/> changes.</summary>
    event EventHandler<VoiceState>? StateChanged;

    /// <summary>
    /// The duplex stream stopped, whether requested or not. An unrequested Ended
    /// is what <see cref="VoiceBackendSelector"/> treats as a mid-call death, and
    /// it is the trigger for automatic fallback to the turn-based stack.
    /// </summary>
    event EventHandler? Ended;

    /// <summary>Coarse health of the duplex stream.</summary>
    VoiceState State { get; }

    /// <summary>True while the duplex stream is open in both directions.</summary>
    bool IsRunning { get; }

    /// <summary>
    /// Open the stream. Throwing here means the backend is unusable and the
    /// selector must fall back; it must not be swallowed into a half-live state.
    /// </summary>
    Task StartAsync(CancellationToken cancellationToken = default);

    /// <summary>Close the stream and release the audio devices. Never throws.</summary>
    Task StopAsync();
}
