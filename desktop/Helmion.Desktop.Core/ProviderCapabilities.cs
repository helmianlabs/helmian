namespace Helmion.Desktop.Core;

/// <summary>
/// One row of the + menu, as it exists FOR A PARTICULAR MAESTRO.
/// </summary>
/// <param name="Supported">
/// False means that provider's own CLI genuinely does not have this. The row is
/// still shown, greyed, carrying <paramref name="WhyNot"/> — hiding it would
/// leave the operator wondering where a button went instead of learning what
/// their model cannot do.
/// </param>
/// <param name="HowItWorks">
/// The provider's REAL syntax and paths, not a paraphrase. This is the whole
/// point of the feature: the menu has to match what that CLI actually does, so
/// the text has to carry the actual `@file` form, the actual config path, the
/// actual install command.
/// </param>
public sealed record ProviderCapability(
    PlusMenuKind Kind,
    bool Supported,
    string Label,
    string OneLiner,
    string HowItWorks,
    string? WhyNot = null)
{
    /// <summary>Taken from the shared catalog so one kind is one glyph everywhere.</summary>
    public string Icon => PlusMenuCatalog.For(Kind).Icon;

    /// <summary>Dimmed when the provider genuinely does not have this.</summary>
    public double Opacity => Supported ? 1.0 : 0.45;

    /// <summary>
    /// The second line under the label. For a supported capability that is the
    /// provider's real syntax; for an unsupported one it is the reason, so the
    /// row is never blank and never silently missing.
    /// </summary>
    public string Detail => Supported
        ? HowItWorks
        : (WhyNot ?? "This Maestro's CLI does not have this.");
}

/// <summary>
/// What the + menu contains for each Maestro.
///
/// TROY'S REQUIREMENT, 2026-07-30: "whoever the Maestro is, that's whose skills,
/// connectors, plugins, all that, exact copied and populated and working." So this
/// is not one list with a provider label on top — it is a different list per
/// provider, carrying that provider's own syntax.
///
/// EVERY LINE BELOW COMES FROM A PRIMARY SOURCE, cited in the block above each
/// provider. Where a capability could not be confirmed from that provider's own
/// documentation it is marked UNKNOWN in the text rather than assumed present,
/// because a menu that offers a feature the model does not have is worse than a
/// menu that admits it does not know.
///
/// UNVERIFIED PROVIDERS RETURN NOTHING. <see cref="For"/> answers null for a
/// coordinator whose capabilities have not been researched, and the window shows
/// a plain "not mapped yet" row. It does NOT fall back to another provider's
/// list — showing Claude's menu while Grok is the Maestro is the same class of
/// lie as a red card over healthy text.
/// </summary>
public static class ProviderCapabilityCatalog
{
    /// <summary>
    /// The capability rows for a coordinator, or null when that coordinator's
    /// feature set has not been established from its own documentation.
    /// </summary>
    public static IReadOnlyList<ProviderCapability>? For(string? maestro) =>
        MaestroKey.Normalize(maestro) switch
        {
            MaestroKey.Grok => Grok,
            MaestroKey.Gemini => Gemini,
            MaestroKey.Claude => Claude,
            MaestroKey.OpenAi => Codex,
            _ => null,
        };

    /// <summary>True when this Maestro's menu is real rather than a placeholder.</summary>
    public static bool IsMapped(string? maestro) => For(maestro) is not null;

