namespace Helmion.VoiceSpeak;

/// <summary>
/// Locates kokoro.onnx and the folder terminal AIs drop text into.
/// </summary>
/// <remarks>
/// <para><b>Why this does not just call VoiceModelPaths.</b> Core's resolver walks
/// up from the executable looking for a <c>models</c> folder
/// (VoiceModelPaths.cs:108-117). That works for the Pilot because the Pilot builds
/// under <c>desktop/</c> and the models sit at <c>desktop/models</c>. This project
/// builds under <c>tools/voice-dictation/</c>, so the same walk climbs
/// tools → Helmion → E:\ and never passes <c>desktop/models</c> — it would come
/// back null and report the 310 MB file as missing while it sat on disk. The
/// sibling dictation tool hit exactly this and solved it the same way
/// (VocabularyTranscriber.ResolveModelPath, cited at
/// VocabularyTranscriber.cs:62-68). KokoroSpeechSynthesizer takes an explicit
/// model path in its constructor, so the resolved path is simply handed to it.</para>
/// </remarks>
public static class SpeakPaths
{
    public const string ModelsDirEnvVar = "HELMION_VOICE_MODELS";
    public const string KokoroModelFileName = "kokoro.onnx";

    /// <summary>Where any process can drop a .txt file to have it spoken.</summary>
    public static string QueueDirectory => Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
        "Helmion",
        "speak-queue");

    /// <summary>
    /// Full path to kokoro.onnx, or null when it genuinely is not on disk.
    /// Order: the HELMION_VOICE_MODELS override the Pilot already honours, then
    /// models/ beside this executable, then a walk up the tree checking both
    /// models/ and desktop/models/ at each level.
    /// </summary>
    public static string? ResolveKokoroModel()
    {
        var env = Environment.GetEnvironmentVariable(ModelsDirEnvVar);
        if (!string.IsNullOrWhiteSpace(env))
        {
            var fromEnv = Path.Combine(env, KokoroModelFileName);
            if (File.Exists(fromEnv))
            {
                return fromEnv;
            }
        }

        var beside = Path.Combine(AppContext.BaseDirectory, "models", KokoroModelFileName);
        if (File.Exists(beside))
        {
            return beside;
        }

        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        for (var depth = 0; dir is not null && depth < 8; depth++, dir = dir.Parent)
        {
            var direct = Path.Combine(dir.FullName, "models", KokoroModelFileName);
            if (File.Exists(direct))
            {
                return direct;
            }

            // The one the plain walk misses: this project lives under tools/ while
            // the models live under desktop/.
            var underDesktop = Path.Combine(dir.FullName, "desktop", "models", KokoroModelFileName);
            if (File.Exists(underDesktop))
            {
                return underDesktop;
            }
        }

        return null;
    }
}
