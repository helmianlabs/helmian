using System.Text;
using System.Text.RegularExpressions;

namespace Helmion.Desktop.Core;

/// <summary>
/// Stage-one content policy for model replies inside Helmian (Maestro / agents).
/// Mirrors the browser extension lanes: unsupported confidence (hedge + checkable
/// fact), false certainty (claims verification without a source), and harm/hurt.
/// Flags for Guard; never blocks the text the human is already reading.
/// </summary>
public static class ReplyContentPolicy
{
    public const string Source = "Reply content policy";
    public const string ActionKind = "reply-content";

    public const string SignatureUnverified = "reply-content-unverified";
    public const string SignatureFalseCertainty = "reply-content-false-certainty";
    public const string SignatureHarm = "reply-content-harm";

    /// <summary>Pinned: this lane never withholds assistant text.</summary>
    public const bool NeverBlocks = false;

    private static readonly string[] ConfidenceMarkers =
    [
        "if i recall correctly", "if i remember correctly", "from what i recall",
        "from what i remember", "as far as i can remember", "as far as i know",
        "as i recall", "if i recall", "i seem to remember", "off the top of my head",
        "i would guess", "my guess is", "i am fairly sure", "i'm fairly sure",
        "i am pretty sure", "i'm pretty sure", "i believe", "i think", "i assume",
        "i suspect", "i would say", "i'd say", "should probably be", "is probably",
        "are probably", "probably", "most likely", "likely", "presumably", "apparently",
        "should be", "should work", "should already", "ought to be", "might be",
        "may be", "could be", "generally", "usually", "typically", "normally",
        "in most cases", "i think it is", "iirc", "afaik",
    ];

    private static readonly string[] FalseCertaintyMarkers =
    [
        "i confirmed", "i verified", "i have verified", "i've verified",
        "i checked the docs", "i checked the documentation", "according to the docs",
        "the documentation says", "as documented", "as verified", "guaranteed that",
        "definitely is", "definitely are", "certainly is", "without a doubt",
        "the fact is that", "i already checked", "proven that",
    ];

    private static readonly string[] JudgmentTerms =
    [
        "cleaner", "nicer", "prettier", "uglier", "better", "worse", "best", "worst",
        "simpler", "clearer", "confusing", "elegant", "ugly", "preferable", "prefer",
        "overkill", "good idea", "bad idea", "right call", "wrong call", "worth it",
        "not worth", "i like", "i don't like", "i do not like", "my preference",
        "feels", "seems nicer", "more readable", "less readable", "more maintainable",
    ];

