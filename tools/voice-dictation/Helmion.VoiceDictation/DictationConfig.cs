using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace Helmion.VoiceDictation;

/// <summary>
/// Everything Troy can change without a rebuild, loaded from
/// voice-dictation.config.json beside the executable.
/// </summary>
/// <remarks>
/// Loading never throws. A missing file, a typo'd hotkey or malformed JSON all
/// degrade to the built-in defaults and a log line — requirement 4 (fail safe)
/// means a bad config must not stop the microphone working.
/// </remarks>
public sealed class DictationConfig
{
    /// <summary>Whisper reads only the last ~224 tokens of an initial prompt.</summary>
    /// <remarks>
    /// Sources agree on the 224-token ceiling and that later tokens dominate
    /// (developers.openai.com/cookbook/examples/whisper_prompting_guide). English
    /// BPE runs roughly 4 characters per token, so 700 characters sits under the
    /// ceiling with room to spare. When the list overflows we keep the TAIL,
    /// because that is the end the model weights most heavily.
    /// </remarks>
    public const int PromptCharBudget = 700;

    private static readonly JsonSerializerOptions ReadOptions = new()
    {
        PropertyNameCaseInsensitive = true,
        ReadCommentHandling = JsonCommentHandling.Skip,
        AllowTrailingCommas = true,
    };

    public string Hotkey { get; init; } = "ctrl+alt+space";

    public string CancelHotkey { get; init; } = "ctrl+alt+x";

    /// <summary>
    /// Toggles hands-free conversation mode: every finished Claude Code reply is
    /// spoken by the local Kokoro voice. Empty disables the hotkey and leaves the
    /// mode switchable only from <c>voice.ps1 -Conversation</c>.
    /// </summary>
    public string ConversationHotkey { get; init; } = "ctrl+alt+c";

    /// <summary>
    /// The file the Claude Code Stop hook reads before it speaks anything. Empty
    /// resolves to <see cref="ConversationMode.DefaultStateFile"/>.
    /// </summary>
    public string VoiceStateFile { get; init; } = string.Empty;

    /// <summary>
    /// Explicit path to "Helmion Voice Speak.exe". Empty resolves it by walking up
    /// from this executable, which is what works for a normal side-by-side build.
    /// </summary>
    public string SpeakExePath { get; init; } = string.Empty;

    public string InjectionMode { get; init; } = "paste";

    public bool RestoreClipboard { get; init; } = true;

    /// <summary>
    /// How long to wait after sending Ctrl+V before putting the old clipboard
    /// back.
    /// </summary>
    /// <remarks>
    /// This is a race and there is no way to close it from outside the target
    /// process: the paste is handled by whatever window has focus, on its own
    /// message loop, and nothing tells us when it has finished reading the
    /// clipboard. Restore too early and the target pastes the PREVIOUS clipboard
    /// contents instead of the dictation — a silent wrong-text bug, which is far
    /// worse than leaving a transcript on the clipboard. The default is therefore
    /// generous. Set restoreClipboard to false to remove the race entirely.
    /// </remarks>
    public int ClipboardRestoreDelayMs { get; init; } = 400;

    public bool AppendTrailingSpace { get; init; } = true;

    public bool AutoSubmit { get; init; }

    public int MaxRecordingSeconds { get; init; } = 300;

    /// <summary>
    /// TROY-APPROVED 2026-08-08 (final design, stated explicitly after two wrong
    /// builds) — the hotkey is a PURE on/off switch for the mic and nothing
    /// else. It never auto-stops, never times out early, never has anything to
    /// do with submitting. The mic stays open across as many sentences as he
    /// wants until he presses the hotkey again to close it. The ONLY thing that
    /// injects text and presses Enter mid-recording is saying "send it" out
    /// loud — detected by re-checking the tail of the still-open recording
    /// after every pause, per <see cref="SendItCheckSilenceMs"/>, WITHOUT
    /// stopping the microphone. Closing the mic separately flushes whatever was
    /// said since the last "send it" as a normal (non-submitted) injection, so
    /// nothing said is ever silently lost.
    /// </summary>
    public int SendItCheckSilenceMs { get; init; } = 700;

