using System.Diagnostics;
using System.IO.Pipes;

namespace Helmion.LocalService.Protocol;

public sealed class ReadOnlyPipeServer(string pipeName)
{
    public string PipeName { get; } = string.IsNullOrWhiteSpace(pipeName)
        ? throw new ArgumentException("Pipe name is required", nameof(pipeName))
        : pipeName;

    public async Task RunAsync(CancellationToken cancellationToken)
    {
        while (!cancellationToken.IsCancellationRequested)
        {
            await using var pipe = new NamedPipeServerStream(
                PipeName,
                PipeDirection.InOut,
                1,
                PipeTransmissionMode.Byte,
                PipeOptions.Asynchronous
                    | PipeOptions.CurrentUserOnly
                    | PipeOptions.WriteThrough);
            await pipe.WaitForConnectionAsync(cancellationToken);
            await HandleClientAsync(pipe, cancellationToken);
        }
    }

    private static async Task HandleClientAsync(
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

            var response = HandleRequest(request);
            await PipeFraming.WriteAsync(pipe, response, cancellationToken);
        }
    }

    private static PipeResponse HandleRequest(PipeRequest request)
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
            return request.Command switch
            {
                ReadOnlyServiceContract.HelloCommand => new PipeResponse(
                    request.Id,
                    true,
                    Hello: new ServiceHello(
                        ReadOnlyServiceContract.ProtocolVersion,
                        "read-only",
                        "Windows CurrentUserOnly named pipe",
                        [
                            ReadOnlyServiceContract.HelloCommand,
                            ReadOnlyServiceContract.InspectWorkspaceCommand,
                            ReadOnlyServiceContract.DetectCapabilitiesCommand,
                            ReadOnlyServiceContract.ProvisionSchemaCommand
                        ],
                        WritesEnabled: false)),
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
                _ => new PipeResponse(
                    request.Id,
                    false,
                    "read_only_command_rejected",
                    "The local service exposes only hello, workspace.inspect, and capabilities.detect")
            };
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
