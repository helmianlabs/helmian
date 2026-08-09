using System.Text.RegularExpressions;

namespace Helmion.Desktop.Core;

/// <summary>
/// Parse @Agent mentions from Maestro manager input and resolve them against
/// the live session shelf. Pure rules so the smoke suite can prove routing.
/// </summary>
public static partial class MaestroMentions
{
    /// <summary>
    /// @Name tokens: letters, digits, underscore, hyphen, space (for "Claude 2").
    /// Stops at another @, newline, or end. "@all" is special.
    /// </summary>
    [GeneratedRegex(@"@(?<tag>all|[A-Za-z0-9][A-Za-z0-9_\- ]{0,39}?)(?=\s|@|$)", RegexOptions.CultureInvariant)]
    private static partial Regex MentionRegex();

    public sealed record ParseResult(
        IReadOnlyList<string> Tags,
        bool MentionsAll,
        string BodyWithoutMentions,
        bool HasMentions);

    public static ParseResult Parse(string? text)
    {
        var raw = text ?? string.Empty;
        var tags = new List<string>();
        var all = false;
        foreach (Match m in MentionRegex().Matches(raw))
        {
            var tag = m.Groups["tag"].Value.Trim();
            if (tag.Length == 0) continue;
            if (string.Equals(tag, "all", StringComparison.OrdinalIgnoreCase))
            {
                all = true;
                continue;
            }
            if (!tags.Any(t => string.Equals(t, tag, StringComparison.OrdinalIgnoreCase)))
                tags.Add(tag);
        }

        var body = MentionRegex().Replace(raw, " ").Trim();
        body = Regex.Replace(body, @"\s{2,}", " ").Trim();
        return new ParseResult(tags, all, body, all || tags.Count > 0);
    }

    /// <summary>
    /// Resolve mention tags to worker sessions (never the manager itself).
    /// Matching (case-insensitive): exact name → compact name (spaces stripped) →
    /// name starts-with tag → tag starts-with name → pill label → pill+number (grok1).
    /// @all returns every non-manager worker.
    /// </summary>
    public static IReadOnlyList<AgentSession> ResolveWorkers(
        ParseResult parse,
        IEnumerable<AgentSession> sessions,
        AgentSession? manager)
    {
        var workers = sessions
            .Where(s => !s.IsManager && (manager is null || !ReferenceEquals(s, manager)))
            // Phone "Mobile control" session is not a parallel coding peer for @all.
            .Where(s => !s.Name.Contains("Mobile control", StringComparison.OrdinalIgnoreCase))
            .ToList();

        if (parse.MentionsAll)
            return workers;

        var resolved = new List<AgentSession>();
        foreach (var tag in parse.Tags)
        {
            var hit = MatchWorker(workers, tag);
            if (hit is not null && !resolved.Contains(hit))
                resolved.Add(hit);
        }

        return resolved;
    }

    private static string Compact(string s) =>
        string.Concat((s ?? string.Empty).Where(c => !char.IsWhiteSpace(c)));

    private static AgentSession? MatchWorker(IReadOnlyList<AgentSession> workers, string tag)
    {
        if (string.IsNullOrWhiteSpace(tag)) return null;
        var t = tag.Trim();
        var tc = Compact(t);

        // Exact name
        var hit = workers.FirstOrDefault(s =>
            string.Equals(s.Name, t, StringComparison.OrdinalIgnoreCase));
        if (hit is not null) return hit;

        // Compact name: "Grok 1" ↔ "grok1", "Claude 2" ↔ "claude2"
        hit = workers.FirstOrDefault(s =>
            string.Equals(Compact(s.Name), tc, StringComparison.OrdinalIgnoreCase));
        if (hit is not null) return hit;

        // Name starts with tag or tag starts with name (unique-ish)
        hit = workers.FirstOrDefault(s =>
            s.Name.StartsWith(t, StringComparison.OrdinalIgnoreCase)
            || t.StartsWith(s.Name, StringComparison.OrdinalIgnoreCase));
        if (hit is not null) return hit;

        // Pill label exact
        hit = workers.FirstOrDefault(s =>
            string.Equals(s.PillLabel, t, StringComparison.OrdinalIgnoreCase));
        if (hit is not null) return hit;

        // Pill + optional digits: @grok1 → first Grok pill whose compact name matches or first Grok
        var pillDigits = System.Text.RegularExpressions.Regex.Match(
            t, @"^(?<pill>[A-Za-z]+)(?<n>\d*)$");
        if (pillDigits.Success)
        {
            var pill = pillDigits.Groups["pill"].Value;
            var n = pillDigits.Groups["n"].Value;
            var ofPill = workers
                .Where(s => string.Equals(s.PillLabel, pill, StringComparison.OrdinalIgnoreCase)
                            || string.Equals(Compact(s.PillLabel), Compact(pill), StringComparison.OrdinalIgnoreCase))
                .ToList();
            if (ofPill.Count == 0) return null;
            if (n.Length == 0) return ofPill[0];
            // Prefer compact name ending with that number, else 1-based index
            hit = ofPill.FirstOrDefault(s =>
                Compact(s.Name).EndsWith(n, StringComparison.OrdinalIgnoreCase));
            if (hit is not null) return hit;
            if (int.TryParse(n, out var idx) && idx >= 1 && idx <= ofPill.Count)
                return ofPill[idx - 1];
            return ofPill[0];
        }

        return null;
    }

