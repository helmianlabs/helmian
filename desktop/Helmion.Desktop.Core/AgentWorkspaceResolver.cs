namespace Helmion.Desktop.Core;

/// <summary>
/// Picks the folder the agent's tools are confined to. The answer is the workspace the
/// user registered in this app — never a provider CLI's home directory, and never a
/// function of which Maestro coordinator is selected.
/// </summary>
/// <remarks>
/// Lives in Core rather than in the window so the choice is testable. The bug this guards
/// against shipped a turn with <c>workspace C:\Users\troyh\.grok</c> under Full tools: a
/// CLI config home had been persisted into <c>.env</c> as <c>WORKSPACE_PATH</c>, every
/// candidate passed the drive-root-only check, and the app then re-persisted it on each
/// launch. Rejecting the value at resolve time also lets the next launch overwrite it.
/// </remarks>
public static class AgentWorkspaceResolver
{
    /// <summary>Last resort when nothing else resolves — the app's own repo root.</summary>
    public const string DefaultWorkspace = @"E:\Helmion";

    /// <summary>
    /// First candidate that is a real directory and is not a drive root, user profile, or
    /// provider CLI home. Candidates are tried registered → .env → last used → repo root.
    /// </summary>
    /// <param name="registeredWorkspacePath">Folder registered by workspace inspection this run.</param>
    /// <param name="envWorkspacePath"><c>WORKSPACE_PATH</c> from .env, via <see cref="EnvironmentSettingsStore.LoadWorkspacePath"/>.</param>
    /// <param name="lastWorkspacePath">Folder persisted in desktop settings from a previous run.</param>
    /// <param name="helmionRoot">Discovered Helmion repo root, or null.</param>
    /// <param name="directoryExists">Existence probe; defaults to the file system.</param>
    public static string Resolve(
        string? registeredWorkspacePath,
        string? envWorkspacePath,
        string? lastWorkspacePath,
        string? helmionRoot = null,
        Func<string, bool>? directoryExists = null)
    {
        var exists = directoryExists ?? Directory.Exists;

        string?[] candidates =
        [
            registeredWorkspacePath,
            envWorkspacePath,
            lastWorkspacePath,
            helmionRoot,
        ];

        foreach (var raw in candidates)
        {
            if (string.IsNullOrWhiteSpace(raw))
            {
                continue;
            }

            try
            {
                var full = Path.GetFullPath(raw.Trim());

                // Rejected before the existence probe, so a CLI home is refused whether or
                // not that tool happens to be installed on this machine.
                if (EnvironmentSettingsStore.IsUnsafeWorkspaceRoot(full))
                {
                    continue;
                }

                if (exists(full))
                {
                    return full;
                }
            }
            catch (Exception error) when (
                error is ArgumentException
                    or IOException
                    or NotSupportedException
                    or UnauthorizedAccessException)
            {
                // Unusable candidate; try the next one.
            }
        }

        return DefaultWorkspace;
    }
}

/// <summary>
/// Persistent, truthful text for the Console's agent tool boundary. The selected
/// folder and the last folder confirmed by the live bridge are separate facts.
/// </summary>
public sealed record AgentWorkspaceScopeDisplay(
    string Text,
    string ToolTip,
    bool AgentConfirmed);

public static class AgentWorkspaceScopeIndicator
{
    public static AgentWorkspaceScopeDisplay Describe(
        string selectedWorkspace,
        string? agentConfirmedWorkspace)
    {
        var selected = Path.GetFullPath(selectedWorkspace);
        var confirmed = string.IsNullOrWhiteSpace(agentConfirmedWorkspace)
            ? null
            : Path.GetFullPath(agentConfirmedWorkspace);
        var matches = confirmed is not null
            && string.Equals(
                Path.TrimEndingDirectorySeparator(selected),
                Path.TrimEndingDirectorySeparator(confirmed),
                StringComparison.OrdinalIgnoreCase);

        if (matches)
        {
            return new AgentWorkspaceScopeDisplay(
                $"SCOPED FOLDER · {selected} · AGENT CONFIRMED",
                $"The active agent bridge confirmed this tool boundary:\n{selected}\n\n"
                + "Change it on Workspace → Choose workspace.",
                AgentConfirmed: true);
        }

        var lastConfirmation = confirmed is null
            ? "No agent workspace has been confirmed in this app run."
            : $"The agent last confirmed a different folder:\n{confirmed}";
        return new AgentWorkspaceScopeDisplay(
            $"SCOPED FOLDER · {selected} · APPLIES NEXT TURN",
            $"Selected tool boundary:\n{selected}\n\n{lastConfirmation}\n\n"
            + "The selected folder will be applied and confirmed before the next provider turn.",
            AgentConfirmed: false);
    }
}