    public string ModelPath { get; init; } = string.Empty;

    public bool ShowTrayIcon { get; init; } = true;

    /// <summary>
    /// TROY-APPROVED 2026-08-08 — a small always-on-top round button, separate
    /// from the tray dot, that shows the same idle/recording/transcribing/error
    /// colours AND can be clicked to toggle dictation instead of the hotkey.
    /// Troy asked for something visible on screen, not just a dot next to the
    /// clock he has to go look for.
    /// </summary>
    public bool ShowFloatingButton { get; init; } = true;

    public string LogPath { get; init; } = string.Empty;

    public IReadOnlyList<string> Vocabulary { get; init; } = Array.Empty<string>();

    public string VocabularyPromptOverride { get; init; } = string.Empty;

    /// <summary>True when text should be injected by clipboard + Ctrl+V.</summary>
    [JsonIgnore]
    public bool UsesPasteInjection =>
        !InjectionMode.Equals("type", StringComparison.OrdinalIgnoreCase);

    /// <summary>Default config path: beside the executable.</summary>
    public static string DefaultPath =>
        Path.Combine(AppContext.BaseDirectory, "voice-dictation.config.json");

    /// <summary>
    /// Read the config, or return defaults. <paramref name="problem"/> carries a
    /// human-readable reason when the file could not be used, so the caller can
    /// log it — this method itself never throws and never shows a dialog.
    /// </summary>
    public static DictationConfig Load(string path, out string? problem)
    {
        problem = null;

        try
        {
            if (!File.Exists(path))
            {
                problem = $"No config at {path}; using built-in defaults.";
                return new DictationConfig { Vocabulary = Array.Empty<string>() };
            }

            var json = File.ReadAllText(path);
            var parsed = JsonSerializer.Deserialize<DictationConfig>(json, ReadOptions);
            if (parsed is null)
            {
                problem = $"Config at {path} parsed to nothing; using built-in defaults.";
                return new DictationConfig();
            }

            return parsed;
        }
        catch (Exception ex)
        {
            problem = $"Config at {path} could not be read ({ex.Message}); using built-in defaults.";
            return new DictationConfig();
        }
    }

    /// <summary>
    /// Build the Whisper initial prompt from the vocabulary list.
    /// </summary>
    /// <remarks>
    /// The prompt is written as ordinary prose rather than a bare token dump
    /// because the initial prompt is decoded as if it were the beginning of the
    /// transcript — text that reads like a transcript conditions the model, text
    /// that reads like a config file conditions it toward config files.
    /// </remarks>
    public string BuildVocabularyPrompt()
    {
        if (!string.IsNullOrWhiteSpace(VocabularyPromptOverride))
        {
            return Trim(VocabularyPromptOverride.Trim());
        }

        var terms = Vocabulary
            .Where(term => !string.IsNullOrWhiteSpace(term))
            .Select(term => term.Trim())
            .ToArray();

        if (terms.Length == 0)
        {
            return string.Empty;
        }

        var builder = new StringBuilder();
        builder.Append("The following words appear in this recording: ");
        builder.Append(string.Join(", ", terms));
        builder.Append('.');

        return Trim(builder.ToString());
    }

    /// <summary>
    /// Keep the tail within <see cref="PromptCharBudget"/>, cutting on a comma so
    /// the prompt never opens mid-word.
    /// </summary>
    private static string Trim(string prompt)
    {
        if (prompt.Length <= PromptCharBudget)
        {
            return prompt;
        }

        var tail = prompt[^PromptCharBudget..];
        var firstBreak = tail.IndexOf(", ", StringComparison.Ordinal);
        return firstBreak >= 0 ? tail[(firstBreak + 2)..] : tail;
    }
}