    private static readonly (string Kind, string What, Regex Pattern)[] CheckableReferents =
    [
        ("endpoint", "an API route or HTTP status",
            new Regex(@"/(?:api|v\d)/[A-Za-z0-9._/-]+|\bHTTP\s+\d{3}\b|\b(?:GET|POST|PUT|PATCH|DELETE)\s+/",
                RegexOptions.Compiled | RegexOptions.CultureInvariant)),
        ("file-path", "a file or directory path",
            new Regex(
                @"(?:[A-Za-z]:\\[^\s""'`,;]+|(?:\.{0,2}/)[A-Za-z0-9._@-]+(?:/[A-Za-z0-9._@-]+)*|\b[A-Za-z0-9._-]+\.(?:mjs|cjs|jsx?|tsx?|json|ya?ml|toml|ini|cs|csproj|ps1|sh|py|rb|go|rs|sql|md|xaml|env)\b)",
                RegexOptions.Compiled | RegexOptions.CultureInvariant)),
        ("symbol", "a function, method or type name",
            new Regex(@"\b[A-Za-z_$][A-Za-z0-9_$]*\s*\(\s*\)|\b[A-Za-z_$][A-Za-z0-9_$]*\.[A-Za-z_$][A-Za-z0-9_$]*\b",
                RegexOptions.Compiled | RegexOptions.CultureInvariant)),
        ("command-syntax", "a command or one of its flags",
            new Regex(
                @"(?:^|\s)(?:npm|npx|pnpm|yarn|git|docker|kubectl|psql|dotnet|node|python|pip|uv|cargo|gh|az|aws|fly|vercel|powershell|pwsh)\s+[a-z-]+|\s--[a-z][a-z0-9-]{2,}\b",
                RegexOptions.Compiled | RegexOptions.IgnoreCase | RegexOptions.CultureInvariant)),
        ("menu-location", "a place in a user interface",
            new Regex(
                @"\b(?:under|in|inside|from|via)\s+(?:the\s+)?[A-Z][A-Za-z ]{1,24}(?:\s*(?:>|→|->|»)\s*[A-Za-z][A-Za-z ]{1,24})+|\b[A-Z][A-Za-z]+\s*(?:>|→|->|»)\s*[A-Z][A-Za-z]+",
                RegexOptions.Compiled | RegexOptions.CultureInvariant)),
        ("version", "version-specific behaviour",
            new Regex(
                @"\bv?\d+\.\d+(?:\.\d+)?\b|\b(?:version|since|as of|prior to|before|after)\s+v?\d+|\b(?:node|python|dotnet|\.net|react|postgres|postgresql)\s+\d+",
                RegexOptions.Compiled | RegexOptions.IgnoreCase | RegexOptions.CultureInvariant)),
        ("config-key", "a configuration key or environment variable",
            new Regex(@"\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+){1,}\b|""[a-z][A-Za-z0-9]*(?:[A-Z][A-Za-z0-9]*)*""\s*:",
                RegexOptions.Compiled | RegexOptions.CultureInvariant)),
        ("quantity", "a specific number that can be measured",
            new Regex(
                @"\b\d+(?:\.\d+)?\s*(?:ms|milliseconds?|s|seconds?|m|minutes?|h|hours?|days?|[KMGT]B|bytes?|chars?|characters?|lines?|rows?|px|%)\b|\b(?:port|exit code|status|timeout|limit|cap|threshold|default)\s+(?:of\s+)?\d+",
                RegexOptions.Compiled | RegexOptions.IgnoreCase | RegexOptions.CultureInvariant)),
    ];

    private static readonly Regex HasCitation = new(
        @"https?://|file:\s*\d+|\b[A-Za-z0-9_.-]+\.(?:cs|mjs|js|ts|xaml|md):\d+\b",
        RegexOptions.Compiled | RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);

    // Harm: high-signal phrases only. Protective meta ("how do I prevent…") is filtered first.
    private static readonly Regex ProtectiveContext = new(
        @"^\s*(?:how|what)\s+(?:can|could|should|do)\s+(?:i|we|you)\s+(?:prevent|avoid|stop|report|recover)\b|^\s*(?:do not|don't|never)\b|^\s*is\s+it\s+(?:safe|illegal)\b",
        RegexOptions.Compiled | RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);

    private static readonly (string Id, string Label, Regex Pattern)[] HarmPatterns =
    [
        ("self-harm", "self-harm instructions",
            new Regex(@"\b(?:how to (?:kill|harm) (?:myself|yourself)|commit suicide|end my life)\b",
                RegexOptions.Compiled | RegexOptions.IgnoreCase | RegexOptions.CultureInvariant)),
        ("violence", "violence toward people",
            new Regex(@"\b(?:how to (?:murder|assassinate|kill)\b.{0,40}\b(?:him|her|them|someone|people)|build a bomb to hurt)\b",
                RegexOptions.Compiled | RegexOptions.IgnoreCase | RegexOptions.CultureInvariant)),
        ("credential-theft", "credential or account theft coaching",
            new Regex(@"\b(?:phish(?:ing)?|steal (?:passwords?|credentials)|social engineer)\b.{0,80}\b(?:bank|login|password|2fa|mfa)\b",
                RegexOptions.Compiled | RegexOptions.IgnoreCase | RegexOptions.CultureInvariant)),
        ("csam", "child sexual exploitation language",
            new Regex(@"\b(?:child\s+(?:porn|pornography)|csam|sexual(?:ly)?\s+(?:with|involving)\s+(?:a\s+)?(?:child|minor|underage))\b",
                RegexOptions.Compiled | RegexOptions.IgnoreCase | RegexOptions.CultureInvariant)),
        ("hate-attack", "targeted dehumanizing attack",
            new Regex(@"\b(?:you should (?:die|be killed)|kill all the)\b",
                RegexOptions.Compiled | RegexOptions.IgnoreCase | RegexOptions.CultureInvariant)),
    ];