    // ── Grok ──────────────────────────────────────────────────────────────────
    //
    // SOURCES, fetched 2026-07-30:
    //   https://docs.x.ai/build/overview  — "Grok Build is a powerful and
    //     extensible coding agent."
    //   https://github.com/xai-org/grok-build  (Apache-2.0, binary `grok`)
    //   repo crates/codegen/xai-grok-pager/docs/user-guide/{01,04,07,08,09,18}
    //
    // NOTE: many third-party repos are named "grok-cli" and are NOT xAI's. The
    // official tool is Grok Build.
    private static readonly IReadOnlyList<ProviderCapability> Grok =
    [
        new(PlusMenuKind.Upload, true,
            "Attach a file",
            "Point Grok at a file, a line range, or a whole folder from inside your prompt.",
            "Grok Build uses @ in the prompt: @src/main.rs, a line range with "
            + "@src/main.rs:10-50, a directory with @src/, or a hidden file with @!.env. "
            + "No size limit is documented."),

        new(PlusMenuKind.Connector, true,
            "Connectors (MCP)",
            "Let Grok reach an outside service — a database, an API, your tools.",
            "grok mcp add <name> -- <command>, or --transport http|sse for a remote one. "
            + "Stored under [mcp_servers.<name>] in ~/.grok/config.toml, or .grok/config.toml "
            + "for this project only. Grok's own TUI lists them with /mcps."),

        new(PlusMenuKind.Plugin, true,
            "Plugins",
            "Install a bundle someone published: skills, commands, agents, hooks and MCP servers together.",
            "grok plugin install <name> --trust. Plugins live in .grok/plugins/ for the "
            + "project or ~/.grok/plugins/ for you. Marketplaces are catalogs published on "
            + "GitHub or git. Note the --trust flag: Grok makes you say so out loud."),

        new(PlusMenuKind.Skill, true,
            "Skills",
            "Teach Grok a procedure of your own and call it by name.",
            "A skill is a folder holding a SKILL.md with name and description in its "
            + "frontmatter, at ~/.grok/skills/<name>/ or ./.grok/skills/. Invoke it as "
            + "/<skill-name>; Grok may also reach for it on its own."),
    ];

    // ── Gemini ────────────────────────────────────────────────────────────────
    //
    // SOURCES, fetched 2026-07-30:
    //   https://github.com/google-gemini/gemini-cli/blob/main/docs/tools/mcp-server.md
    //   https://google-gemini.github.io/gemini-cli/docs/extensions/
    //   https://geminicli.com/docs/reference/commands
    //   https://geminicli.com/docs/cli/skills/
    private static readonly IReadOnlyList<ProviderCapability> Gemini =
    [
        new(PlusMenuKind.Upload, true,
            "Attach a file",
            "Point Gemini at a file or a whole folder from inside your prompt.",
            "Gemini CLI uses @path — @src/main.ts for one file, @src/ to read a directory "
            + "recursively. It skips node_modules and .env by default, and its own docs warn "
            + "that binary or very large files may be skipped or truncated. No numeric size "
            + "limit is documented. Unlike Grok, there is no line-range form."),

        new(PlusMenuKind.Connector, true,
            "Connectors (MCP)",
            "Let Gemini reach an outside service — a database, an API, your tools.",
            "gemini mcp add <name> <commandOrUrl>. Stored under the mcpServers key in "
            + "~/.gemini/settings.json, or .gemini/settings.json for this project. "
            + "Listed in Gemini's own CLI with /mcp."),

        new(PlusMenuKind.Plugin, true,
            "Extensions",
            "Install a bundle someone published — Gemini calls these extensions, not plugins.",
            "gemini extensions install <github-url>. They land in ~/.gemini/extensions with a "
            + "gemini-extension.json manifest, and can carry prompts, MCP servers, custom "
            + "commands, themes, hooks, sub-agents and skills. Listed with /extensions. "
            + "There is no --trust step the way Grok has."),

        new(PlusMenuKind.Skill, true,
            "Skills and commands",
            "Teach Gemini a procedure of your own — it accepts two different formats.",
            "Skills are a SKILL.md with name and description in frontmatter, under "
            + "~/.gemini/skills/ or .gemini/skills/, listed with /skills list. Separately, "
            + "custom commands are TOML files under ~/.gemini/commands/ or "
            + "<project>/.gemini/commands/, reloaded with /commands reload."),
    ];

