using NAudio.CoreAudioApi;

namespace Helmion.Desktop.Core;

/// <summary>
/// Read-only snapshot of the default microphone's state.
/// </summary>
/// <param name="DeviceName">Friendly name, or null when no capture device is active.</param>
/// <param name="IsMuted">Endpoint mute flag, or null when it could not be read.</param>
/// <param name="MasterVolume">Endpoint master level 0..1, or null when it could not be read.</param>
/// <param name="Error">Why the read failed, when it did.</param>
public sealed record CaptureDevicePosture(
    string? DeviceName,
    bool? IsMuted,
    float? MasterVolume,
    string? Error)
{
    /// <summary>A value two snapshots can be compared on to prove nothing changed.</summary>
    public string Fingerprint =>
        $"{DeviceName ?? "<none>"}|muted={IsMuted?.ToString() ?? "?"}|"
        + $"volume={(MasterVolume.HasValue ? MasterVolume.Value.ToString("F4") : "?")}";
}

/// <summary>
/// Reads the microphone's mute flag and level WITHOUT changing either.
/// </summary>
/// <remarks>
/// This exists because of a specific, recorded harm: a previous voice attempt on
/// this machine left Troy's microphone ducked while it was speaking, so he could
/// not hear himself being heard
/// (~/.claude/projects/C--Users-troyh/memory/feedback-2026-07-25-voice-mutes-troys-mic.md,
/// 2026-07-25).
///
/// Every member here is a getter. There is deliberately no setter, no
/// SetMute, and no volume write anywhere in this type — so the voice stack can
/// be shown, by reading this file, to have no way to mute anything. The smoke
/// suite uses it to fingerprint the device before and after building the engine
/// and assert the two match.
/// </remarks>
[System.Runtime.Versioning.SupportedOSPlatform("windows")]
public static class AudioDevicePosture
{
    /// <summary>Snapshot the default communications/console capture endpoint.</summary>
    public static CaptureDevicePosture ReadDefaultCapture()
    {
        try
        {
            using var enumerator = new MMDeviceEnumerator();

            if (!enumerator.HasDefaultAudioEndpoint(DataFlow.Capture, Role.Console))
            {
                return new CaptureDevicePosture(null, null, null, "No default capture device.");
            }

            using var device = enumerator.GetDefaultAudioEndpoint(DataFlow.Capture, Role.Console);
            return new CaptureDevicePosture(
                device.FriendlyName,
                device.AudioEndpointVolume.Mute,
                device.AudioEndpointVolume.MasterVolumeLevelScalar,
                null);
        }
        catch (Exception ex) when (WhisperSpeechRecognizer.IsDeviceFault(ex))
        {
            return new CaptureDevicePosture(null, null, null, ex.Message);
        }
    }

    /// <summary>
    /// How the two audio devices are opened, stated so it can be reported rather
    /// than assumed. Both are shared-mode; neither can take a device exclusively.
    /// </summary>
    public static string DescribeShareMode() =>
        "capture: NAudio WaveInEvent (winmm waveIn — the API has no exclusive mode); "
        + "render: WASAPI AudioClientShareMode.Shared, falling back to waveOut WAVE_MAPPER.";
}
