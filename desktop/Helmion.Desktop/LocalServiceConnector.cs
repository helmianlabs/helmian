using System.Diagnostics;
using System.IO;
using Helmion.LocalService.Protocol;

namespace Helmion.Desktop;

internal sealed class LocalServiceConnector
{
    private readonly string _serviceExecutable;
    private Process? _startedProcess;

    public LocalServiceConnector()
    {
        _serviceExecutable = ResolveServiceExecutable();
    }

    public string ServiceExecutable => _serviceExecutable;

    public async Task<ServiceHello> EnsureConnectedAsync(
        CancellationToken cancellationToken = default)
    {
        try
        {
            return await ReadHelloAsync(TimeSpan.FromMilliseconds(350), cancellationToken);
        }
        catch (Exception error) when (
            error is TimeoutException
                or IOException
                or OperationCanceledException)
        {
            if (cancellationToken.IsCancellationRequested)
            {
                throw;
            }
        }

        if (!File.Exists(_serviceExecutable))
        {
            throw new FileNotFoundException(
                "Helmion Local Service executable was not found",
                _serviceExecutable);
        }

        if (_startedProcess is null || _startedProcess.HasExited)
        {
            var startInfo = new ProcessStartInfo
            {
                FileName = _serviceExecutable,
                UseShellExecute = false,
                CreateNoWindow = true,
                WorkingDirectory = Path.GetDirectoryName(_serviceExecutable)
                    ?? AppContext.BaseDirectory
            };
            startInfo.ArgumentList.Add("--parent-pid");
            startInfo.ArgumentList.Add(Environment.ProcessId.ToString());
            _startedProcess = Process.Start(startInfo)
                ?? throw new InvalidOperationException("Helmion Local Service did not start");
        }

        Exception? lastError = null;
        for (var attempt = 0; attempt < 20; attempt += 1)
        {
            cancellationToken.ThrowIfCancellationRequested();
            try
            {
                return await ReadHelloAsync(TimeSpan.FromMilliseconds(500), cancellationToken);
            }
            catch (Exception error) when (
                error is TimeoutException
                    or IOException
                    or OperationCanceledException)
            {
                if (cancellationToken.IsCancellationRequested)
                {
                    throw;
                }
                lastError = error;
                await Task.Delay(100, cancellationToken);
            }
        }

        throw new IOException(
            "Helmion Local Service did not become available",
            lastError);
    }

    public async Task<WorkspaceInspection> InspectWorkspaceAsync(
        string workspacePath,
        CancellationToken cancellationToken = default)
    {
        await using var client = await ReadOnlyPipeClient.ConnectAsync(
            _serviceExecutable,
            TimeSpan.FromSeconds(2),
            cancellationToken);
        var hello = await client.HelloAsync(cancellationToken);
        ValidateHello(hello);
        return await client.InspectWorkspaceAsync(workspacePath, cancellationToken);
    }

    public async Task<IReadOnlyList<LocalCapability>> DetectCapabilitiesAsync(
        CancellationToken cancellationToken = default)
    {
        await using var client = await ReadOnlyPipeClient.ConnectAsync(
            _serviceExecutable,
            TimeSpan.FromSeconds(2),
            cancellationToken);
        var hello = await client.HelloAsync(cancellationToken);
        ValidateHello(hello);
        return await client.DetectCapabilitiesAsync(cancellationToken);
    }

    public async Task StopStartedProcessAsync()
    {
        if (_startedProcess is null)
        {
            return;
        }

        try
        {
            if (!_startedProcess.HasExited)
            {
                _startedProcess.Kill(entireProcessTree: true);
                await _startedProcess.WaitForExitAsync();
            }
        }
        finally
        {
            _startedProcess.Dispose();
            _startedProcess = null;
        }
    }

    private async Task<ServiceHello> ReadHelloAsync(
        TimeSpan timeout,
        CancellationToken cancellationToken)
    {
        await using var client = await ReadOnlyPipeClient.ConnectAsync(
            _serviceExecutable,
            timeout,
            cancellationToken);
        var hello = await client.HelloAsync(cancellationToken);
        ValidateHello(hello);
        return hello;
    }

    private static void ValidateHello(ServiceHello hello)
    {
        if (hello.ProtocolVersion != ReadOnlyServiceContract.ProtocolVersion
            || !string.Equals(hello.Mode, "read-only", StringComparison.Ordinal)
            || hello.WritesEnabled
            || !hello.Capabilities.Contains(
                ReadOnlyServiceContract.InspectWorkspaceCommand,
                StringComparer.Ordinal))
        {
            throw new InvalidDataException(
                "Local service did not satisfy the read-only Helmion protocol");
        }
    }

    private static string ResolveServiceExecutable()
    {
        var packaged = Path.Combine(AppContext.BaseDirectory, "Helmion Local Service.exe");
        if (File.Exists(packaged))
        {
            return Path.GetFullPath(packaged);
        }

        var output = new DirectoryInfo(AppContext.BaseDirectory);
        var configuration = output.Parent?.Name is "Release" ? "Release" : "Debug";
        var desktopRoot = Path.GetFullPath(
            Path.Combine(AppContext.BaseDirectory, "..", "..", "..", ".."));
        return Path.Combine(
            desktopRoot,
            "Helmion.LocalService",
            "bin",
            configuration,
            "net10.0-windows",
            "Helmion Local Service.exe");
    }
}
