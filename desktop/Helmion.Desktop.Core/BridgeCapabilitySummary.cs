using System.Text;

namespace Helmion.Desktop.Core;

/// <summary>
/// Turns a bridge <c>commands</c> event into the sentence the + menu shows.
///
/// <para>
/// WHY THIS EXISTS. Both the Skills row and the Plugins row did real work and then
/// threw the answer away. Skills called the bridge, checked only that the event was
/// named <c>commands</c>, and emitted a string written at compile time — so an
/// empty workspace and a workspace with fifty skills produced byte-identical
/// output (MainWindow.PlusMenu.cs:171-181, before this). Plugins never went near
/// the bridge at all: it stat()ed <c>.helmion/plugins.json</c> and printed its SIZE
/// IN BYTES (FirstRunStates.cs:78-95). A file size is not a plugin list.
/// </para>
/// <para>
/// THE PART THAT MATTERS MOST IS THE REFUSALS. <c>src/agent/plugins.mjs</c>
/// <c>evaluateMcpDeclaration</c> fails closed on every branch and the bridge has
/// always sent the verdicts down (<c>src/agent/bridge.mjs:309-317</c>). Until now
/// the desktop reduced that to a list of names, so a plugin whose MCP server was
/// REFUSED looked exactly like one whose server was approved. The gate was doing
/// its job invisibly, which for the operator is indistinguishable from not doing it.
/// </para>
/// <para>
/// IT LIVES IN CORE, WITH NO WINDOW, for the same reason
/// <see cref="FirstRunStates"/> does: a sentence built inside a WPF handler can
/// only be checked by clicking it, and the states nobody clicks are exactly the
/// ones that rot.
/// </para>
/// </summary>
public static class BridgeCapabilitySummary
{
    /// <summary>How many names to spell out before summarising the rest.</summary>
    private const int MaxNamesShown = 12;

    /// <summary>
    /// What the Skills row says, from the command list the bridge actually returned.
    /// </summary>
    /// <param name="requestedWorkspace">
    /// The folder the caller ASKED about. Compared against the folder the bridge
    /// says it scanned: left unchecked, a listing can describe a different project
    /// than the next turn will run in and still look perfectly healthy. That is not
    /// hypothetical — it is what a null workspace argument produced, because the
    /// bridge then answers about the directory it started in, the Helmion repo root
    /// (AgentBridge.cs:236-245).
    /// </param>
    public static PlusOutcome Skills(
        AgentBridgeEvent ev,
        string? requestedWorkspace,
        IReadOnlyList<ExternalSkillEntry>? externalSkills = null)
    {
        ArgumentNullException.ThrowIfNull(ev);

        if (BridgeFailure(ev, "Skills") is { } failure) return failure;

        // Only what the user can actually type. The bridge marks the rest
        // userInvocable:false, and offering one would be advice that does not work.
        var commands = (ev.Commands ?? [])
            .Where(c => c.UserInvocable && !string.IsNullOrWhiteSpace(c.Name))
            .ToList();

        var where = DescribeFolder(ev.Workspace, requestedWorkspace);

        if (commands.Count == 0)
        {
            var empty = new StringBuilder(
                $"No Helmion-executable slash-command skills are defined in {where} yet. "
                + "Add one under .helmion/commands, then press + › Skills again.");
            AppendExternalSkills(empty, externalSkills);
            return new PlusOutcome(
                PlusActionState.Empty,
                empty.ToString());
        }

        var sb = new StringBuilder();
        sb.Append(commands.Count).Append(commands.Count == 1 ? " skill" : " skills")
          .Append(" available in ").Append(where).Append('.');

        foreach (var command in commands.Take(MaxNamesShown))
        {
            sb.Append("\n  /").Append(command.Name);
            if (!string.IsNullOrWhiteSpace(command.Description))
            {
                sb.Append(" — ").Append(Trim(command.Description!, 90));
            }
            if (!string.IsNullOrWhiteSpace(command.Source))
            {
                sb.Append(" [Helmion executable · ").Append(command.Source).Append(']');
            }
        }

        if (commands.Count > MaxNamesShown)
        {
            sb.Append("\n  … and ").Append(commands.Count - MaxNamesShown)
              .Append(" more — type / in the box to see them all.");
        }

        sb.Append("\nType / in the box to run one, or add your own as a SKILL.md "
                  + "under .helmion/commands.");
        AppendExternalSkills(sb, externalSkills);

        return new PlusOutcome(PlusActionState.Succeeded, sb.ToString());
    }

