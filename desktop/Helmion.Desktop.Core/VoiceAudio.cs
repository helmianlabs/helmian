using NAudio.Wave;
using NAudio.Wave.SampleProviders;

namespace Helmion.Desktop.Core;

/// <summary>
/// Sample-format plumbing shared by the capture and playback sides.
/// </summary>
public static class VoiceAudio
{
    /// <summary>Sample rate whisper.cpp expects. Not negotiable — the model is trained at 16 kHz.</summary>
    public const int WhisperSampleRate = 16000;

    /// <summary>Sample rate Kokoro emits (KokoroPlayback.waveFormat: 24 kHz, mono, 16-bit).</summary>
    public const int KokoroSampleRate = 24000;

    /// <summary>Interpret little-endian 16-bit PCM as normalized floats in [-1, 1].</summary>
    public static void Pcm16ToFloat(byte[] source, int bytes, List<float> destination)
    {
        for (var i = 0; i + 1 < bytes; i += 2)
        {
            var sample = (short)(source[i] | (source[i + 1] << 8));
            destination.Add(sample / 32768f);
        }
    }

    /// <summary>Convert normalized floats to little-endian 16-bit PCM, clipping out-of-range values.</summary>
    public static byte[] FloatToPcm16(float[] samples)
    {
        var bytes = new byte[samples.Length * 2];
        for (var i = 0; i < samples.Length; i++)
        {
            var clamped = Math.Clamp(samples[i], -1f, 1f);
            var value = (short)(clamped * short.MaxValue);
            bytes[i * 2] = (byte)(value & 0xFF);
            bytes[(i * 2) + 1] = (byte)((value >> 8) & 0xFF);
        }

        return bytes;
    }

    /// <summary>
    /// Resample mono float samples to <paramref name="targetRate"/>. Used to feed
    /// Kokoro's 24 kHz output into Whisper's 16 kHz input during round-trip tests.
    /// </summary>
    public static float[] Resample(float[] samples, int sourceRate, int targetRate)
    {
        if (sourceRate == targetRate || samples.Length == 0)
        {
            return samples;
        }

        var stream = new RawSourceWaveStream(
            new MemoryStream(FloatToPcm16(samples)),
            new WaveFormat(sourceRate, 16, 1));

        var resampler = new WdlResamplingSampleProvider(stream.ToSampleProvider(), targetRate);

        var expected = (int)((long)samples.Length * targetRate / sourceRate) + 1024;
        var output = new List<float>(expected);
        var buffer = new float[targetRate];
        int read;
        while ((read = resampler.Read(buffer, 0, buffer.Length)) > 0)
        {
            output.AddRange(buffer.AsSpan(0, read).ToArray());
        }

        return output.ToArray();
    }

    /// <summary>
    /// Read a mono/stereo PCM WAV file as normalized float samples at
    /// <paramref name="targetRate"/>. Used by the headless STT test entry point,
    /// which accepts a WAV in place of a live microphone.
    /// </summary>
    public static float[] ReadWavAsSamples(string path, int targetRate = WhisperSampleRate)
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

    /// <summary>Write mono float samples to a 16-bit PCM WAV file.</summary>
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

    /// <summary>Root-mean-square level of a frame, in dBFS. Silence returns -100.</summary>
    public static double RmsDb(IReadOnlyList<float> samples, int offset, int count)
    {
        if (count <= 0 || offset < 0 || offset + count > samples.Count)
        {
            return -100d;
        }

        double sum = 0;
        for (var i = offset; i < offset + count; i++)
        {
            sum += (double)samples[i] * samples[i];
        }

        var rms = Math.Sqrt(sum / count);
        return rms <= 1e-10 ? -100d : 20d * Math.Log10(rms);
    }
}
