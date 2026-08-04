using System.Diagnostics;
using System.IO.Pipes;

namespace Helmion.LocalService.Protocol;

public sealed class ReadOnlyPipeServer
{
    private readonly Func<PipeRequest, CancellationToken, Task<PipeResponse>>? _extensionHandler;
    private readonly IReadOnlyList<string> _extensionCapabilities;

    public ReadOnlyPipeServer(
        string pipeName,
        Func<PipeRequest, CancellationToken, Task<PipeResponse>>? extensionHandler = null,
        IReadOnlyList<string>? extensionCapabilities = null)
    {
        PipeName = string.IsNullOrWhiteSpace(pipeName)
            ? throw new ArgumentException("Pipe name is required", nameof(pipeName))
            : pipeName;
        _extensionHandler = extensionHandler;
        _extensionCapabilities = extensionCapabilities ?? [];
    }

    public string PipeName { get; }

    public async Task RunAsync(CancellationToken cancellationToken)
    {
        while (!cancellationToken.IsCancellationRequested)
        {
            var pipe = new NamedPipeServerStream(
                PipeName,
                PipeDirection.InOut,
                NamedPipeServerStream.MaxAllowedServerInstances,
                PipeTransmissionMode.Byte,
                PipeOptions.Asynchronous
                    | PipeOptions.CurrentUserOnly
                    | PipeOptions.WriteThrough);
            try
            {
                await pipe.WaitForConnectionAsync(cancellationToken);
            }
            catch
            {
                await pipe.DisposeAsync();
                throw;
            }

            // A slow inspection or a caller that disconnects badly must never
            // prevent Remote Control from reading status or publishing the
            // selected session.  Each accepted CurrentUser-only pipe gets its
            // own lifetime; the listener immediately returns to accept mode.
            _ = Task.Run(async () =>
            {
                await using (pipe)
                {
                    try
                    {
                        await HandleClientAsync(pipe, cancellationToken);
                    }
                    catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
                    {
                    }
                }
            }, CancellationToken.None);
        }
    }

    private async Task HandleClientAsync(
        Stream pipe,
        CancellationToken cancellationToken)
    {
        while (!cancellationToken.IsCancellationRequested)
        {
            PipeRequest? request;
            try
            {
                request = await PipeFraming.ReadAsync<PipeRequest>(pipe, cancellationToken);
            }
            catch (EndOfStreamException)
            {
                return;
            }

            if (request is null)
            {
                return;
            }

            var response = await HandleRequestAsync(request, cancellationToken);
            await PipeFraming.WriteAsync(pipe, response, cancellationToken);
        }
    }

    private async Task<PipeResponse> HandleRequestAsync(
        PipeRequest request,
        CancellationToken cancellationToken)
    {
        if (string.IsNullOrWhiteSpace(request.Id))
        {
            return new PipeResponse(
                string.Empty,
                false,
                "invalid_request",
                "Request ID is required");
        }

        try
        {
            var builtIn = request.Command switch
            {
                ReadOnlyServiceContract.HelloCommand => new PipeResponse(
                    request.Id,
                    true,
                    Hello: CreateHello()),
                ReadOnlyServiceContract.InspectWorkspaceCommand => new PipeResponse(
                    request.Id,
                    true,
                    Workspace: WorkspaceInspector.Inspect(
                        request.WorkspacePath
                        ?? throw new ArgumentException("Workspace path is required"))),
                ReadOnlyServiceContract.DetectCapabilitiesCommand => new PipeResponse(
                    request.Id,
                    true,
                    Capabilities: CapabilityDetector.Detect()),
                ReadOnlyServiceContract.ProvisionSchemaCommand => new PipeResponse(
                    request.Id,
                    true,
                    SchemaProvisioning: ProvisionSchema(request.DatabaseUrl, request.EndpointId, request.WorkspacePath)),
                _ => null
            };
            if (builtIn is not null)
            {
                return builtIn;
            }

            if (_extensionHandler is not null)
            {
                return await _extensionHandler(request, cancellationToken);
            }

            return new PipeResponse(
                request.Id,
                false,
                "read_only_command_rejected",
                "The local service rejected an unsupported command.");
        }
        catch (Exception error) when (
            error is ArgumentException
                or DirectoryNotFoundException
                or IOException
                or UnauthorizedAccessException)
        {
            return new PipeResponse(
                request.Id,
                false,
                "workspace_inspection_failed",
                error.Message);
        }
    }

    private ServiceHello CreateHello()
    {
        var governedWrites = _extensionCapabilities.Contains(
            ReadOnlyServiceContract.GenerateApprovedArtifactCommand,
            StringComparer.Ordinal);
        return new ServiceHello(
            ReadOnlyServiceContract.ProtocolVersion,
            governedWrites ? "governed-local" : "read-only",
            "Windows CurrentUserOnly named pipe · verified Helmion service process",
            [
                ReadOnlyServiceContract.HelloCommand,
                ReadOnlyServiceContract.InspectWorkspaceCommand,
                ReadOnlyServiceContract.DetectCapabilitiesCommand,
                ReadOnlyServiceContract.ProvisionSchemaCommand,
                .. _extensionCapabilities
            ],
            WritesEnabled: governedWrites);
    }

