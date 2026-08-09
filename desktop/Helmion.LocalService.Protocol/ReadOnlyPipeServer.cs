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
            var scriptPath = Path.Combine(workspacePath, "src", "core", "schema-provisioner.mjs");
            if (!File.Exists(scriptPath))
            {
                return new SchemaProvisioningResult(false, 0, "schema-provisioner.mjs not found.");
            }

            var processStartInfo = new ProcessStartInfo
            {
                FileName = "node",
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
}