    /// <summary>
    /// Short social / identity tasks — do not force Claim/Result or file ownership.
    /// Keeps multi-agent chat natural after @all hey / give yourselves names.
    /// </summary>
    public static bool IsCasualTask(string? taskBody)
    {
        var t = (taskBody ?? string.Empty).Trim();
        if (t.Length == 0) return true;
        if (t.Length > 120) return false;

        // Build / code verbs → full coordination
        if (Regex.IsMatch(t,
                @"\b(create|build|write|implement|fix|deploy|refactor|edit|patch|commit|push|html|css|page|landing|file|code|api|migrate|sql|preview|animate|bounce|ball|game|demo|artifact|image|generate)\b",
                RegexOptions.IgnoreCase | RegexOptions.CultureInvariant))
            return false;

        // Greetings / names / social
        if (Regex.IsMatch(t,
                @"^(hey|hi|hello|yo|sup|thanks|thank you|ok|okay|ping|status)\b",
                RegexOptions.IgnoreCase | RegexOptions.CultureInvariant))
            return true;
        if (Regex.IsMatch(t,
                @"\b(name|names|introduce|greet|say hi|hello|wave|who are you)\b",
                RegexOptions.IgnoreCase | RegexOptions.CultureInvariant))
            return true;

        // Very short non-build messages
        return t.Length <= 40 && !t.Contains('/') && !t.Contains('\\');
    }

    /// <summary>
    /// Exclusive relative folder for this worker on a build dispatch so agents do not
    /// fight over the same path (and so lease fights are per-slice, not whole repo).
    /// </summary>
    public static string WorkerSliceFolder(AgentSession worker)
    {
        var slug = Compact(worker.Name);
        if (string.IsNullOrEmpty(slug)) slug = Compact(worker.PillLabel);
        if (string.IsNullOrEmpty(slug)) slug = "agent";
        return $"artifacts/agent-slices/{slug}";
    }

    /// <summary>
    /// Prompt each worker. Casual tasks = natural reply. Build tasks = slice + lease honesty.
    /// </summary>
    public static string BuildWorkerPrompt(
        string managerName,
        AgentSession worker,
        IReadOnlyList<AgentSession> peers,
        string taskBody)
    {
        var peerLine = peers.Count == 0
            ? "(no other agents on this dispatch)"
            : string.Join(", ", peers.Select(p => $"{p.Name} ({p.PillLabel})"));

        var task = string.IsNullOrWhiteSpace(taskBody)
            ? "(Manager sent only @mentions — ask what they want, then wait.)"
            : taskBody.Trim();

        if (IsCasualTask(task))
        {
            return
                $"[Maestro chat — one short reply]\n" +
                $"You are \"{worker.Name}\" ({worker.PillLabel}). Manager \"{managerName}\" said:\n" +
                $"{task}\n\n" +
                "Reply naturally as yourself in 1–3 sentences.\n" +
                "Do NOT use Claim/Result format.\n" +
                "Do NOT invent file paths or code ownership.\n" +
                "Do NOT call tools unless the manager clearly asked for a tool action.\n" +
                $"Peers online (for context only): {peerLine}.";
        }

        var slice = WorkerSliceFolder(worker);
        return
            $"[Maestro build dispatch — deliver files, not chat]\n" +
            $"You are agent \"{worker.Name}\" ({worker.PillLabel} / {worker.ProviderKey ?? "no route"}).\n" +
            $"Manager \"{managerName}\" assigned work. Peers: {peerLine}.\n" +
            $"YOUR EXCLUSIVE SLICE FOLDER (write only here): {slice}/\n" +
            "Rules:\n" +
            "1. Own only that folder + any files you create under it. Do not edit peers' folders.\n" +
            "2. Start with one line: Ownership: <your slice path>.\n" +
            "3. REQUIRED: write at least one real file under your slice (e.g. index.html) with write_file " +
            "or equivalent. A chat-only answer that describes the work is a FAIL for this dispatch.\n" +
            "4. After writing, call start_project_preview on your file when the task is visual " +
            "(HTML/CSS/JS, UI, animation, page). If preview is blocked, reply with the relative path.\n" +
            "5. If the write lease is held by another process (e.g. claude-code), say BLOCKED with the holder, " +
            "and paste your finished file contents so the manager can save them — do not fight the lease.\n" +
            "6. End with: Result: wrote <path> · preview <opened|path>.\n\n" +
            $"Task from manager:\n{task}";
    }
}