    private static readonly Regex[] JudgmentPatterns = JudgmentTerms
        .Select(term => new Regex($@"\b{Regex.Escape(term)}\b", RegexOptions.Compiled | RegexOptions.CultureInvariant))
        .ToArray();

    public static ReplyContentScanResult Scan(string? text)
    {
        if (string.IsNullOrWhiteSpace(text))
        {
            return ReplyContentScanResult.Empty;
        }

        var findings = new List<ReplyContentFinding>();

        foreach (var sentence in SplitSentences(text))
        {
            var lower = sentence.ToLowerInvariant();

            if (!ProtectiveContext.IsMatch(sentence))
            {
                foreach (var (id, label, pattern) in HarmPatterns)
                {
                    if (!pattern.IsMatch(sentence))
                    {
                        continue;
                    }

                    findings.Add(new ReplyContentFinding(
                        Kind: ReplyContentFindingKind.Harm,
                        Level: GuardLevel.Critical,
                        Signature: SignatureHarm,
                        Marker: id,
                        ReferentKind: "harm",
                        Referent: label,
                        Sentence: TrimSentence(sentence),
                        Reason: $"Possible {label} in a model reply. Review before acting on it."));
                    break;
                }
            }

            if (IsJudgment(lower))
            {
                continue;
            }

            var referent = FindReferent(sentence);
            if (referent is null)
            {
                continue;
            }

            var hedge = FindLongestMarker(lower, ConfidenceMarkers);
            if (hedge is not null)
            {
                findings.Add(new ReplyContentFinding(
                    Kind: ReplyContentFindingKind.UnverifiedConfidence,
                    Level: GuardLevel.Warning,
                    Signature: SignatureUnverified,
                    Marker: hedge,
                    ReferentKind: referent.Value.Kind,
                    Referent: referent.Value.Text,
                    Sentence: TrimSentence(sentence),
                    Reason:
                        $"\"{hedge}\" is attached to {referent.Value.What} ({referent.Value.Text}), " +
                        "so this is a checkable fact stated without a source."));
                continue;
            }

            var certainty = FindLongestMarker(lower, FalseCertaintyMarkers);
            if (certainty is not null && !HasCitation.IsMatch(sentence))
            {
                findings.Add(new ReplyContentFinding(
                    Kind: ReplyContentFindingKind.FalseCertainty,
                    Level: GuardLevel.Warning,
                    Signature: SignatureFalseCertainty,
                    Marker: certainty,
                    ReferentKind: referent.Value.Kind,
                    Referent: referent.Value.Text,
                    Sentence: TrimSentence(sentence),
                    Reason:
                        $"\"{certainty}\" claims verification for {referent.Value.What} ({referent.Value.Text}) " +
                        "without a URL or file:line citation."));
            }
        }

        return new ReplyContentScanResult(NeverBlocks, findings);
    }