    private static SchemaProvisioningResult ProvisionSchema(string? databaseUrl, string? endpointId, string? workspacePath)
    {
        if (string.IsNullOrWhiteSpace(databaseUrl) || string.IsNullOrWhiteSpace(endpointId) || string.IsNullOrWhiteSpace(workspacePath))
        {
            return new SchemaProvisioningResult(false, 0, "Missing required parameters for schema provisioning.");
        }

        try
        {
            // The workspace path arrives OVER THE WIRE. The legitimate caller
            // (MainWindow.xaml.cs) always sends its own registered workspace, but
            // this server has never checked that, and any process running as this
            // user can open the pipe — the name is derived deterministically from
            // the SID, so it is not a secret.
            //
            // Scope, stated honestly so nobody over- or under-reads it: the pipe
            // is PipeOptions.CurrentUserOnly and this service runs as the ordinary
            // user with no elevation, so an attacker who can reach it can already
            // run code as that user. This is NOT a privilege escalation, and it
            // leaks no credential — DatabaseUrl is supplied BY the caller, it is
            // not server state. What the checks below remove is the ability to
            // point a trusted, long-lived service process at an arbitrary
            // directory and have it execute code from there.
            if (!Path.IsPathRooted(workspacePath))
            {
                return new SchemaProvisioningResult(false, 0, "Workspace path must be absolute.");
            }

            var workspaceRoot = Path.GetFullPath(workspacePath);
            if (!Directory.Exists(workspaceRoot) || IsReparsePoint(workspaceRoot))
            {
                return new SchemaProvisioningResult(
                    false,
                    0,
                    "Workspace path must be an existing directory and must not be a symlink or junction.");
            }

            var scriptPath = Path.GetFullPath(Path.Combine(workspaceRoot, "src", "core", "schema-provisioner.mjs"));

            // Belt and braces on the combine: a workspace path carrying traversal
            // segments must not be able to walk the script out of its own root.
            var rootPrefix = workspaceRoot.EndsWith(Path.DirectorySeparatorChar)
                ? workspaceRoot
                : workspaceRoot + Path.DirectorySeparatorChar;
            if (!scriptPath.StartsWith(rootPrefix, StringComparison.OrdinalIgnoreCase))
            {
                return new SchemaProvisioningResult(false, 0, "Resolved script path escaped the workspace.");
            }

            if (!File.Exists(scriptPath) || IsReparsePoint(scriptPath))
            {
                return new SchemaProvisioningResult(false, 0, "schema-provisioner.mjs not found.");
            }

            // FileName was the bare string "node". With UseShellExecute = false
            // that goes through CreateProcess, whose search order starts with the
            // DIRECTORY OF THE CALLING PROCESS — so a node.exe dropped beside this
            // service is preferred over the real one on PATH. Resolve it once,
            // against PATH only, and hand Process.Start an absolute path.
            var nodeExecutable = ResolveExecutableOnPath("node");
            if (nodeExecutable is null)
            {
                return new SchemaProvisioningResult(false, 0, "node was not found on PATH.");
            }

            var processStartInfo = new ProcessStartInfo
            {
                FileName = nodeExecutable,
                Arguments = $"\"{scriptPath}\"",
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
                CreateNoWindow = true,
                WorkingDirectory = workspacePath
            };

            processStartInfo.EnvironmentVariables["HELMION_DATABASE_URL"] = databaseUrl;
            processStartInfo.EnvironmentVariables["HELMION_ENDPOINT_ID"] = endpointId;
            processStartInfo.EnvironmentVariables["HELMION_SQL_DIR"] = Path.Combine(workspacePath, "sql");

            using var process = Process.Start(processStartInfo);
            if (process == null)
            {
                return new SchemaProvisioningResult(false, 0, "Failed to start Node.js process.");
            }

            process.WaitForExit();
            var output = process.StandardOutput.ReadToEnd();
            var error = process.StandardError.ReadToEnd();

            if (process.ExitCode == 0)
            {
                var match = System.Text.RegularExpressions.Regex.Match(output, @"Successfully applied (\d+) migrations");
                int count = match.Success ? int.Parse(match.Groups[1].Value) : 0;
                return new SchemaProvisioningResult(true, count, null);
            }
            else
            {
                return new SchemaProvisioningResult(false, 0, string.IsNullOrWhiteSpace(error) ? "Unknown error." : error.Trim());
            }
        }
        catch (Exception ex)
        {
            return new SchemaProvisioningResult(false, 0, ex.Message);
        }
    }

    private static bool IsReparsePoint(string path)
    {
        try
        {
            return (File.GetAttributes(path) & FileAttributes.ReparsePoint) != 0;
        }
        catch (Exception error) when (
            error is IOException or UnauthorizedAccessException or ArgumentException)
        {
            // Cannot tell. Treat it as a reparse point, because the caller uses
            // this to decide whether to EXECUTE something out of that path.
            return true;
        }
    }

    /// <summary>
    /// Finds an executable by walking PATH only, deliberately excluding the
    /// current process directory and the working directory that CreateProcess
    /// would otherwise search first.
    /// </summary>
    private static string? ResolveExecutableOnPath(string executable)
    {
        var pathVariable = Environment.GetEnvironmentVariable("PATH");
        if (string.IsNullOrWhiteSpace(pathVariable))
        {
            return null;
        }

        var extensions = OperatingSystem.IsWindows()
            ? (Environment.GetEnvironmentVariable("PATHEXT") ?? ".EXE;.CMD;.BAT")
                .Split(';', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
            : [string.Empty];

        foreach (var directory in pathVariable.Split(
            Path.PathSeparator,
            StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries))
        {
            foreach (var extension in extensions)
            {
                string candidate;
                try
                {
                    candidate = Path.GetFullPath(Path.Combine(directory, executable + extension));
                }
                catch (ArgumentException)
                {
                    // A malformed PATH entry is not worth aborting the search for.
                    continue;
                }

                if (File.Exists(candidate))
                {
                    return candidate;
                }
            }
        }

        return null;
    }
}
