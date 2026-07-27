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
                            ReadOnlyServiceContract.DetectCapabilitiesCommand
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
}