    // ── Claude ────────────────────────────────────────────────────────────────
    //
    // SOURCES, fetched 2026-07-30:
    //   https://code.claude.com/docs/en/common-workflows  (@ mentions, images)
    //   https://code.claude.com/docs/en/mcp               (scopes, mcpServers)
    //   https://code.claude.com/docs/en/discover-plugins  (marketplaces)
    //   https://code.claude.com/docs/en/skills            (SKILL.md, merge note)
    private static readonly IReadOnlyList<ProviderCapability> Claude =
    [
        new(PlusMenuKind.Upload, true,
            "Attach a file or image",
            "Put a file's actual contents in front of Claude, or hand it a screenshot.",
            "Claude Code uses @ in the prompt and it INLINES THE FILE'S CONTENTS — @src/auth.js "
            + "puts the whole file in the conversation, while @src/components gives a directory "
            + "listing. It also reads MCP resources as @server:resource. Images go in three ways: "
            + "drag one onto the window, paste with Ctrl+V, or give it a path. No size limit or "
            + "format list is documented."),

        new(PlusMenuKind.Connector, true,
            "Connectors (MCP)",
            "Let Claude reach an outside service — a database, GitHub, your calendar.",
            "claude mcp add <name> -- <command> for a local one, or --transport http|sse <name> "
            + "<url> for a remote one. Three scopes: local and user land in ~/.claude.json, "
            + "project lands in .mcp.json at the repo root so it can be committed. The key is "
            + "mcpServers. Claude's own /mcp panel handles auth and shows tool counts."),

        new(PlusMenuKind.Plugin, true,
            "Plugins",
            "Install a bundle someone published: skills, commands, agents, hooks and MCP servers together.",
            "First add a catalog — /plugin marketplace add anthropics/claude-code — then "
            + "/plugin install <name>@<marketplace>. Non-interactively: claude plugin install "
            + "<name> --scope project. The /plugin manager has Discover, Installed, Marketplaces "
            + "and Errors tabs. Installed copies are cached at ~/.claude/plugins/cache."),

        new(PlusMenuKind.Skill, true,
            "Skills",
            "Teach Claude a procedure of your own and call it by name.",
            "A SKILL.md with name and description in its frontmatter, at "
            + "~/.claude/skills/<name>/ for you or .claude/skills/<name>/ for the project. "
            + "Invoke it as /<skill-name>. Worth knowing: custom commands were MERGED into "
            + "skills — an old .claude/commands/deploy.md and a new .claude/skills/deploy/SKILL.md "
            + "both give you /deploy, and existing command files keep working."),
    ];

    // ── OpenAI / Codex ────────────────────────────────────────────────────────
    //
    // The "OpenAI" coordinator in Helmion's dropdown is the Codex CLI.
    //
    // SOURCES, fetched 2026-07-30. NOTE: github.com/openai/codex/docs/*.md are now
    // stubs that redirect to developers.openai.com, which 308s to learn.chatgpt.com.
    //   https://learn.chatgpt.com/docs/developer-commands  (@ mention, /mention)
    //   https://learn.chatgpt.com/docs/codex/cli           (--image)
    //   https://learn.chatgpt.com/docs/extend/mcp          (codex mcp add, TOML)
    //   https://learn.chatgpt.com/docs/plugins             (/plugins browser)
    //   https://learn.chatgpt.com/docs/build-skills        (SKILL.md, .agents/skills)
    private static readonly IReadOnlyList<ProviderCapability> Codex =
    [
        new(PlusMenuKind.Upload, true,
            "Attach a file or image",
            "Hand Codex a file path or a screenshot — note it takes the PATH, not the contents.",
            "Type @ to fuzzy-search the workspace and Codex inserts THE FILE'S PATH into your "
            + "prompt — not its contents, which is the opposite of Claude Code. /mention <path> "
            + "does the same. Images: start with codex --image, or paste one into the composer. "
            + "Drag-and-drop, accepted formats and any size limit are undocumented."),

        new(PlusMenuKind.Connector, true,
            "Connectors (MCP)",
            "Let Codex reach an outside service — a database, an API, your tools.",
            "codex mcp add <name> -- <command>, for example codex mcp add context7 -- npx -y "
            + "@upstash/context7-mcp. Stored as a TOML table [mcp_servers.<name>] in "
            + "~/.codex/config.toml, or .codex/config.toml for a trusted project. "
            + "codex mcp list shows them; /mcp opens the panel."),

        new(PlusMenuKind.Plugin, true,
            "Plugins",
            "Install a bundle that can carry skills, connectors, or both.",
            "/plugins opens the browser, grouped into marketplace tabs; install, uninstall and "
            + "toggle from there. A plugin can carry skills, MCP-backed connectors, browser "
            + "extensions, hooks and scheduled-task templates, and ChatGPT and Codex share one "
            + "plugin directory. A shell install command and the on-disk path are not documented."),

        new(PlusMenuKind.Skill, true,
            "Skills",
            "Teach Codex a procedure of your own and mention it by name.",
            "A SKILL.md with name and description in its frontmatter. Codex looks in "
            + ".agents/skills here, then in parent folders, then $REPO_ROOT/.agents/skills, then "
            + "$HOME/.agents/skills, then /etc/codex/skills. Run /skills, or type $ to mention "
            + "one. Careful: ~/.codex/skills is repeated all over the web and is NOT in OpenAI's "
            + "own docs — treat it as unconfirmed."),
    ];
}
