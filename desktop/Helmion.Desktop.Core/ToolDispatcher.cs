using System.Diagnostics;
using System.Text;

namespace Helmion.Desktop.Core;

/// <summary>
/// Dispatches agent tool calls to real local handlers.
/// When <see cref="ConsoleSession.IsExecutionEnabled"/> is false, all tools are refused (read-only chat).
/// </summary>
public sealed class ToolDispatcher
{
    private readonly ConsoleSession _session;
    private readonly string? _workspaceRoot;

    public ToolDispatcher(ConsoleSession session, string? workspaceRoot = null)
    {
        _session = session ?? throw new ArgumentNullException(nameof(session));
        _workspaceRoot = string.IsNullOrWhiteSpace(workspaceRoot)
            ? null
            : Path.GetFullPath(workspaceRoot);
    }

    public async Task<string> DispatchCommandLineAsync(string cmdLine)
    {
        if (string.IsNullOrWhiteSpace(cmdLine))
        {
            return "Error: Command line is empty.";
        }

        if (!_session.IsExecutionEnabled)
        {
            return "Error: Execution is OFF. Console is in read-only chat mode. Toggle the execution badge to enable tools.";
        }

        var parts = cmdLine.Split(' ', 2, StringSplitOptions.RemoveEmptyEntries);
        var verb = parts[0].Trim();
        var arg = parts.Length > 1 ? parts[1].Trim() : string.Empty;

        switch (verb.ToLowerInvariant())
        {
            case "launchprocess":
            case "launchapp":
                return LaunchProcess(arg);

            case "executepowershell":
            case "runpowershell":
                return await ExecutePowerShell(arg);

            case "readworkspacefile":
            case "readfile":
                return ReadWorkspaceFile(arg);

            case "writeworkspacefile":
            case "writefile":
                return WriteWorkspaceFileFromArgLine(arg);

            case "listdirectory":
                return ListDirectory(arg);

            default:
                return $"Error: Unknown tool verb '{verb}'. Available: LaunchProcess, ExecutePowerShell, ReadWorkspaceFile, WriteWorkspaceFile.";
        }
    }

    /// <param name="hidden">
    /// Suppress the launched program's window. Defaults to false because the
    /// point of LaunchProcess is to open something the operator wants to SEE.
    /// Set it true for automated callers — a test suite must never put a window
    /// on the operator's desktop, and this one did: the smoke suite launched a
    /// real visible cmd.exe on every run and never closed it.
    /// </param>
    public string LaunchProcess(string path, bool hidden = false)
    {
        if (!_session.IsExecutionEnabled)
        {
            return "Error: Execution is OFF. LaunchProcess refused.";
        }

        if (string.IsNullOrWhiteSpace(path))
        {
            return "Error: LaunchProcess requires an application name or file path.";
        }

        try
        {
            var startInfo = new ProcessStartInfo
            {
                FileName = path.Trim('\"', '\''),
                // UseShellExecute stays true so a document or a shell alias still
                // opens the way the operator expects. WindowStyle is the lever that
                // works in that mode; CreateNoWindow is ignored when shell-executing.
                UseShellExecute = true,
                CreateNoWindow = hidden,
                WindowStyle = hidden ? ProcessWindowStyle.Hidden : ProcessWindowStyle.Normal
            };
            using var proc = Process.Start(startInfo);
            if (proc != null)
            {
                return $"Success: Launched '{path}' (Process ID: {proc.Id})";
            }

            return $"Success: Launched '{path}'";
        }
        catch (Exception ex)
        {
            return $"Error launching '{path}': {ex.Message}";
        }
    }

    public async Task<string> ExecutePowerShell(string script)
    {
        if (!_session.IsExecutionEnabled)
        {
            return "Error: Execution is OFF. ExecutePowerShell refused.";
        }

        if (string.IsNullOrWhiteSpace(script))
        {
            return "Error: ExecutePowerShell requires a shell command.";
        }

        try
        {
            var sb = new StringBuilder();
            await foreach (var line in _session.SendAsync(script))
            {
                sb.AppendLine(line.Text);
            }

            var text = sb.ToString().TrimEnd();
            return string.IsNullOrEmpty(text) ? "Success: PowerShell completed with no output." : text;
        }
        catch (Exception ex)
        {
            return $"Error running PowerShell: {ex.Message}";
        }
    }