    /// <summary>
    /// What the Plugins row says, from the plugin records the bridge returned —
    /// including every MCP server the install gate refused, and why.
    /// </summary>
    public static PlusOutcome Plugins(AgentBridgeEvent ev, string? requestedWorkspace)
    {
        ArgumentNullException.ThrowIfNull(ev);

        if (BridgeFailure(ev, "Plugins") is { } failure) return failure;

        var plugins = ev.PluginDetails ?? [];
        var where = DescribeFolder(ev.Workspace, requestedWorkspace);

        if (plugins.Count == 0)
        {
            return new PlusOutcome(
                PlusActionState.Empty,
                $"No plugins are installed in {where} yet. "
                + "Install one from a folder on this machine with: helmion plugin add <path>. "
                + "Remote sources are refused on purpose — clone it and read it first.");
        }

        var sb = new StringBuilder();
        sb.Append(plugins.Count).Append(plugins.Count == 1 ? " plugin" : " plugins")
          .Append(" loaded in ").Append(where).Append('.');

        var refusedTotal = 0;
        foreach (var plugin in plugins)
        {
            sb.Append("\n  ").Append(plugin.Name);
            if (!string.IsNullOrWhiteSpace(plugin.Version)) sb.Append(" v").Append(plugin.Version);
            sb.Append(plugin.HasCommands ? " — has commands/" : " — no commands/");
            if (!string.IsNullOrWhiteSpace(plugin.Root)) sb.Append(" — ").Append(plugin.Root);

            foreach (var approved in plugin.ApprovedMcpServers)
            {
                sb.Append("\n      ✓ MCP \"").Append(approved)
                  .Append("\" approved — vetted through helmion mcp-install.");
            }

            // THE LINE THIS WHOLE FILE IS FOR. A declared server that was refused is
            // a thing the user installed and that is NOT running. Saying nothing
            // leaves them to conclude it works.
            foreach (var refusal in plugin.RefusedMcpServers)
            {
                refusedTotal++;
                sb.Append("\n      ✗ MCP \"").Append(refusal.Name)
                  .Append("\" REFUSED — ").Append(Trim(refusal.Reason, 300));
            }

            foreach (var warning in plugin.Warnings)
            {
                sb.Append("\n      ! ").Append(Trim(warning, 300));
            }
        }

        if (refusedTotal > 0)
        {
            sb.Append("\nREFUSED means the server was declared but never approved, so it is NOT "
                      + "running. Nothing here is executed by reading it. Approve one on the "
                      + "command line: helmion mcp-install --root <path> — it needs a real "
                      + "terminal, which is why this window cannot do it for you.");
        }

        return new PlusOutcome(PlusActionState.Succeeded, sb.ToString());
    }

    /// <summary>
    /// Any answer that is not a command listing, as a failure carrying the bridge's
    /// OWN words. A generic sentence here would throw away the only diagnostic.
    /// </summary>
    private static PlusOutcome? BridgeFailure(AgentBridgeEvent ev, string what)
    {
        if (string.Equals(ev.Event, "commands", StringComparison.Ordinal)) return null;

        var reason = string.IsNullOrWhiteSpace(ev.Message)
            ? "It gave no reason."
            : ev.Message!;

        return new PlusOutcome(
            PlusActionState.Failed,
            $"The agent bridge answered \"{ev.Event}\" instead of a command list, so {what} "
            + $"could not be read. {reason}");
    }

    /// <summary>
    /// The folder to name on screen — and, when the bridge answered about a
    /// DIFFERENT folder than the one asked for, both of them plus a plain sentence
    /// saying so. A listing that quietly describes the wrong project is the failure
    /// mode this guards.
    /// </summary>
    private static string DescribeFolder(string? answered, string? requested)
    {
        var a = (answered ?? string.Empty).Trim();
        var r = (requested ?? string.Empty).Trim();

        if (a.Length == 0) return r.Length == 0 ? "this workspace" : r;
        if (r.Length == 0) return a;
        if (string.Equals(
                a.TrimEnd('\\', '/'), r.TrimEnd('\\', '/'), StringComparison.OrdinalIgnoreCase))
        {
            return a;
        }

        return $"{a} — WHICH IS NOT THE FOLDER THAT WAS ASKED ABOUT ({r}); "
               + "this list describes a different project than your next message will run in";
    }

    private static string Trim(string value, int max) =>
        value.Length <= max ? value : value[..max] + "…";

    private static void AppendExternalSkills(StringBuilder sb, IReadOnlyList<ExternalSkillEntry>? skills)
    {
        var items = skills ?? [];
        sb.Append("\nCodex skills are a separate execution system and are NOT enabled in Helmion automatically.");
        foreach (var item in items.Take(12))
        {
            sb.Append("\n  ").Append(item.Name).Append(" [").Append(item.Scope)
              .Append(" · inventory only] — ").Append(item.Location);
        }
        if (items.Count > 12) sb.Append("\n  … and ").Append(items.Count - 12).Append(" more Codex-only skills.");
        sb.Append("\nSafe enable flow: review the SKILL.md, then copy only the intended command into "
                  + "this project's .helmion/commands folder. Nothing here installs or executes it.");
    }
}
