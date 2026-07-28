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
            return await ReadHelloAsync(TimeSpan.FromMilliseconds(800), cancellationToken);
        }
        catch (Exception error) when (IsRetriableConnectError(error))
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

        Exception? lastError = null;

        // Start (or restart) our service process, then poll the pipe longer.
        for (var cycle = 0; cycle < 2; cycle += 1)
        {
            if (_startedProcess is null || _startedProcess.HasExited)
            {
                try
                {
                    _startedProcess = StartServiceProcess();
                }
                catch (Exception startError) when (
                    startError is InvalidOperationException
                        or System.ComponentModel.Win32Exception)
                {
                    lastError = startError;
                }
            }

            // Give the process a moment to bind the named pipe.
            await Task.Delay(300, cancellationToken);

            for (var attempt = 0; attempt < 20; attempt += 1)
            {
                cancellationToken.ThrowIfCancellationRequested();
                try
                {
                    return await ReadHelloAsync(TimeSpan.FromMilliseconds(500), cancellationToken);
                }
                catch (Exception error) when (IsRetriableConnectError(error))
                {
                    if (cancellationToken.IsCancellationRequested)
                    {
                        throw;
                    }
                    lastError = error;
                    await Task.Delay(150, cancellationToken);
                }
            }

            // Second cycle: clear a stuck owned process and try once more.
            try
            {
                if (_startedProcess is { HasExited: false })
                {
                    _startedProcess.Kill(entireProcessTree: true);
                    _startedProcess.Dispose();
                }
            }
            catch
            {
                // ignore
            }
            _startedProcess = null;
        }

        throw new IOException(
            $"Helmion Local Service did not become available (exe: {_serviceExecutable})",
            lastError);
    }

    private Process StartServiceProcess()
    {
        var isDll = _serviceExecutable.EndsWith(".dll", StringComparison.OrdinalIgnoreCase);
        var startInfo = new ProcessStartInfo
        {
            FileName = isDll ? "dotnet" : _serviceExecutable,
            UseShellExecute = false,
            CreateNoWindow = true,
            WorkingDirectory = Path.GetDirectoryName(_serviceExecutable)
                ?? AppContext.BaseDirectory
        };
        if (isDll)
        {
            startInfo.ArgumentList.Add(_serviceExecutable);
        }
        startInfo.ArgumentList.Add("--parent-pid");
        startInfo.ArgumentList.Add(Environment.ProcessId.ToString());
        return Process.Start(startInfo)
            ?? throw new InvalidOperationException("Helmion Local Service did not start");
    }

    private static bool IsRetriableConnectError(Exception error) =>
        error is TimeoutException
            or IOException
            or OperationCanceledException
            or UnauthorizedAccessException
            or InvalidDataException
            or System.ComponentModel.Win32Exception;

    public async Task<WorkspaceInspection> InspectWorkspaceAsync(
        string workspacePath,
        CancellationToken cancellationToken = default)
    {
        await EnsureConnectedAsync(cancellationToken);
        await using var client = await ReadOnlyPipeClient.ConnectAsync(
            _serviceExecutable,
            TimeSpan.FromSeconds(3),
            cancellationToken);
        var hello = await client.HelloAsync(cancellationToken);
        ValidateHello(hello);
        return await client.InspectWorkspaceAsync(workspacePath, cancellationToken);
    }

    public async Task<SchemaProvisioningResult> ProvisionSchemaAsync(
        string workspacePath,
        string databaseUrl,
        string endpointId,
        CancellationToken cancellationToken = default)
    {
        await EnsureConnectedAsync(cancellationToken);
        await using var client = await ReadOnlyPipeClient.ConnectAsync(
            _serviceExecutable,
            TimeSpan.FromSeconds(3),
            cancellationToken);
        var hello = await client.HelloAsync(cancellationToken);
        ValidateHello(hello);
        return await client.ProvisionSchemaAsync(workspacePath, databaseUrl, endpointId, cancellationToken);
    }

    public async Task<IReadOnlyList<LocalCapability>> DetectCapabilitiesAsync(
        CancellationToken cancellationToken = default)
    {
        await EnsureConnectedAsync(cancellationToken);
        await using var client = await ReadOnlyPipeClient.ConnectAsync(
            _serviceExecutable,
            TimeSpan.FromSeconds(3),
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
        catch
        {
            // Ignore termination errors on shutdown
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
        var candidates = new List<string>();

        // 1) Same folder as the running Pilot (self-contained publish output).
        // ProcessPath is reliable for single-file; AppContext.BaseDirectory can be a
        // temp extract dir under %TEMP%\.net\… which will not contain the service.
        try
        {
            var pilotDir = Path.GetDirectoryName(Environment.ProcessPath);
            if (!string.IsNullOrWhiteSpace(pilotDir))
            {
                candidates.Add(Path.Combine(pilotDir, "Helmion Local Service.exe"));
                candidates.Add(Path.Combine(pilotDir, "Helmion.LocalService.exe"));
            }
        }
        catch
        {
            // ProcessPath unavailable — fall through.
        }

        candidates.Add(Path.Combine(AppContext.BaseDirectory, "Helmion Local Service.exe"));
        candidates.Add(Path.Combine(AppContext.BaseDirectory, "Helmion.LocalService.exe"));
        candidates.Add(Path.Combine(AppContext.BaseDirectory, "Helmion.LocalService.dll"));

        // 2) Known published artifact next to the repo.
        candidates.Add(
            @"E:\Helmion\artifacts\Helmion-Pilot-win-x64-self-contained\Helmion Local Service.exe");

        // 3) Dev build outputs under desktop/ (framework-dependent need sibling .dll).
        var current = new DirectoryInfo(AppContext.BaseDirectory);
        while (current is not null)
        {
            var desktopDir = Path.Combine(current.FullName, "desktop");
            if (Directory.Exists(desktopDir))
            {
                var serviceBase = Path.Combine(desktopDir, "Helmion.LocalService", "bin");
                foreach (var config in new[] { "Release", "Debug" })
                {
                    candidates.Add(Path.Combine(serviceBase, config, "net10.0-windows", "win-x64", "Helmion Local Service.exe"));
                    candidates.Add(Path.Combine(serviceBase, config, "net10.0-windows", "Helmion Local Service.exe"));
                    candidates.Add(Path.Combine(serviceBase, config, "net10.0-windows", "win-x64", "Helmion.LocalService.dll"));
                    candidates.Add(Path.Combine(serviceBase, config, "net10.0-windows", "Helmion.LocalService.dll"));
                }
            }
            current = current.Parent;
        }

        candidates.Add(@"E:\Helmion\desktop\Helmion.LocalService\bin\Release\net10.0-windows\win-x64\Helmion Local Service.exe");
        candidates.Add(@"E:\Helmion\desktop\Helmion.LocalService\bin\Debug\net10.0-windows\Helmion Local Service.exe");

        // Prefer a real, runnable binary:
        // - single-file publish: large self-contained .exe alone is enough
        // - framework-dependent: apphost .exe needs sibling managed .dll
        foreach (var candidate in candidates)
        {
            if (!File.Exists(candidate)) continue;
            var full = Path.GetFullPath(candidate);
            if (full.EndsWith(".dll", StringComparison.OrdinalIgnoreCase))
            {
                return full;
            }

            var dir = Path.GetDirectoryName(full)!;
            var dllBeside = Path.Combine(dir, Path.GetFileNameWithoutExtension(full) + ".dll");
            if (File.Exists(dllBeside))
            {
                return full;
            }

            // Self-contained single-file (no sibling DLL) — accept if substantial size.
            try
            {
                var length = new FileInfo(full).Length;
                if (length > 5_000_000)
                {
                    return full;
                }
            }
            catch
            {
                // ignore IO errors; try next candidate
            }
        }

        foreach (var candidate in candidates)
        {
            if (File.Exists(candidate))
            {
                return Path.GetFullPath(candidate);
            }
        }

        return Path.Combine(AppContext.BaseDirectory, "Helmion Local Service.exe");
    }
}
