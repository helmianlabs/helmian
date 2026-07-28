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
