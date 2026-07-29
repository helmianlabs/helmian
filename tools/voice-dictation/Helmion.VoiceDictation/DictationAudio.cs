using NAudio.Wave;
using NAudio.Wave.SampleProviders;

namespace Helmion.VoiceDictation;

/// <summary>
/// WAV plumbing for the headless test path — reading a known recording in place
/// of a live microphone, and writing captured audio out when a transcript needs
/// to be explained after the fact.
/// </summary>
/// <remarks>
/// This duplicates a handful of lines from
/// desktop/Helmion.Desktop.Core/VoiceAudio.cs on purpose. Referencing that
/// assembly would couple this tool to the whole Pilot dependency graph (Npgsql,
/// KokoroSharp, the local-service protocol) for four helper methods.
/// </remarks>
[System.Runtime.Versioning.SupportedOSPlatform("windows")]
public static class DictationAudio
{
    /// <summary>Read any PCM WAV as mono float samples at <paramref name="targetRate"/>.</summary>
    public static float[] ReadWavAsSamples(string path, int targetRate = MicRecorder.SampleRate)
    {
        using var reader = new AudioFileReader(path);

        ISampleProvider provider = reader;
        if (provider.WaveFormat.Channels > 1)
        {
            provider = provider.ToMono();
        }

        if (provider.WaveFormat.SampleRate != targetRate)
        {
            provider = new WdlResamplingSampleProvider(provider, targetRate);
        }

        var output = new List<float>();
        var buffer = new float[targetRate];
        int read;
        while ((read = provider.Read(buffer, 0, buffer.Length)) > 0)
        {
            output.AddRange(buffer.AsSpan(0, read).ToArray());
        }

        return output.ToArray();
    }

    /// <summary>Write mono float samples to a 16-bit PCM WAV.</summary>
    public static void WriteWav(string path, float[] samples, int sampleRate)
    {
        var directory = Path.GetDirectoryName(path);
        if (!string.IsNullOrEmpty(directory))
        {
            Directory.CreateDirectory(directory);
        }

        using var writer = new WaveFileWriter(path, new WaveFormat(sampleRate, 16, 1));
        writer.WriteSamples(samples, 0, samples.Length);
    }
}