    public static string Describe(ReplyContentScanResult result)
    {
        if (!result.Flagged)
        {
            return string.Empty;
        }

        var sb = new StringBuilder();
        sb.Append(result.Findings.Count == 1
            ? "1 content flag on this reply. "
            : $"{result.Findings.Count} content flags on this reply. ");
        sb.Append("Advisory only — the text was not blocked. Verify before acting.");
        var i = 1;
        foreach (var f in result.Findings.Take(6))
        {
            sb.AppendLine();
            sb.Append(i++).Append(". [").Append(f.Kind).Append("] ")
                .Append(f.ReferentKind).Append(": ").Append(f.Referent)
                .Append(" — via \"").Append(f.Marker).Append('"');
        }

        if (result.Findings.Count > 6)
        {
            sb.AppendLine().Append("… +").Append(result.Findings.Count - 6).Append(" more");
        }

        return sb.ToString();
    }

    public static IEnumerable<GuardObservation> ToObservations(
        ReplyContentScanResult result,
        string provider,
        string subject)
    {
        if (!result.Flagged)
        {
            yield break;
        }

        foreach (var group in result.Findings.GroupBy(f => f.Signature))
        {
            var first = group.First();
            var title = first.Kind switch
            {
                ReplyContentFindingKind.Harm => "Harmful content pattern in reply",
                ReplyContentFindingKind.FalseCertainty => "Unsourced certainty in reply",
                _ => "Unsupported confidence in reply",
            };
            var level = group.Any(f => f.Level == GuardLevel.Critical)
                ? GuardLevel.Critical
                : GuardLevel.Warning;
            var detail = Describe(new ReplyContentScanResult(NeverBlocks, group.ToList()));
            yield return new GuardObservation(
                provider,
                Source,
                group.Key,
                title,
                detail,
                level,
                Options: null,
                ActionKind: ActionKind,
                Subject: string.IsNullOrWhiteSpace(subject) ? "Reply" : subject);
        }
    }

    private static string StripCode(string text)
    {
        var s = Regex.Replace(text, @"```[\s\S]*?```", "\n");
        s = Regex.Replace(s, @"~~~[\s\S]*?~~~", "\n");
        s = Regex.Replace(s, @"`[^`\n]*`", " ");
        return s;
    }

    private static IEnumerable<string> SplitSentences(string text) =>
        Regex.Split(StripCode(text), @"(?<=[.!?])\s+|\n+")
            .Select(part => part.Trim())
            .Where(part => part.Length > 0);

    private static string? FindLongestMarker(string lowerSentence, string[] markers)
    {
        string? found = null;
        foreach (var marker in markers)
        {
            var at = lowerSentence.IndexOf(marker, StringComparison.Ordinal);
            if (at < 0)
            {
                continue;
            }

            var before = at == 0 ? '\0' : lowerSentence[at - 1];
            if (before is >= 'a' and <= 'z' or >= '0' and <= '9')
            {
                continue;
            }

            if (found is null || marker.Length > found.Length)
            {
                found = marker;
            }
        }

        return found;
    }

    private static (string Kind, string What, string Text)? FindReferent(string sentence)
    {
        foreach (var (kind, what, pattern) in CheckableReferents)
        {
            var match = pattern.Match(sentence);
            if (match.Success)
            {
                return (kind, what, match.Value.Trim());
            }
        }

        return null;
    }

    private static bool IsJudgment(string lowerSentence) =>
        JudgmentPatterns.Any(p => p.IsMatch(lowerSentence));

    private static string TrimSentence(string sentence) =>
        sentence.Length <= 220 ? sentence : sentence[..217] + "…";
}

public enum ReplyContentFindingKind
{
    UnverifiedConfidence,
    FalseCertainty,
    Harm,
}

public sealed record ReplyContentFinding(
    ReplyContentFindingKind Kind,
    GuardLevel Level,
    string Signature,
    string Marker,
    string ReferentKind,
    string Referent,
    string Sentence,
    string Reason);

public sealed record ReplyContentScanResult(bool Blocked, IReadOnlyList<ReplyContentFinding> Findings)
{
    public static ReplyContentScanResult Empty { get; } = new(ReplyContentPolicy.NeverBlocks, []);

    public bool Flagged => Findings.Count > 0;
}
