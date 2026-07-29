using System.Text;
using System.Text.RegularExpressions;
using Helmion.Desktop.Core;

namespace Helmion.VoiceSpeak;

/// <summary>
/// Turns a finished Claude Code reply into something worth hearing: prose, with
/// the parts that only make sense on screen taken out.
/// </summary>
/// <remarks>
/// <para><b>This does not replace SpeechTextCleaner, it feeds it.</b> The last
/// line of <see cref="Clean"/> hands off to
/// <see cref="SpeechTextCleaner.CleanForSpeech"/> (SpeechTextCleaner.cs:14), which
/// already handles fenced code, inline code, headings, bullets, link syntax,
/// emphasis, whitespace collapse and the 1200-character ceiling. Everything above
/// that call is the set of things a Claude Code reply contains that Core's cleaner
/// was never written for, because Core's cleaner was written for chat replies in
/// the Pilot window, not for a terminal agent that answers in tables and cites
/// file:line.</para>
///
/// <para><b>Why the extra passes run BEFORE Core's and not after.</b>
/// SpeechTextCleaner.cs:44 collapses every run of whitespace, newlines included,
/// into single spaces. A markdown table is only recognisable while its line breaks
/// still exist — after that collapse it is indistinguishable from prose with a lot
/// of pipe characters in it. Same for horizontal rules and blockquote markers. So
/// line-structured work has to happen first, and the character-level work happens
/// first too, so that Core's 1200-character cap is applied to the FINAL text
/// rather than to text that still had a 300-character absolute path in it.</para>
///
/// <para><b>Why a table is announced rather than dropped silently.</b> Troy reads
/// along while he listens (CLAUDE.md rule 0.0123), so a table that is simply
/// missing from the audio reads as something hidden. Two words naming what was
/// skipped is honest and costs half a second; reading eight rows of pipes aloud is
/// neither.</para>
/// </remarks>
public static class ReplyTextCleaner
{
    /// <summary>
    /// Queue files ending in this are treated as an AI reply and cleaned. A plain
    /// <c>.txt</c> is spoken exactly as written.
    /// </summary>
    /// <remarks>
    /// The distinction exists so <c>voice.ps1 -Say "the deploy finished"</c> keeps
    /// behaving as it always has. Cleaning is lossy on purpose — it truncates at
    /// 1200 characters and rewrites paths — and applying that to a caller who
    /// handed over an exact sentence would be a silent change of meaning.
    /// </remarks>
    public const string ReplySuffix = ".reply.txt";

    /// <summary>Hard ceiling on a spoken reply, in characters.</summary>
    /// <remarks>
    /// <para>Kokoro speaks this voice at roughly <b>12.5 characters per second</b>
    /// — measured, not guessed: an 85-character sentence produces 6.78 s of audio
    /// (README.md, "Never pass the text as a PowerShell argument"). So 220
    /// characters is about <b>18 seconds</b>, while the 1200-character ceiling
    /// <see cref="SpeechTextCleaner.MaxSpokenLength"/> enforces is about
    /// <b>96 seconds</b> — a minute and a half of unbroken talking at a man who is
    /// trying to work.</para>
    ///
    /// <para>That is why Core's cap is not enough on its own and this one sits
    /// under it. A reply is not an audiobook: the screen already has the full text,
    /// so the voice only has to say enough for Troy to know what happened and
    /// whether to look. Long audio he cannot escape is his most consistent
    /// complaint, and the cheapest fix is to never generate it.</para>
    /// </remarks>
    public const int MaxSpokenReplyChars = 220;

    /// <summary>At most this many sentences, even when they are short ones.</summary>
    public const int MaxSpokenSentences = 2;

    /// <summary>
    /// The ONLY thing that may be spoken to get Troy's attention: his name, alone.
    /// </summary>
    /// <remarks>
    /// Troy's rule, 2026-07-29: to get his attention, say his name — never a status
    /// update. An unrequested status report is the thing that interrupts him; his
    /// name is one syllable that makes him look, after which the screen tells him
    /// the rest. It lives here as a constant so every caller says the same word and
    /// nobody re-invents a longer version of it.
    /// </remarks>
    public const string AttentionUtterance = "Troy.";

    /// <summary>Sentence boundary: after . ! or ? and the whitespace that follows.</summary>
    private static readonly Regex SentenceBreak = new(@"(?<=[.!?])\s+", RegexOptions.Compiled);

    /// <summary>Omission cues left stranded at the end of a shortened utterance.</summary>
    /// <remarks>
    /// "(table omitted)" earns its place in the middle of a sentence, where it
    /// explains a gap the listener would otherwise notice. Trailing off the end of
    /// a two-sentence clip it explains nothing — and because most replies end in a
    /// table or a command block, it would be the last thing Troy heard on nearly
    /// every single utterance. Measured on the 902-character fixture: the second
    /// kept "sentence" was the cue and nothing else.
    /// </remarks>
    private static readonly Regex TrailingOmissionCue =
        new(@"(?:\s*\((?:table|code) omitted\)\.?)+\s*$", RegexOptions.Compiled);

