namespace Helmion.Desktop.Core;

/// <summary>
/// Locates the local voice models and the assets KokoroSharp ships in its NuGet
/// package. Nothing here downloads anything — <c>desktop/scripts/get-voice-models.ps1</c>
/// fetches the two large model files.
/// </summary>
public static class VoiceModelPaths
{
    /// <summary>Override the models directory (absolute path).</summary>
    public const string ModelsDirEnvVar = "HELMION_VOICE_MODELS";

    public const string WhisperModelFileName = "ggml-base.en.bin";
    public const string KokoroModelFileName = "kokoro.onnx";

    /// <summary>
    /// Directory holding ggml-base.en.bin and kokoro.onnx, or null when no
    /// candidate directory exists on disk.
    /// </summary>
    public static string? ModelsDirectory => ResolveModelsDirectory();

    /// <summary>Full path to the Whisper ggml model, or null when absent.</summary>
    public static string? WhisperModelPath => ExistingFile(WhisperModelFileName);

    /// <summary>Full path to the Kokoro ONNX model, or null when absent.</summary>
    public static string? KokoroModelPath => ExistingFile(KokoroModelFileName);

    /// <summary>
    /// Kokoro speaker embeddings (.npy). Copied next to the executable by the
    /// KokoroSharp package's buildTransitive targets.
    /// </summary>
    public static string? VoicesDirectory => ExistingDirectory("voices");

    /// <summary>
    /// espeak-ng phonemizer binaries, also copied out of the KokoroSharp package.
    /// </summary>
    public static string? EspeakDirectory => ExistingDirectory("espeak");

    /// <summary>
    /// A single sentence naming exactly what is missing, or null when the stack
    /// has everything it needs. Used to explain a degraded voice stack instead of
    /// failing with a native load error.
    /// </summary>
    public static string? DescribeMissingAssets()
    {
        var missing = new List<string>();

        if (WhisperModelPath is null)
        {
            missing.Add(WhisperModelFileName);
        }

        if (KokoroModelPath is null)
        {
            missing.Add(KokoroModelFileName);
        }

        if (missing.Count == 0)
        {
            return null;
        }

        var dir = ResolveModelsDirectory() ?? DefaultModelsDirectory();
        return $"Voice models missing ({string.Join(", ", missing)}). "
            + $"Run desktop/scripts/get-voice-models.ps1 to download them into {dir}.";
    }

    private static string? ExistingFile(string fileName)
    {
        var dir = ResolveModelsDirectory();
        if (dir is null)
        {
            return null;
        }

        var path = Path.Combine(dir, fileName);
        return File.Exists(path) ? path : null;
    }

    private static string? ExistingDirectory(string name)
    {
        var path = Path.Combine(AppContext.BaseDirectory, name);
        return Directory.Exists(path) ? path : null;
    }

    private static string DefaultModelsDirectory() =>
        Path.Combine(AppContext.BaseDirectory, "models");

    /// <summary>
    /// Env override first, then a models folder beside the executable (how a
    /// published build ships), then a walk up the tree to desktop/models (how a
    /// dev build running out of bin/Debug/net10.0-windows finds them).
    /// </summary>
    private static string? ResolveModelsDirectory()
    {
        var configured = Environment.GetEnvironmentVariable(ModelsDirEnvVar);
        if (!string.IsNullOrWhiteSpace(configured) && Directory.Exists(configured))
        {
            return configured;
        }

        var beside = DefaultModelsDirectory();
        if (Directory.Exists(beside))
        {
            return beside;
        }

        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        for (var depth = 0; dir is not null && depth < 8; depth++, dir = dir.Parent)
        {
            var candidate = Path.Combine(dir.FullName, "models");
            if (Directory.Exists(candidate)
                && File.Exists(Path.Combine(candidate, KokoroModelFileName)))
            {
                return candidate;
            }
        }

        return null;
    }
}
