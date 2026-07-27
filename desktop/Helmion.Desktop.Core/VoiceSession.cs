using System.Speech.Recognition;
using System.Speech.Synthesis;

namespace Helmion.Desktop.Core;

/// <summary>
/// Manages microphone capture (Windows Speech Recognition) and TTS playback
/// (Windows SpeechSynthesizer). No external API keys needed — both use the
/// built-in Windows speech stack.
///
/// Lifecycle:
///   1. Call <see cref="StartListeningAsync"/> to begin recognition.
///   2. The <see cref="OnSpeechRecognized"/> event fires when speech is heard.
///   3. Call <see cref="SpeakAsync"/> to play a TTS response.
///   4. Call <see cref="StopListening"/> when done.
/// </summary>
[System.Runtime.Versioning.SupportedOSPlatform("windows")]
public sealed class VoiceSession : IDisposable
{
    private SpeechRecognitionEngine? _recognizer;
    private readonly SpeechSynthesizer _synth = new();
    private bool _listening;
    private bool _disposed;

    /// <summary>Raised when the recognizer produces a result above the confidence threshold.</summary>
    public event EventHandler<string>? OnSpeechRecognized;

    /// <summary>Raised on recognition errors (timeout, audio issue, etc.).</summary>
    public event EventHandler<string>? OnError;

    public bool IsListening => _listening;
    public bool IsSpeaking { get; private set; }

    public void StartListening()
    {
        if (_listening || _disposed) return;

        try
        {
            _recognizer = new SpeechRecognitionEngine();
            _recognizer.LoadGrammar(new DictationGrammar());
            _recognizer.SpeechRecognized += Recognizer_SpeechRecognized;
            _recognizer.RecognizeCompleted += Recognizer_RecognizeCompleted;
            _recognizer.SetInputToDefaultAudioDevice();
            _recognizer.RecognizeAsync(RecognizeMode.Multiple);
            _listening = true;
        }
        catch (Exception ex)
        {
            OnError?.Invoke(this, $"Mic unavailable: {ex.Message}");
            _recognizer?.Dispose();
            _recognizer = null;
        }
    }

    public void StopListening()
    {
        if (!_listening) return;
        _listening = false;
        try
        {
            _recognizer?.RecognizeAsyncStop();
        }
        catch
        {
            // Ignore stop errors
        }
    }

    /// <summary>Speaks <paramref name="text"/> using the Windows TTS engine.</summary>
    public async Task SpeakAsync(string text, CancellationToken cancellationToken = default)
    {
        if (string.IsNullOrWhiteSpace(text) || _disposed) return;

        StopSpeaking(); // Cancel any in-progress TTS

        IsSpeaking = true;
        try
        {
            await Task.Run(() =>
            {
                cancellationToken.ThrowIfCancellationRequested();
                _synth.Rate = 1;   // Normal speed (-10 to 10)
                _synth.Volume = 90;
                _synth.Speak(text);
            }, cancellationToken);
        }
        catch (OperationCanceledException)
        {
            _synth.SpeakAsyncCancelAll();
        }
        finally
        {
            IsSpeaking = false;
        }
    }

    public void StopSpeaking()
    {
        try
        {
            _synth.SpeakAsyncCancelAll();
        }
        catch
        {
            // Ignore
        }
        IsSpeaking = false;
    }

    private void Recognizer_SpeechRecognized(object? sender, SpeechRecognizedEventArgs e)
    {
        if (e.Result.Confidence < 0.55f) return; // Low confidence threshold
        OnSpeechRecognized?.Invoke(this, e.Result.Text);
    }

    private void Recognizer_RecognizeCompleted(object? sender, RecognizeCompletedEventArgs e)
    {
        _listening = false;
        if (e.Error is not null)
        {
            OnError?.Invoke(this, $"Recognition error: {e.Error.Message}");
        }
    }

    public void Dispose()
    {
        if (_disposed) return;
        _disposed = true;
        StopListening();
        StopSpeaking();
        _recognizer?.Dispose();
        _recognizer = null;
        _synth.Dispose();
    }
}