    public string ReadWorkspaceFile(string path)
    {
        if (!_session.IsExecutionEnabled)
        {
            return "Error: Execution is OFF. ReadWorkspaceFile refused.";
        }

        if (string.IsNullOrWhiteSpace(path))
        {
            return "Error: ReadWorkspaceFile requires a file path.";
        }

        try
        {
            if (!TryResolveWorkspacePath(path, out var fullPath, out var error))
            {
                return error;
            }

            if (!File.Exists(fullPath))
            {
                return $"Error: File '{fullPath}' does not exist.";
            }

            return File.ReadAllText(fullPath);
        }
        catch (Exception ex)
        {
            return $"Error reading file: {ex.Message}";
        }
    }

    public string WriteWorkspaceFile(string path, string content)
    {
        if (!_session.IsExecutionEnabled)
        {
            return "Error: Execution is OFF. WriteWorkspaceFile refused.";
        }

        if (string.IsNullOrWhiteSpace(path))
        {
            return "Error: WriteWorkspaceFile requires a file path.";
        }

        try
        {
            if (!TryResolveWorkspacePath(path, out var fullPath, out var error))
            {
                return error;
            }

            var dir = Path.GetDirectoryName(fullPath);
            if (!string.IsNullOrEmpty(dir))
            {
                Directory.CreateDirectory(dir);
            }

            content ??= string.Empty;
            File.WriteAllText(fullPath, content);
            return $"Success: Wrote {content.Length} characters to file '{fullPath}'.";
        }
        catch (Exception ex)
        {
            return $"Error writing file: {ex.Message}";
        }
    }

    private string WriteWorkspaceFileFromArgLine(string argLine)
    {
        if (string.IsNullOrWhiteSpace(argLine))
        {
            return "Error: WriteWorkspaceFile requires a file path and content.";
        }

        var parts = argLine.Split(' ', 2);
        var filePath = parts[0].Trim('\"', '\'');
        var content = parts.Length > 1 ? parts[1] : string.Empty;
        return WriteWorkspaceFile(filePath, content);
    }

    private string ListDirectory(string dirPath)
    {
        if (!_session.IsExecutionEnabled)
        {
            return "Error: Execution is OFF. ListDirectory refused.";
        }

        var raw = string.IsNullOrWhiteSpace(dirPath)
            ? (_workspaceRoot ?? Directory.GetCurrentDirectory())
            : dirPath.Trim('\"', '\'');

        try
        {
            if (!TryResolveWorkspacePath(raw, out var cleanPath, out var error, allowMissing: true))
            {
                return error;
            }

            if (!Directory.Exists(cleanPath))
            {
                return $"Error: Directory '{cleanPath}' does not exist.";
            }

            var entries = Directory.GetFileSystemEntries(cleanPath);
            if (entries.Length == 0)
            {
                return $"Directory '{cleanPath}' is empty.";
            }

            var lines = entries.Select(e =>
            {
                var isDir = Directory.Exists(e);
                var type = isDir ? "[DIR]" : "[FILE]";
                return $"{type} {Path.GetFileName(e)}";
            });

            return string.Join("\n", lines);
        }
        catch (Exception ex)
        {
            return $"Error listing directory: {ex.Message}";
        }
    }

    private bool TryResolveWorkspacePath(
        string path,
        out string fullPath,
        out string error,
        bool allowMissing = false)
    {
        error = string.Empty;
        var cleaned = path.Trim().Trim('\"', '\'');
        if (string.IsNullOrWhiteSpace(cleaned))
        {
            fullPath = string.Empty;
            error = "Error: Path is empty.";
            return false;
        }

        if (!Path.IsPathRooted(cleaned) && _workspaceRoot is not null)
        {
            cleaned = Path.Combine(_workspaceRoot, cleaned);
        }

        fullPath = Path.GetFullPath(cleaned);

        if (_workspaceRoot is not null)
        {
            var root = _workspaceRoot.TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar)
                + Path.DirectorySeparatorChar;
            var candidate = fullPath.TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar)
                + Path.DirectorySeparatorChar;
            if (!candidate.StartsWith(root, StringComparison.OrdinalIgnoreCase)
                && !string.Equals(
                    fullPath.TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar),
                    _workspaceRoot.TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar),
                    StringComparison.OrdinalIgnoreCase))
            {
                error = $"Error: Path '{fullPath}' is outside the registered workspace.";
                fullPath = string.Empty;
                return false;
            }
        }

        _ = allowMissing;
        return true;
    }
}
