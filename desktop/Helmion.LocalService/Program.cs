using Helmion.LocalService.Protocol;

if (args.Contains("--smoke-test", StringComparer.Ordinal))
{
    var inspection = WorkspaceInspector.Inspect(AppContext.BaseDirectory);
    return inspection.ProjectWasModified ? 2 : 0;
}

using var cancellation = new CancellationTokenSource();
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

var server = new ReadOnlyPipeServer(ReadOnlyPipeClient.PipeNameForCurrentUser());
try
{
    await server.RunAsync(cancellation.Token);
}
catch (OperationCanceledException) when (cancellation.IsCancellationRequested)
{
}

return 0;
