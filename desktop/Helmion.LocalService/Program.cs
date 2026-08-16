using Helmion.LocalService.Protocol;
using Helmion.LocalService.Security;
using Helmion.LocalService;

if (args.Contains("--enroll-openai-images-from-stdin", StringComparer.Ordinal))
{
    if (!Console.IsInputRedirected)
    {
        return 64;
    }
    try
    {
        await OpenAiImagesCredentialEnrollment.EnrollFromRedirectedInputAsync(
            Console.OpenStandardInput(),
            new ProtectedProviderProfileStore());
        return 0;
    }
    catch (Exception error) when (error is ArgumentException
                                  or InvalidDataException
                                  or IOException
                                  or UnauthorizedAccessException
                                  or System.ComponentModel.Win32Exception)
    {
        return 65;
    }
}

if (args.Contains("--smoke-test", StringComparer.Ordinal))
{
    var smokeWorkspace = Path.Combine(
        Path.GetTempPath(),
        $"helmion-local-service-smoke-{Guid.NewGuid():N}");
    Directory.CreateDirectory(smokeWorkspace);
    try
    {
        var inspection = WorkspaceInspector.Inspect(smokeWorkspace);
        return inspection.ProjectWasModified ? 2 : 0;
    }
    finally
    {
        Directory.Delete(smokeWorkspace, recursive: true);
    }
}

using var cancellation = new CancellationTokenSource();
var pipeName = ReadOnlyPipeClient.PipeNameForCurrentUser();
var pipeIndex = Array.IndexOf(args, "--pipe-name");
if (pipeIndex >= 0)
{
    if (pipeIndex + 1 >= args.Length
        || string.IsNullOrWhiteSpace(args[pipeIndex + 1])
        || args[pipeIndex + 1].Length > 128
        || args[pipeIndex + 1].IndexOfAny(['\\', '/']) >= 0)
    {
        return 64;
    }

    pipeName = args[pipeIndex + 1];
}

var parentIndex = Array.IndexOf(args, "--parent-pid");
if (parentIndex >= 0
    && parentIndex + 1 < args.Length
    && int.TryParse(args[parentIndex + 1], out var parentProcessId))
{
    _ = Task.Run(async () =>
    {
        try
        {
            using var parent = System.Diagnostics.Process.GetProcessById(parentProcessId);
            await parent.WaitForExitAsync(cancellation.Token);
            cancellation.Cancel();
        }
        catch (ArgumentException)
        {
            cancellation.Cancel();
        }
        catch (OperationCanceledException)
        {
        }
    });
}

using var providerHttp = OpenAiImagesArtifactStudioAdapter.CreateHttpClient();
var artifactGeneration = new ArtifactStudioLocalGenerationService(
    new OpenAiImagesArtifactStudioAdapter(
        new ProtectedProviderProfileStore(),
        providerHttp));
await using var teamRuntime = new TeamConnectorRuntime();
var teamHandler = new TeamConnectorPipeHandler(teamRuntime);
var remoteOrigin = Environment.GetEnvironmentVariable("HELMION_REMOTE_CONTROL_ORIGIN")
    ?? "https://helmian.cloud";
var remoteVerificationUri = new Uri(
    new Uri(remoteOrigin.TrimEnd('/') + "/"), "herald/").AbsoluteUri;
using var remoteHttp = new HttpClient { Timeout = TimeSpan.FromSeconds(15) };
var remoteApi = new RemoteControlHttpApi(remoteHttp, remoteOrigin, remoteVerificationUri);
var remoteStore = new ProtectedRemoteDesktopCredentialStore();
await using var remoteEnrollment = new RemoteDesktopEnrollmentClient(remoteApi, remoteStore);
await using var remote = new RemoteControlActivationCoordinator(
    remoteEnrollment, remoteStore, remoteApi, remoteApi,
    new AblyRemoteControlRealtimeClient(), new RemoteDesktopGatewayDispatcher());
