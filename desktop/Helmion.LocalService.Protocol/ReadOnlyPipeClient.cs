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

    public static string PipeNameForCurrentUser()
    {
        var identity = WindowsIdentity.GetCurrent().User?.Value
            ?? Environment.UserName;
        var digest = SHA256.HashData(System.Text.Encoding.UTF8.GetBytes(identity));
        return $"helmion-pilot-readonly-{Convert.ToHexString(digest)[..16].ToLowerInvariant()}";
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
        var expectedPath = Path.GetFullPath(expectedServerPath);
        if (string.IsNullOrWhiteSpace(actualPath)
            || !string.Equals(
                Path.GetFullPath(actualPath),
                expectedPath,
                StringComparison.OrdinalIgnoreCase))
        {
            throw new UnauthorizedAccessException(
                "Named-pipe server is not the expected Helmion local service executable");
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