    // Fenced code first, so that pipes, paths and hashes INSIDE a code sample are
    // never mistaken for a table or a citation out in the prose.
    private static readonly Regex FencedCode = new(@"```[\s\S]*?```", RegexOptions.Compiled);

    private static readonly Regex HorizontalRule =
        new(@"(?m)^[ \t]{0,3}(?:[-*_=][ \t]*){3,}$", RegexOptions.Compiled);

    private static readonly Regex BlockQuote = new(@"(?m)^[ \t]{0,3}>+[ \t]?", RegexOptions.Compiled);

    private static readonly Regex Url = new(@"\b(?:https?|ftp)://\S+", RegexOptions.Compiled);

    /// <summary>Absolute Windows path, with or without a trailing :line.</summary>
    private static readonly Regex WindowsPath =
        new(@"[A-Za-z]:[\\/][^\s""'<>|]*", RegexOptions.Compiled);

    /// <summary>A relative or POSIX path — only when it has at least two separators,
    /// so that "and/or" and a lone "src/main" are left as ordinary words.</summary>
    private static readonly Regex SlashPath =
        new(@"(?<![A-Za-z0-9])~?[A-Za-z0-9_.\-]+(?:[\\/][A-Za-z0-9_.\-]+){2,}", RegexOptions.Compiled);

    /// <summary>"TextInjector.cs:334" — said as words, not as punctuation.</summary>
    private static readonly Regex FileLine =
        new(@"\b([A-Za-z0-9_.\-]+\.[A-Za-z][A-Za-z0-9]{0,5}):(\d+)(?:-(\d+))?", RegexOptions.Compiled);

    /// <summary>A commit hash or sha256 — nothing anyone wants read out digit by digit.</summary>
    private static readonly Regex LongHash =
        new(@"(?<![A-Za-z0-9])[0-9a-fA-F]{7,}(?![A-Za-z0-9])", RegexOptions.Compiled);

    /// <summary>Emoji (surrogate pairs) and dingbats like ✓ ✗ 🔴.</summary>
    private static readonly Regex Pictographs = new(@"[\p{So}\p{Cs}]+", RegexOptions.Compiled);

    private static readonly Regex BlankRun = new(@"(?:[ \t]*\r?\n){3,}", RegexOptions.Compiled);

    private static readonly Regex StrandedPunctuation = new(@"\s+([,.;:!?])", RegexOptions.Compiled);

    /// <summary>
    /// Clean a finished assistant reply for speech. Never throws and never returns
    /// null; a reply that cleans away to nothing returns an empty string and the
    /// caller simply says nothing.
    /// </summary>
    public static string Clean(string? text)
    {
        if (string.IsNullOrWhiteSpace(text))
        {
            return string.Empty;
        }

        var s = text.Replace("\r\n", "\n").Replace('\r', '\n');

        s = FencedCode.Replace(s, " (code omitted). ");
        s = RemoveTables(s);
        s = HorizontalRule.Replace(s, " ");
        s = BlockQuote.Replace(s, string.Empty);

        s = Url.Replace(s, " (link) ");

        // Paths before file:line, deliberately. The Windows pattern swallows the
        // ":334" on the end of a full path, so shortening to the file name first
        // leaves "stop_hook_speak.py:334" for the citation rule to say properly.
        s = WindowsPath.Replace(s, m => " " + LastSegment(m.Value) + " ");
        s = SlashPath.Replace(s, m => " " + LastSegment(m.Value) + " ");
        s = FileLine.Replace(s, m => m.Groups[3].Success
            ? $"{m.Groups[1].Value} lines {m.Groups[2].Value} to {m.Groups[3].Value}"
            : $"{m.Groups[1].Value} line {m.Groups[2].Value}");

        s = LongHash.Replace(s, " (hash) ");

        s = Pictographs.Replace(s, " ");
        s = s.Replace("→", " to ").Replace("—", ", ").Replace("–", ", ");

        s = BlankRun.Replace(s, "\n\n");

        // Core's cleaner finishes the job: fences (any this pass missed), inline
        // code, headings, bullets, links, emphasis, whitespace, 1200-char cap.
        var spoken = SpeechTextCleaner.CleanForSpeech(s);

        // Substitutions above leave punctuation stranded after a space — an em
        // dash becomes ", " and the collapse in SpeechTextCleaner.cs:44 turns
        // "green — zero" into "green , zero". Purely cosmetic in the text, but the
        // text is the artefact anyone checking this reads, so close it up. Only
        // ever removes characters, so the 1200-char cap still holds.
        spoken = StrandedPunctuation.Replace(spoken, "$1");

        return Shorten(spoken);
    }

