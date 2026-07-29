using System.Runtime.InteropServices;
using NAudio.Wave;

namespace Helmion.VoiceDictation;

/// <summary>
/// Microphone capture for a hotkey-delimited dictation: 16 kHz mono, recording
/// from <see cref="Start"/> until <see cref="Stop"/>.
/// </summary>
/// <remarks>
/// There is deliberately NO voice-activity detection here, which is the one real
/// behavioural difference from the Pilot's recogniser
/// (desktop/Helmion.Desktop.Core/WhisperSpeechRecognizer.cs:29-39, which closes an
/// utterance after 750 ms of quiet). That endpointing is right for a conversation
/// and wrong for dictation: Troy pauses mid-sentence to think, and a VAD would
/// cut the recording there and inject half a thought. The hotkey is the
/// endpoint — nothing else stops the recording except the safety cap.
///
/// 16 kHz is not a preference. whisper.cpp is trained at 16 kHz and resamples
/// anything else, so capturing there avoids a conversion entirely.
/// </remarks>
[System.Runtime.Versioning.SupportedOSPlatform("windows")]
public sealed class MicRecorder : IDisposable
{
    public const int SampleRate = 16000;

    private readonly object _gate = new();
    private readonly List<float> _samples = new();

    private WaveInEvent? _capture;
    private bool _recording;
    private bool _disposed;

    /// <summary>Raised when the device faults. Never throws at the caller.</summary>
    public event EventHandler<string>? Faulted;

    public bool IsRecording
    {
        get { lock (_gate) { return _recording; } }
    }

    /// <summary>Seconds captured so far in the current recording.</summary>
    public double ElapsedSeconds
    {
        get { lock (_gate) { return _samples.Count / (double)SampleRate; } }
    }

    /// <summary>
    /// Open the microphone and begin accumulating samples. Returns false when the
    /// device is unavailable — the caller shows an error state, and the process
    /// keeps running so the next attempt can succeed.
    /// </summary>
    public bool Start()
    {
        lock (_gate)
        {
            if (_disposed || _recording)
            {
                return _recording;
            }

            _samples.Clear();
        }

        try
        {
            var capture = new WaveInEvent
            {
                WaveFormat = new WaveFormat(SampleRate, 16, 1),
                BufferMilliseconds = 50,
                NumberOfBuffers = 3,
            };

            capture.DataAvailable += OnDataAvailable;
            capture.RecordingStopped += OnRecordingStopped;
            capture.StartRecording();

            lock (_gate)
            {
                _capture = capture;
                _recording = true;
            }

            return true;
        }
        catch (Exception ex) when (IsDeviceFault(ex))
        {
            DisposeCapture();
            Faulted?.Invoke(
                this,
                $"Microphone unavailable: {ex.Message}. "
                + "Check Windows Settings, Privacy, Microphone, and that an input device is set as default.");
            return false;
        }
    }

    /// <summary>
    /// Close the device and hand back everything captured. An empty array means
    /// nothing usable was recorded; the caller must not treat that as text.
    /// </summary>
    public float[] Stop()
    {
        lock (_gate)
        {
            if (!_recording)
            {
                return Array.Empty<float>();
            }

            _recording = false;
        }

        DisposeCapture();

        lock (_gate)
        {
            var captured = _samples.ToArray();
            _samples.Clear();
            return captured;
        }
    }

    /// <summary>Stop and throw the audio away.</summary>
    public void Cancel()
    {
        _ = Stop();
    }

    public void Dispose()
    {
        lock (_gate)
        {
            if (_disposed)
            {
                return;
            }

            _disposed = true;
            _recording = false;
        }

        DisposeCapture();
    }

    private void OnDataAvailable(object? sender, WaveInEventArgs e)
    {
        try
        {
            lock (_gate)
            {
                if (!_recording || _disposed)
                {
                    return;
                }

                for (var i = 0; i + 1 < e.BytesRecorded; i += 2)
                {
                    var sample = (short)(e.Buffer[i] | (e.Buffer[i + 1] << 8));
                    _samples.Add(sample / 32768f);
                }
            }
        }
        catch (Exception ex)
        {
            Faulted?.Invoke(this, $"Capture error: {ex.Message}");
        }
    }

    private void OnRecordingStopped(object? sender, StoppedEventArgs e)
    {
        if (e.Exception is null)
        {
            return;
        }

        lock (_gate)
        {
            _recording = false;
        }

        Faulted?.Invoke(this, $"Microphone stopped: {e.Exception.Message}");
    }

    private void DisposeCapture()
    {
        WaveInEvent? capture;
        lock (_gate)
        {
            capture = _capture;
            _capture = null;
        }

        if (capture is null)
        {
            return;
        }

        try { capture.StopRecording(); } catch { /* device may already be gone */ }

        try
        {
            capture.DataAvailable -= OnDataAvailable;
            capture.RecordingStopped -= OnRecordingStopped;
        }
        catch
        {
            // ignore
        }

        try { capture.Dispose(); } catch { /* ignore */ }
    }

    /// <summary>Faults that mean "the audio device is missing or busy", not "there is a bug".</summary>
    internal static bool IsDeviceFault(Exception ex) =>
        ex is COMException
        or InvalidOperationException
        or NAudio.MmException
        or UnauthorizedAccessException
        or DllNotFoundException;
}
