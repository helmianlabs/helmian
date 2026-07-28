namespace Helmion.Desktop.Core;

/// <summary>
/// Compatibility forwarder. Prefer <see cref="ToolDispatcher"/> for new call sites.
/// </summary>
public static class LocalAgentToolExecutor
{
    public static Task<string> ExecuteCommandAsync(string cmdLine, ConsoleSession? consoleSession)
    {
        if (consoleSession is null)
        {
            return Task.FromResult("Error: Console session is not available.");
        }

        var dispatcher = new ToolDispatcher(consoleSession);
        return dispatcher.DispatchCommandLineAsync(cmdLine);
    }
}
