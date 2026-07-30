using System.Diagnostics;
using System.Text;

namespace Helmion.Desktop.Core;

/// <summary>Outcome of one project-scaffold run. <see cref="Summary"/> is always safe to show.</summary>
public sealed record ProjectScaffoldResult(bool Ok, int ExitCode, string Summary, string? Directory)
{
    public static ProjectScaffoldResult Failed(string message) => new(false, -1, message, null);
}

/// <summary>
/// Creates a structured project by running Helmion's own CLI.
///
/// WHY IT SHELLS OUT INSTEAD OF REIMPLEMENTING. `src/core/project-scaffold.mjs`
/// already decides what a project contains, what it is named, how a sprint folder
/// is numbered, and — importantly — that nothing is ever overwritten
/// (bin/helmion.mjs:285-291 states that guarantee explicitly). A second C#
/// implementation writing similar-looking files would drift from it, and the day
/// it drifts is the day the button quietly stops producing the same project the
/// CLI does. One writer, one source of truth.
///
/// The working directory IS the project root: `defaultProjectDirectory` is
/// join(cwd, slug) (project-scaffold.mjs:224), so running with cwd = the
/// workspace puts the new folder directly under it. No --dir is passed, so the
/// CLI's own naming rules apply unchanged.
/// </summary>
public static class ProjectScaffoldRunner
{
    /// <summary>A scaffold is small and local; anything longer than this has hung.</summary>
    public static readonly TimeSpan Timeout = TimeSpan.FromSeconds(60);

    public static async Task<ProjectScaffoldResult> InitAsync(
        string helmionRoot,
        string projectRoot,
        string projectName,
        CancellationToken cancellationToken = default)
    {
        var name = (projectName ?? string.Empty).Trim();
        if (name.Length == 0)
        {
            return ProjectScaffoldResult.Failed("A project needs a name.");
        }

        if (string.IsNullOrWhiteSpace(projectRoot) || !Directory.Exists(projectRoot))
        {
            return ProjectScaffoldResult.Failed(
                $"The project root does not exist: {projectRoot}");
        }

        var cli = Path.Combine(helmionRoot ?? string.Empty, "bin", "helmion.mjs");
        if (!File.Exists(cli))
        {
            return ProjectScaffoldResult.Failed(
                $"Helmion's CLI was not found at {cli}, so a project cannot be created from here. "
                + "The command is: helmion project init \"<name>\" --yes");
        }

        var psi = new ProcessStartInfo
        {
            FileName = "node",
            WorkingDirectory = projectRoot,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
            // No console window: a scaffold must not flash a black box on his
            // screen. A prior session was killed for surfacing console windows.
            CreateNoWindow = true,
        };
        psi.ArgumentList.Add(cli);
        psi.ArgumentList.Add("project");
        psi.ArgumentList.Add("init");
        psi.ArgumentList.Add(name);
        psi.ArgumentList.Add("--yes");
        psi.ArgumentList.Add("--json");

        try
        {
            using var process = Process.Start(psi);
            if (process is null)
            {
                return ProjectScaffoldResult.Failed("node could not be started. Is Node.js installed and on PATH?");
            }

            var stdout = new StringBuilder();
            var stderr = new StringBuilder();
            var outTask = ReadAllAsync(process.StandardOutput, stdout, cancellationToken);
            var errTask = ReadAllAsync(process.StandardError, stderr, cancellationToken);

            using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
            timeout.CancelAfter(Timeout);

            try
            {
                await process.WaitForExitAsync(timeout.Token);
            }
            catch (OperationCanceledException)
            {
                try { process.Kill(entireProcessTree: true); } catch { /* already gone */ }
                return ProjectScaffoldResult.Failed(
                    $"Creating the project took longer than {Timeout.TotalSeconds:0} seconds and was stopped.");
            }

            await Task.WhenAll(outTask, errTask);

            if (process.ExitCode != 0)
            {
                var why = stderr.ToString().Trim();
                if (why.Length == 0) why = stdout.ToString().Trim();
                if (why.Length == 0) why = $"the CLI exited with code {process.ExitCode} and said nothing.";
                return new ProjectScaffoldResult(false, process.ExitCode, $"Project not created: {why}", null);
            }

            var directory = ExtractDirectory(stdout.ToString());
            var summary = directory is null
                ? $"\"{name}\" created."
                : $"\"{name}\" created at {directory}.";
            return new ProjectScaffoldResult(true, 0, summary, directory);
        }
        catch (Exception ex)
        {
            return ProjectScaffoldResult.Failed($"Could not run the project scaffold: {ex.Message}");
        }
    }

    private static async Task ReadAllAsync(StreamReader reader, StringBuilder into, CancellationToken token)
    {
        try
        {
            into.Append(await reader.ReadToEndAsync(token));
        }
        catch (Exception)
        {
            // A stream that closed early is not worth failing a successful run over.
        }
    }

    /// <summary>
    /// Pulls the created directory out of the CLI's --json report.
    ///
    /// Hand-scanned rather than deserialised into a typed shape: this needs one
    /// string, and binding a C# record to the CLI's report would be a second
    /// place that has to change whenever the report grows a field.
    /// </summary>
    public static string? ExtractDirectory(string stdout)
    {
        try
        {
            using var document = System.Text.Json.JsonDocument.Parse(stdout);
            if (document.RootElement.TryGetProperty("directory", out var value))
            {
                var text = value.GetString();
                return string.IsNullOrWhiteSpace(text) ? null : text;
            }
        }
        catch (Exception)
        {
            // Not JSON, or a shape we do not recognise. The run still succeeded;
            // the caller just does not get to name the folder.
        }

        return null;
    }
}
