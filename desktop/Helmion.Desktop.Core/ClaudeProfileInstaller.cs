namespace Helmion.Desktop.Core;

/// <summary>
/// Installs a Helmion Shareable Template Profile into the user's Claude Code
/// configuration directory (~/.claude/).
///
/// Safety rules:
/// - Never overwrites an existing file without explicit user consent.
/// - Never reads existing credential values.
/// - Only writes files that are listed in the install plan preview.
/// - Skills are always written to new sub-directories; existing ones are not touched.
/// </summary>
public static class ClaudeProfileInstaller
{
    private static readonly string ClaudeDir =
        Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".claude");

    private static readonly string SkillsDir = Path.Combine(ClaudeDir, "skills");

    /// <summary>Returns true if the ~/.claude directory exists (Claude Code is installed).</summary>
    public static bool IsClaudePresent() => Directory.Exists(ClaudeDir);

    /// <summary>
    /// Describes what would be installed — call this BEFORE <see cref="InstallAsync"/>
    /// to show the user an exact preview.
    /// </summary>
    public static InstallPreview GetPreview()
    {
        var items = new List<InstallItem>();

        foreach (var (relPath, _) in TemplateFiles())
        {
            var targetPath = Path.Combine(ClaudeDir, relPath);
            items.Add(new InstallItem(
                relPath,
                targetPath,
                File.Exists(targetPath) ? InstallAction.WouldOverwrite : InstallAction.NewFile));
        }

        return new InstallPreview(items, ClaudeDir, IsClaudePresent());
    }

    /// <summary>
    /// Writes the template files to ~/.claude/.
    /// Only files listed in <paramref name="approvedPaths"/> are written.
    /// </summary>
    /// <param name="overwriteExisting">
    /// Default false: an existing file is NEVER replaced, because these targets are
    /// living user documents. LESSONS.md and LEARNINGS.md accumulate the user's own
    /// entries; a blind template write destroys them. On 2026-07-28 a caller passed a
    /// hardcoded approval set and truncated both back to their templates, losing real
    /// entries permanently — there was no backup. Overwriting now requires an explicit
    /// opt-in AND leaves a timestamped .bak beside the original.
    /// </param>
    public static async Task<InstallResult> InstallAsync(
        IReadOnlySet<string> approvedPaths,
        CancellationToken cancellationToken = default,
        bool overwriteExisting = false)
    {
        if (!IsClaudePresent())
        {
            return new InstallResult(false, "~/.claude directory not found. Install Claude Code first.", []);
        }

        Directory.CreateDirectory(SkillsDir);

        var written = new List<string>();
        var skipped = new List<string>();
        var preserved = new List<string>();

        foreach (var (relPath, content) in TemplateFiles())
        {
            cancellationToken.ThrowIfCancellationRequested();

            if (!approvedPaths.Contains(relPath))
            {
                skipped.Add(relPath);
                continue;
            }

            var targetPath = Path.Combine(ClaudeDir, relPath);
            var dir = Path.GetDirectoryName(targetPath);
            if (!string.IsNullOrEmpty(dir)) Directory.CreateDirectory(dir);

            if (File.Exists(targetPath))
            {
                if (!overwriteExisting)
                {
                    preserved.Add(relPath);
                    continue;
                }

                var backupPath = $"{targetPath}.{DateTime.Now:yyyyMMdd-HHmmss}.bak";
                File.Copy(targetPath, backupPath, overwrite: false);
            }

            await File.WriteAllTextAsync(targetPath, content, cancellationToken);
            written.Add(relPath);
        }

        var message = $"Installed {written.Count} files. Skipped {skipped.Count}.";
        if (preserved.Count > 0)
        {
            message += $" Left {preserved.Count} existing file(s) untouched: {string.Join(", ", preserved)}.";
        }

        return new InstallResult(true, message, written);
    }

    // ── Template content ───────────────────────────────────────────────────────

    private static IEnumerable<(string RelPath, string Content)> TemplateFiles()
    {
        yield return ("HELMION_CLAUDE.md", ClaudeMdTemplate);
        yield return ("BASE_RULES.md", BaseRulesTemplate);
        yield return ("LEARNINGS.md", LearningsTemplate);
        yield return ("LESSONS.md", LessonsTemplate);
        yield return ("skills/brain-dump-processor/SKILL.md", BrainDumpSkill);
        yield return ("skills/sprint-pack-handoff/SKILL.md", SprintPackHandoffSkill);
        yield return ("skills/verify-by-durable-side-effect/SKILL.md", VerifyByDurableSideEffectSkill);
        yield return ("skills/cite-or-shut-up/SKILL.md", CiteOrShutUpSkill);
        yield return ("skills/concurrent-session-hygiene/SKILL.md", ConcurrentSessionHygieneSkill);
        yield return ("skills/go-no-go-stall-detection/SKILL.md", GoNoGoStallDetectionSkill);
    }

    // ── Template strings ───────────────────────────────────────────────────────

    private const string ClaudeMdTemplate = """
        # Helmion Claude Rules — Read First Every Session

        These rules apply every session, every model, every project.
        Read them before any tool call or answer.

        ## 0. HONESTY OVERRIDES EVERYTHING

        - If you don't know something, say "I do not know," then offer to check.
        - Separate what you are certain of from what you are guessing.
        - Acknowledge mistakes plainly.
        - When you ship something it actually works, or you name exactly what doesn't.

        ## 0.001. SOURCE OF TRUTH + FULL TRACING

        Every factual claim requires a primary-source citation AND an end-to-end trace.

        **GATE 1 — SOURCE OF TRUTH**
        - Code → file:line
        - API → response body + endpoint
        - Vendor docs → URL + quoted sentence
        - NOT "memory says," NOT "handoff says," NOT "I recall"

        **GATE 2 — FULL TRACING**
        For any multi-stage claim, draw the chain explicitly:
          Stage A → Stage B → Stage C → … → N
        A chain with one uncited arrow IS the lie.

        ## 0.002. CITE OR SHUT UP

        If you cannot cite a primary source, do not make the claim.
        Banned: "probably," "I think," "should be," "it looks like," "if I recall."

        ## 0.003. PARALLEL BY DEFAULT

        When two or more sub-tasks have no dependency on each other, run them
        concurrently. Never serialize what can fan out.

        ## 1. NO GUESSING — research-first when uncertain

        Before answering uncertain questions: check primary sources first.
        "Probably" and "I think" are banned. Research before answering.

        ## Self-improvement flywheel

        After resolving a blocker or correcting a mistake:
        1. **Identify** the root cause
        2. **Name** the lesson in one sentence
        3. **Log** it in LESSONS.md (newest at top)
        4. **Propose** a rule if it should never happen again
        5. **Verify** the fix with primary-source evidence

        Canonical: ~/.claude/BASE_RULES.md
        Lessons log: ~/.claude/LESSONS.md
        Learnings log: ~/.claude/LEARNINGS.md
        """;

    private const string BaseRulesTemplate = """
        # BASE RULES — Read First, Every Session

        These two rules outrank everything else.

        ═══════════════════════════════════════════════════════════════════
        RULE 1 — SURGICAL SOURCE-OF-TRUTH TRACING, END TO END
        ═══════════════════════════════════════════════════════════════════

        Every multi-stage claim must be traced explicitly, end to end, with a
        PRIMARY-SOURCE citation on every arrow.

          Stage A  →  Stage B  →  Stage C  →  ...  →  Stage N
           cite       cite        cite              cite

        What counts as a primary source:
          - Code → file:line
          - API → response body + endpoint URL + HTTP status
          - Vendor docs → URL + the quoted sentence
          - DB → the query and the row

        A chain with ONE uncited arrow IS the lie.

        ═══════════════════════════════════════════════════════════════════
        RULE 2 — CITE OR SHUT UP
        ═══════════════════════════════════════════════════════════════════

        If I cannot cite a primary source right now, I do not make the claim.

        Banned: "probably" / "I think" / "should be" / "it looks like" /
                "if I recall" / "based on memory" / "the handoff says"
        """;

    private const string LearningsTemplate = """
        # LEARNINGS.md

        New workflow discoveries, earned skills, and technical breakthroughs.
        Newest entries at top.

        Format:
        - [YYYY-MM-DD] One-sentence summary of what was learned.
          (source: file:line or URL, context)

        ## Example

        - [2026-01-01] The working method for X is now a skill: skills/x/SKILL.md.
          Core: do A, not B, because C. (source: project/file.ts:42)
        """;

    private const string LessonsTemplate = """
        # LESSONS.md

        Corrections and misunderstandings that must not be repeated.
        Logged immediately after each correction. Newest entries at top.

        Format:
        ## YYYY-MM-DD — Short title of the lesson

        **What went wrong:** Description.
        **The rule:** What to do instead.
        **Why it matters:** Context.

        ## Example

        ## 2026-01-01 — Always verify before claiming done

        **What went wrong:** Reported a feature as shipped without checking the live endpoint.
        **The rule:** "Shipped" requires a primary-source cite: fetched URL + HTTP 200 + new content.
        **Why it matters:** Unchecked claims waste review time and destroy trust.
        """;

    private const string BrainDumpSkill = """
        ---
        name: brain-dump-processor
        description: >
          Converts a raw voice or text brain dump into a structured action list.
          Trigger when the user pastes a stream-of-consciousness note and wants
          it organized into: decisions made, tasks, blockers, and open questions.
        ---

        # Brain Dump Processor

        ## When to use
        User pastes or says a long, unstructured thought. Goal: clarity, not summary.

        ## Steps
        1. Read the entire input without interrupting.
        2. Extract: **Decisions** (already made), **Tasks** (to do), **Blockers** (stuck), **Questions** (open).
        3. Return a clean four-section list.
        4. Ask: "Is anything missing from this list?"

        ## Hard rules
        - Do not add opinions or suggestions unless asked.
        - Do not reorder the user's priorities.
        - Flag ambiguity with [UNCLEAR] — do not guess intent.
        """;

    private const string SprintPackHandoffSkill = """
        ---
        name: sprint-pack-handoff
        description: >
          Packages the current session's work into a clean handoff document for
          the next agent or session. Trigger when the user says "wrap up",
          "handoff", or "end of session".
        ---

        # Sprint Pack Handoff

        ## When to use
        End of a work session. Creates a handoff that the next session can trust.

        ## Steps
        1. List everything completed (with primary-source cites).
        2. List everything in-progress and its exact current state.
        3. List open blockers with their last known status.
        4. State the single most important next action.
        5. Note anything that needs human verification before the next agent proceeds.

        ## Hard rules
        - Every "done" claim must have a cite (file:line, URL, or log line).
        - "In progress" ≠ "done." Name the exact remaining step.
        - Never mark something done because it was started.
        """;

    private const string VerifyByDurableSideEffectSkill = """
        ---
        name: verify-by-durable-side-effect
        description: >
          Requires proof of work via a durable, observable side effect before
          accepting a claim. Use when verifying that a code change, deploy,
          or configuration update actually took effect.
        ---

        # Verify by Durable Side Effect

        ## The rule
        A claim is only verified when a durable, independent side effect proves it.

        ## What counts as durable evidence
        - Fetching the live URL and seeing the new content in the response body.
        - Reading the database row that was supposed to be written.
        - Running the test that was supposed to pass and seeing GREEN.
        - Checking git log and seeing the commit hash in the remote.

        ## What does NOT count
        - The tool said "success."
        - The process exited 0.
        - The log said "deployed."
        - Memory from a prior session.

        ## Hard rules
        - One durable side effect per claim. No "probably deployed."
        - If the side effect cannot be observed right now, say so explicitly.
        """;

    private const string CiteOrShutUpSkill = """
        ---
        name: cite-or-shut-up
        description: >
          Enforces the citation discipline: if you cannot cite a primary source,
          do not make the claim. Trigger when you catch yourself about to say
          "probably," "I think," or "should be."
        ---

        # Cite or Shut Up

        ## The rule
        No claim without a primary source. Period.

        ## Banned phrases
        - "probably" / "I think" / "should be"
        - "it looks like" / "if I recall" / "based on memory"
        - "the handoff says" (handoffs are secondary — re-verify against primary)

        ## What to say instead
        "I do not know — let me check [specific source]."

        Then check. Then cite. Then answer.

        ## Primary source examples
        - Code claim → file:line
        - API behavior → curl output + HTTP status
        - Vendor feature → docs URL + quoted sentence
        - DB state → the query + the row
        """;

    private const string ConcurrentSessionHygieneSkill = """
        ---
        name: concurrent-session-hygiene
        description: >
          Rules for working safely when multiple AI sessions are running
          simultaneously on the same project. Trigger when the user has more than
          one agent open, or when file conflicts appear.
        ---

        # Concurrent Session Hygiene

        ## The problem
        Two sessions writing the same file → silent overwrites, lost work.

        ## Rules
        1. Name your session's working branch at the start. Never commit to main without a PR.
        2. Check git status before every commit.
        3. If another session touched a file you need, read it fresh before editing.
        4. Communicate state changes via commit messages, not memory.
        5. When in doubt, ask the user which session has authority over a file.

        ## Signs of conflict
        - "The file was modified externally" warnings.
        - Unexpected changes in git diff that you didn't make.
        - Test failures on code you didn't touch.
        """;

    private const string GoNoGoStallDetectionSkill = """
        ---
        name: go-no-go-stall-detection
        description: >
          Detects when a session has stalled — no meaningful progress in the last
          N turns — and proposes a concrete next action. Trigger when the user
          seems stuck or when the same problem has appeared more than twice.
        ---

        # Go / No-Go Stall Detection

        ## Signs of a stall
        - The same error has appeared 3+ times.
        - The last 3 turns were all diagnosis, no action.
        - The user has said "why isn't this working" twice.
        - You have proposed the same fix more than once.

        ## What to do when stalled
        1. Name the stall explicitly: "We have tried X three times and it hasn't worked."
        2. Propose a different approach — not the same fix again.
        3. If no alternative exists, escalate: "I need more information. What is [specific unknown]?"
        4. Never pretend progress is happening when it isn't.

        ## Hard rule
        A stall acknowledged and broken is progress.
        A stall hidden behind "almost there" is a waste of the user's time.
        """;
}

// ── Result types ───────────────────────────────────────────────────────────────

public sealed record InstallPreview(
    IReadOnlyList<InstallItem> Items,
    string TargetDirectory,
    bool ClaudeDetected);

public sealed record InstallItem(
    string RelativePath,
    string AbsolutePath,
    InstallAction Action);

public enum InstallAction { NewFile, WouldOverwrite }

public sealed record InstallResult(
    bool Success,
    string Message,
    IReadOnlyList<string> WrittenPaths);