    /// <summary>
    /// Cut a cleaned reply down to something worth listening to: the first couple
    /// of sentences, and never more than <see cref="MaxSpokenReplyChars"/>.
    /// </summary>
    /// <remarks>
    /// <para>Sentence-first rather than a blunt character cut, so a clip ends on a
    /// full stop instead of mid-word. The character ceiling is the backstop for the
    /// one case sentences cannot help with — a single enormous sentence — and even
    /// then it retreats to the last word boundary rather than slicing a word.</para>
    ///
    /// <para><b>Nothing is appended to say it was shortened.</b> An earlier version
    /// added ", truncated." That was right when the cap was 1200 characters and a
    /// cut meant real content was lost. At this length a cut is the normal case on
    /// nearly every reply, so announcing it would add a syllable of noise to every
    /// single utterance in order to state something permanently true. The full text
    /// is already on his screen.</para>
    /// </remarks>
    private static string Shorten(string spoken)
    {
        if (spoken.Length == 0)
        {
            return spoken;
        }

        var kept = new StringBuilder();
        var used = 0;

        foreach (var sentence in SentenceBreak.Split(spoken))
        {
            if (used >= MaxSpokenSentences)
            {
                break;
            }

            var projected = kept.Length == 0 ? sentence.Length : kept.Length + 1 + sentence.Length;
            if (kept.Length > 0 && projected > MaxSpokenReplyChars)
            {
                break;
            }

            if (kept.Length > 0)
            {
                kept.Append(' ');
            }

            kept.Append(sentence);
            used++;
        }

        // Empty only when the very FIRST sentence already blew the ceiling. Fall
        // back to the whole text so the character cut below still has something to
        // work with, rather than returning nothing and speaking silence.
        var result = kept.Length > 0 ? kept.ToString() : spoken;

        if (result.Length > MaxSpokenReplyChars)
        {
            var wordBreak = result.LastIndexOf(' ', MaxSpokenReplyChars - 1);
            result = wordBreak > MaxSpokenReplyChars / 2
                ? result[..wordBreak]
                : result[..MaxSpokenReplyChars];
        }

        // Strip trailing "(table omitted)." cues — but only when real words remain
        // underneath. A reply that IS nothing but a table should still say so
        // rather than go silent, which is why this is conditional.
        var trimmed = TrailingOmissionCue.Replace(result, string.Empty).TrimEnd();
        return trimmed.Length > 0 ? trimmed : result.TrimEnd();
    }

    /// <summary>
    /// Replace every run of two or more consecutive table lines with a short cue.
    /// </summary>
    /// <remarks>
    /// Done line by line rather than with one large regex because the rule is a
    /// statement about ADJACENT lines, which a regex can express only as a
    /// repetition group that then has to re-encode the line rule twice. A single
    /// stray line containing pipes stays as prose: a table needs at least two rows
    /// to be a table, and "the exit code is 0 | 1 | 2" in a sentence is not one.
    /// </remarks>
    private static string RemoveTables(string text)
    {
        var lines = text.Split('\n');
        var output = new StringBuilder(text.Length);
        var i = 0;

        while (i < lines.Length)
        {
            if (!IsTableLine(lines[i]))
            {
                output.Append(lines[i]).Append('\n');
                i++;
                continue;
            }

            // Consume the whole adjacent run before deciding, because the rule is
            // about how MANY consecutive pipe lines there are, which is not known
            // until the run ends.
            var start = i;
            while (i < lines.Length && IsTableLine(lines[i]))
            {
                i++;
            }

            output.Append(i - start >= 2 ? " (table omitted). " : lines[start]).Append('\n');
        }

        // Split/join leaves one extra newline; Core collapses whitespace anyway.
        return output.ToString();
    }

    /// <summary>
    /// A markdown table row: starts with a pipe, or carries two or more pipes.
    /// The second form catches tables written without leading pipes; the
    /// two-pipe floor keeps ordinary prose out.
    /// </summary>
    private static bool IsTableLine(string line)
    {
        var trimmed = line.TrimStart();
        if (trimmed.Length == 0)
        {
            return false;
        }

        if (trimmed[0] == '|')
        {
            return true;
        }

        var pipes = 0;
        foreach (var c in trimmed)
        {
            if (c == '|' && ++pipes >= 2)
            {
                return true;
            }
        }

        return false;
    }

    /// <summary>The file name at the end of a path — what a person would say.</summary>
    private static string LastSegment(string path)
    {
        var trimmed = path.TrimEnd('\\', '/', '.', ',', ')', ';', ':');
        var cut = trimmed.LastIndexOfAny(new[] { '\\', '/' });
        var tail = cut >= 0 && cut < trimmed.Length - 1 ? trimmed[(cut + 1)..] : trimmed;
        return tail.Length == 0 ? "(path)" : tail;
    }
}
