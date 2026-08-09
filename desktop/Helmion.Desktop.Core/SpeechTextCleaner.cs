using System.Text.RegularExpressions;

namespace Helmion.Desktop.Core;

/// <summary>
/// Strips tool markup and dense symbols out of model output so synthesized
/// speech sounds like a person talking rather than a terminal being read aloud.
/// </summary>
public static class SpeechTextCleaner
{
    /// <summary>
    /// Longest utterance we will speak. Shorter = less Kokoro wall time (laggy feel).
    /// Was 1200; 420 chars is ~2–3 spoken sentences and keeps voice replies snappy.
    /// </summary>
    public const int MaxSpokenLength = 420;

    public static string CleanForSpeech(string text)
    {
        if (string.IsNullOrWhiteSpace(text))
        {
            return string.Empty;
        }

        var s = text;

        // Drop fenced code blocks (keep a short cue).
        s = Regex.Replace(s, @"```[\s\S]*?```", " (code omitted). ", RegexOptions.Multiline);

        // Inline code → plain words.
        s = Regex.Replace(s, "`([^`]*)`", "$1");

        // Drop tool command / agent chrome.
        s = Regex.Replace(s, @"\[CMD:[^\]]*\]", " ", RegexOptions.IgnoreCase);
        s = Regex.Replace(s, @"\[Tool Output:[^\]]*\]", " ", RegexOptions.IgnoreCase);
        s = Regex.Replace(s, @"\[Agent executing[^\]]*\]", " ", RegexOptions.IgnoreCase);
        s = Regex.Replace(
            s,
            @"\[(xAI Grok|OpenAI|Gemini|Anthropic|Grok|Claude) API error[^\]]*\]",
            " There was an API error. ",
            RegexOptions.IgnoreCase);

        // Soften markdown headings / bullets for the ear.
        s = Regex.Replace(s, @"^\s{0,3}#{1,6}\s*", "", RegexOptions.Multiline);
        s = Regex.Replace(s, @"^\s*[-*+]\s+", "", RegexOptions.Multiline);
        s = Regex.Replace(s, @"\[([^\]]+)\]\([^)]+\)", "$1");
        s = Regex.Replace(s, @"[*_~]{1,3}", "");
        s = Regex.Replace(s, @"\s+", " ").Trim();

        if (s.Length > MaxSpokenLength)
        {
            s = s[..MaxSpokenLength] + "…";
        }

        return s;
    }
}
