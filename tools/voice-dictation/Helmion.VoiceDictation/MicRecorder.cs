using System.Runtime.InteropServices;
using NAudio.Wave;

namespace Helmion.VoiceDictation;

/// <summary>
/// Microphone capture for a hotkey-delimited dictation: 16 kHz mono, recording
/// from <see cref="Start"/> until <see cref="Stop"/>.
/// </summary>
/// <remarks>
/// TROY-APPROVED 2026-08-08 (reversal) — this project previously carried a note
/// here saying VAD was deliberately rejected because a pause-to-think mid-
/// sentence would get cut off. Troy overrode that directly: he wants one press
/// to open the mic, and ending with "send it" (or just going quiet) to close it
/// on its own — never a second manual press. <see cref="SilenceElapsedMs"/>
/// below is the caller-facing hook for that; the threshold lives in
/// <see cref="DictationConfig.SilenceStopMs"/>, tunable without a rebuild if
/// the default cuts off a real pause.
///
/// 16 kHz is not a preference. whisper.cpp is trained at 16 kHz and resamples
/// anything else, so capturing there avoids a conversion entirely.
/// </remarks>
[System.Runtime.Versioning.SupportedOSPlatform("windows")]
public sealed class MicRecorder : IDisposable
{
    public const int SampleRate = 16000;

    /// <summary>
    /// Normalized (-1..1) amplitude above which a sample counts as speech, not
    /// silence/room noise. Chosen conservatively low so a quiet voice still
    /// counts as "talking" rather than resetting the silence clock early.
    /// </summary>
    private const float SpeechAmplitudeThreshold = 0.02f;

    private readonly object _gate = new();
    private readonly List<float> _samples = new();

    private WaveInEvent? _capture;
    private bool _recording;
    private bool _disposed;
    private DateTime _lastSpeechUtc;
    private bool _hasHeardSpeech;

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

    /// <summary>Total samples captured so far, WITHOUT stopping the microphone.</summary>
    public int SampleCount
    {
        get { lock (_gate) { return _samples.Count; } }
    }

    /// <summary>
    /// A snapshot copy of the samples from <paramref name="startIndex"/> to now,
    /// while the microphone keeps recording. This is how "send it" is checked
    /// mid-recording — the caller can transcribe this slice without ever
    /// calling <see cref="Stop"/>, so nothing about the open mic changes.
    /// </summary>
    public float[] SamplesSince(int startIndex)
    {
        lock (_gate)
        {
            if (startIndex >= _samples.Count)
            {
                return Array.Empty<float>();
            }

            return _samples.GetRange(startIndex, _samples.Count - startIndex).ToArray();
        }
    }

    /// <summary>
    /// Milliseconds since audio last crossed <see cref="SpeechAmplitudeThreshold"/>,
    /// or null when no speech has been heard yet this recording (so the caller
    /// never auto-stops during the beat of silence before Troy starts talking).
    /// </summary>
    public double? SilenceElapsedMs
    {
        get
        {
            lock (_gate)
            {
                if (!_recording || !_hasHeardSpeech)
                {
                    return null;
                }

                return (DateTime.UtcNow - _lastSpeechUtc).TotalMilliseconds;
            }
        }
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
            _hasHeardSpeech = false;
            _lastSpeechUtc = DateTime.UtcNow;
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

                var sawSpeech = false;

                for (var i = 0; i + 1 < e.BytesRecorded; i += 2)
                {
                    var raw = (short)(e.Buffer[i] | (e.Buffer[i + 1] << 8));
                    var normalized = raw / 32768f;
                    _samples.Add(normalized);

                    if (!sawSpeech && MathF.Abs(normalized) >= SpeechAmplitudeThreshold)
                    {
                        sawSpeech = true;
                    }
                }

                if (sawSpeech)
                {
                    _hasHeardSpeech = true;
                    _lastSpeechUtc = DateTime.UtcNow;
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