var remoteLoop = remote.RunAsync(cancellation.Token);
var server = new ReadOnlyPipeServer(
    pipeName,
    async (request, token) =>
    {
        try
        {
            if (TeamConnectorPipeHandler.Capabilities.Contains(request.Command, StringComparer.Ordinal))
            {
                return await teamHandler.HandleAsync(request, token);
            }
            if (request.Command == ReadOnlyServiceContract.RemoteStatusCommand)
            {
                return new PipeResponse(request.Id, true,
                    RemoteControl: await remote.GetStatusAsync(token));
            }
            if (request.Command == ReadOnlyServiceContract.RemoteEnrollCommand)
            {
                var enrollment = await remote.RequestEnrollmentAsync(
                    RemoteControlInstallationIdentity.GetOrCreate(),
                    request.DesktopDisplayName ?? throw new ArgumentException("Desktop display name is required."),
                    token);
                return new PipeResponse(request.Id, true,
                    RemoteControl: enrollment.Status,
                    EnrollmentChallenge: enrollment.Challenge);
            }
            if (request.Command == ReadOnlyServiceContract.RemoteRedeemCommand)
            {
                return new PipeResponse(request.Id, true,
                    RemoteControl: await remote.RedeemEnrollmentAsync(token));
            }
            if (request.Command == ReadOnlyServiceContract.RemoteSessionPublishCommand)
            {
                return new PipeResponse(request.Id, true,
                    RemoteControl: await remote.PublishSessionAsync(
                        request.RemoteSession ?? throw new ArgumentException("Remote session is required."), token));
            }
            if (request.Command == ReadOnlyServiceContract.RemoteSessionClearCommand)
            {
                return new PipeResponse(request.Id, true,
                    RemoteControl: await remote.ClearSessionAsync(token));
            }
            return request.Command switch
            {
                ReadOnlyServiceContract.ArtifactProviderStatusCommand => new PipeResponse(
                    request.Id,
                    true,
                    ArtifactProvider: await artifactGeneration.GetProviderStatusAsync(token)),
                ReadOnlyServiceContract.GenerateApprovedArtifactCommand => new PipeResponse(
                    request.Id,
                    true,
                    ArtifactGeneration: await artifactGeneration.GenerateApprovedAsync(
                        request.WorkspacePath
                        ?? throw new ArgumentException("Project path is required."),
                        request.ArtifactRequestId
                        ?? throw new ArgumentException("Artifact request ID is required."),
                        request.EvidenceHash
                        ?? throw new ArgumentException("Artifact evidence hash is required."),
                        token)),
                _ => new PipeResponse(
                    request.Id,
                    false,
                    "unsupported_command",
                    "The Helmion Local Service rejected an unsupported command.")
            };
        }
        catch (OperationCanceledException) when (token.IsCancellationRequested)
        {
            throw;
        }
        catch (Exception error) when (error is ArgumentException
                                      or InvalidOperationException
                                      or DirectoryNotFoundException
                                      or IOException
                                      or UnauthorizedAccessException
                                      or RemoteControlApiException
                                      or HttpRequestException)
        {
            return new PipeResponse(
                request.Id,
                false,
                request.Command is ReadOnlyServiceContract.ArtifactProviderStatusCommand
                    or ReadOnlyServiceContract.GenerateApprovedArtifactCommand
                    ? "artifact_generation_rejected"
                    : "local_service_command_rejected",
                error.Message.Length <= 500 ? error.Message : error.Message[..500]);
        }
    },
    [
        ReadOnlyServiceContract.ArtifactProviderStatusCommand,
        ReadOnlyServiceContract.GenerateApprovedArtifactCommand,
        ReadOnlyServiceContract.RemoteStatusCommand,
        ReadOnlyServiceContract.RemoteEnrollCommand,
        ReadOnlyServiceContract.RemoteRedeemCommand,
        ReadOnlyServiceContract.RemoteSessionPublishCommand,
        ReadOnlyServiceContract.RemoteSessionClearCommand,
        .. TeamConnectorPipeHandler.Capabilities
    ]);
try
{
    await server.RunAsync(cancellation.Token);
}
catch (OperationCanceledException) when (cancellation.IsCancellationRequested)
{
}

try { await remoteLoop; }
catch (OperationCanceledException) when (cancellation.IsCancellationRequested) { }

return 0;
