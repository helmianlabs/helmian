using System.ComponentModel;
using System.Diagnostics;
using System.IO.Pipes;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Security.Principal;
using Microsoft.Win32.SafeHandles;

namespace Helmion.LocalService.Protocol;

public sealed class ReadOnlyPipeClient : IAsyncDisposable
{
    private readonly NamedPipeClientStream _pipe;
    private readonly SemaphoreSlim _requestLock = new(1, 1);

    private ReadOnlyPipeClient(NamedPipeClientStream pipe)
    {
        _pipe = pipe;
    }

    public static string PipeNameForCurrentUser(string? servicePath = null)
    {
        var identity = WindowsIdentity.GetCurrent().User?.Value
            ?? Environment.UserName;
        var digest = SHA256.HashData(System.Text.Encoding.UTF8.GetBytes(identity));
        var userPipe = $"helmion-pilot-readonly-{Convert.ToHexString(digest)[..16].ToLowerInvariant()}";
        if (string.IsNullOrWhiteSpace(servicePath))
        {
            return userPipe;
        }

        // Multiple Helmion builds can legitimately run side-by-side while a new
        // package is being verified. They must not compete for one global pipe:
        // the first service to bind it would make every other desktop validate a
        // server from the wrong install path and report itself offline. Scope the
        // pipe to the exact service binary the desktop resolved. The short hash
        // keeps the pipe name bounded and discloses no installation path.
        var normalizedPath = Path.GetFullPath(servicePath)
            .TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar)
            .ToUpperInvariant();
        var installDigest = SHA256.HashData(
            System.Text.Encoding.UTF8.GetBytes(normalizedPath));
        return $"{userPipe}-{Convert.ToHexString(installDigest)[..16].ToLowerInvariant()}";
    }

    public static async Task<ReadOnlyPipeClient> ConnectAsync(
        string expectedServerPath,
        TimeSpan timeout,
        CancellationToken cancellationToken = default,
        string? pipeName = null)
    {
        var pipe = new NamedPipeClientStream(
            ".",
            pipeName ?? PipeNameForCurrentUser(),
            PipeDirection.InOut,
            PipeOptions.Asynchronous,
            TokenImpersonationLevel.Identification);
        try
        {
            using var timeoutSource = CancellationTokenSource.CreateLinkedTokenSource(
                cancellationToken);
            timeoutSource.CancelAfter(timeout);
            await pipe.ConnectAsync(timeoutSource.Token);
            ValidateServerProcess(pipe, expectedServerPath);
            return new ReadOnlyPipeClient(pipe);
        }
        catch
        {
            await pipe.DisposeAsync();
            throw;
        }
    }

    public async Task<ServiceHello> HelloAsync(
        CancellationToken cancellationToken = default)
    {
        var response = await SendAsync(
            new PipeRequest(Guid.NewGuid().ToString("N"), ReadOnlyServiceContract.HelloCommand),
            cancellationToken);
        return response.Hello
            ?? throw new InvalidDataException("Local service omitted hello state");
    }

    public async Task<WorkspaceInspection> InspectWorkspaceAsync(
        string workspacePath,
        CancellationToken cancellationToken = default)
    {
        var response = await SendAsync(
            new PipeRequest(
                Guid.NewGuid().ToString("N"),
                ReadOnlyServiceContract.InspectWorkspaceCommand,
                workspacePath),
            cancellationToken);
        return response.Workspace
            ?? throw new InvalidDataException("Local service omitted workspace state");
    }

    public async Task<IReadOnlyList<LocalCapability>> DetectCapabilitiesAsync(
        CancellationToken cancellationToken = default)
    {
        var response = await SendAsync(
            new PipeRequest(
                Guid.NewGuid().ToString("N"),
                ReadOnlyServiceContract.DetectCapabilitiesCommand),
            cancellationToken);
        return response.Capabilities
            ?? throw new InvalidDataException("Local service omitted capability state");
    }

    public async Task<SchemaProvisioningResult> ProvisionSchemaAsync(
        string workspacePath,
        string databaseUrl,
        string endpointId,
        CancellationToken cancellationToken = default)
    {
        var response = await SendAsync(
            new PipeRequest(
                Guid.NewGuid().ToString("N"),
                ReadOnlyServiceContract.ProvisionSchemaCommand,
                workspacePath,
                databaseUrl,
                endpointId),
            cancellationToken);
        return response.SchemaProvisioning
            ?? throw new InvalidDataException("Local service omitted schema provisioning result");
    }

    public async Task<ArtifactProviderStatus> GetArtifactProviderStatusAsync(
        CancellationToken cancellationToken = default)
    {
        var response = await SendAsync(
            new PipeRequest(
                Guid.NewGuid().ToString("N"),
                ReadOnlyServiceContract.ArtifactProviderStatusCommand),
            cancellationToken);
        return response.ArtifactProvider
            ?? throw new InvalidDataException("Local service omitted artifact provider status");
    }

    public async Task<ArtifactGenerationResult> GenerateApprovedArtifactAsync(
        string projectRoot,
        string requestId,
        string evidenceHash,
        CancellationToken cancellationToken = default)
    {
        var response = await SendAsync(
            new PipeRequest(
                Guid.NewGuid().ToString("N"),
                ReadOnlyServiceContract.GenerateApprovedArtifactCommand,
                WorkspacePath: projectRoot,
                ArtifactRequestId: requestId,
                EvidenceHash: evidenceHash),
            cancellationToken);
        return response.ArtifactGeneration
            ?? throw new InvalidDataException("Local service omitted artifact generation result");
    }

    public async Task<TeamConnectionState> GetTeamConnectionAsync(
        string providerId,
        CancellationToken cancellationToken = default)
    {
        TeamConnectorContract.RequireProvider(providerId);
        var response = await SendAsync(
            new PipeRequest(
                Guid.NewGuid().ToString("N"),
                TeamConnectorContract.StatusCommand,
                TeamConnector: new TeamConnectorPipeInput(providerId)),
            cancellationToken);
        return response.TeamConnection
            ?? throw new InvalidDataException("Local service omitted Team connection state");
    }

    public async Task<TeamAuthorizationLaunch> BeginTeamAuthorizationAsync(
        string providerId,
        CancellationToken cancellationToken = default)
    {
        TeamConnectorContract.RequireProvider(providerId);
        var response = await SendAsync(
            new PipeRequest(
                Guid.NewGuid().ToString("N"),
                TeamConnectorContract.BeginAuthorizationCommand,
                TeamConnector: new TeamConnectorPipeInput(providerId)),
            cancellationToken);
        return response.TeamAuthorization
            ?? throw new InvalidDataException("Local service omitted Team authorization state");
    }

    public async Task<TeamConversationSnapshot> ReadTeamConversationAsync(
        string? providerId = null,
        string? scopeId = null,
        string? channelId = null,
        CancellationToken cancellationToken = default)
    {
        if (providerId is not null) TeamConnectorContract.RequireProvider(providerId);
        var response = await SendAsync(
            new PipeRequest(
                Guid.NewGuid().ToString("N"),
                TeamConnectorContract.ReadConversationCommand,
                TeamConnector: new TeamConnectorPipeInput(providerId, scopeId, channelId)),
            cancellationToken);
        return response.TeamConversation
            ?? throw new InvalidDataException("Local service omitted Team conversation state");
    }

    public async Task<RemoteControlLocalStatus> GetRemoteControlStatusAsync(
        CancellationToken cancellationToken = default)
    {
        var response = await SendAsync(new PipeRequest(
            Guid.NewGuid().ToString("N"), ReadOnlyServiceContract.RemoteStatusCommand), cancellationToken);
        return response.RemoteControl
            ?? throw new InvalidDataException("Local service omitted Remote Control state");
    }

    public async Task<(RemoteControlLocalStatus Status, RemoteEnrollmentChallenge Challenge)>
        RequestRemoteControlEnrollmentAsync(
            string installationId, string desktopDisplayName,
            CancellationToken cancellationToken = default)
    {
        var response = await SendAsync(new PipeRequest(
            Guid.NewGuid().ToString("N"), ReadOnlyServiceContract.RemoteEnrollCommand,
            InstallationId: installationId, DesktopDisplayName: desktopDisplayName), cancellationToken);
        return (
            response.RemoteControl ?? throw new InvalidDataException("Local service omitted Remote Control state"),
            response.EnrollmentChallenge ?? throw new InvalidDataException("Local service omitted enrollment challenge"));
    }

    public async Task<RemoteControlLocalStatus> RedeemRemoteControlEnrollmentAsync(
        CancellationToken cancellationToken = default)
    {
        var response = await SendAsync(new PipeRequest(
            Guid.NewGuid().ToString("N"), ReadOnlyServiceContract.RemoteRedeemCommand), cancellationToken);
        return response.RemoteControl
            ?? throw new InvalidDataException("Local service omitted Remote Control state");
    }

    public async Task<RemoteControlLocalStatus> PublishRemoteControlSessionAsync(
        RemoteSelectedSessionMetadata session,
        CancellationToken cancellationToken = default)
    {
        var response = await SendAsync(new PipeRequest(
            Guid.NewGuid().ToString("N"), ReadOnlyServiceContract.RemoteSessionPublishCommand,
            RemoteSession: session), cancellationToken);
        return response.RemoteControl
            ?? throw new InvalidDataException("Local service omitted Remote Control state");
    }

    public async Task<RemoteControlLocalStatus> ClearRemoteControlSessionAsync(
        CancellationToken cancellationToken = default)
    {
        var response = await SendAsync(new PipeRequest(
            Guid.NewGuid().ToString("N"), ReadOnlyServiceContract.RemoteSessionClearCommand), cancellationToken);
        return response.RemoteControl
            ?? throw new InvalidDataException("Local service omitted Remote Control state");
    }

    public async Task<PipeResponse> SendForTestAsync(
        string command,
        string? workspacePath = null,
        CancellationToken cancellationToken = default)
    {
        return await SendAsync(
            new PipeRequest(Guid.NewGuid().ToString("N"), command, workspacePath),
            cancellationToken);
    }

    private async Task<PipeResponse> SendAsync(
        PipeRequest request,
        CancellationToken cancellationToken)
    {
        await _requestLock.WaitAsync(cancellationToken);
        try
        {
            await PipeFraming.WriteAsync(_pipe, request, cancellationToken);
            var response = await PipeFraming.ReadAsync<PipeResponse>(_pipe, cancellationToken)
                ?? throw new EndOfStreamException("Local service closed the pipe");
            if (!string.Equals(response.Id, request.Id, StringComparison.Ordinal))
            {
                throw new InvalidDataException("Local service response ID mismatch");
            }
            if (!response.Ok)
            {
                throw new LocalServiceResponseException(
                    response.ErrorCode ?? "local_service_error",
                    response.ErrorMessage ?? "Local service request failed");
            }
            return response;
        }
        finally
        {
            _requestLock.Release();
        }
    }

    public async ValueTask DisposeAsync()
    {
        _requestLock.Dispose();
        await _pipe.DisposeAsync();
    }

    private static void ValidateServerProcess(
        NamedPipeClientStream pipe,
        string expectedServerPath)
    {
        if (!GetNamedPipeServerProcessId(pipe.SafePipeHandle, out var processId))
        {
            throw new Win32Exception(
                Marshal.GetLastWin32Error(),
                "Could not identify the local service process");
        }

        using var process = Process.GetProcessById((int)processId);
        var actualPath = process.MainModule?.FileName;
        if (string.IsNullOrWhiteSpace(actualPath))
        {
            throw new UnauthorizedAccessException(
                "Could not resolve the named-pipe server executable path");
        }

        var expectedFullPath = Path.GetFullPath(expectedServerPath);
        var actualFullPath = Path.GetFullPath(actualPath);
        var expectedIsDll = expectedFullPath.EndsWith(
            ".dll",
            StringComparison.OrdinalIgnoreCase);
        var isExpectedServer = expectedIsDll
            ? Path.GetFileName(actualFullPath).Equals(
                "dotnet.exe",
                StringComparison.OrdinalIgnoreCase)
            : string.Equals(
                actualFullPath,
                expectedFullPath,
                StringComparison.OrdinalIgnoreCase);

        if (!isExpectedServer)
        {
            throw new UnauthorizedAccessException(
                "Named-pipe server executable did not match the Helmion Local Service "
                + $"selected by this desktop (got '{actualFullPath}')");
        }
    }

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetNamedPipeServerProcessId(
        SafePipeHandle pipe,
        out uint serverProcessId);
}

public sealed class LocalServiceResponseException(
    string errorCode,
    string message) : Exception(message)
{
    public string ErrorCode { get; } = errorCode;
}
