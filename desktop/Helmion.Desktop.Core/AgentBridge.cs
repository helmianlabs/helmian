using System.Diagnostics;
using System.Text;
using System.Text.Json;

namespace Helmion.Desktop.Core;

/// <summary>
/// Long-lived Node <c>helmion agent-bridge</c> process. Same tool loop as
/// <c>helmion agent</c> CLI — used by the Windows Pilot EXE console.
/// </summary>
public sealed class AgentBridge : IDisposable
{
    private Process? _process;
    private StreamWriter? _stdin;
    private readonly object _gate = new();
    private bool _disposed;
    private Task? _readerTask;
    private readonly string _helmionRoot;
    private readonly string _nodeExe;
    private readonly string _cliScript;

    public string? LastProvider { get; private set; }
    public string? LastWorkspace { get; private set; }
    public bool IsRunning => _process is { HasExited: false };

    public AgentBridge()
    {
        _helmionRoot = FindHelmionRoot()
            ?? throw new InvalidOperationException(
                "Could not find Helmion repo root (bin/helmion.mjs). "
                + "Run the Pilot from a build under E:\\Helmion or set WORKSPACE_PATH.");
        _cliScript = Path.Combine(_helmionRoot, "bin", "helmion.mjs");
        if (!File.Exists(_cliScript))
        {
            throw new FileNotFoundException("helmion.mjs not found", _cliScript);
        }
        _nodeExe = FindNodeExecutable()
            ?? throw new FileNotFoundException(
                "node.exe not found on PATH. Install Node 20+ so the Pilot can run the agent engine.");
    }

    public string HelmionRoot => _helmionRoot;

    public async Task EnsureStartedAsync(CancellationToken cancellationToken = default)
    {
        lock (_gate)
        {
            if (_process is { HasExited: false } && _stdin is not null)
            {
                return;
            }
        }

        await StopAsync().ConfigureAwait(false);

        // Reload .env immediately before spawn so a Settings save or .env fix
        // is visible even if this process started with stale keys.
        var settings = EnvironmentSettingsStore.Load();
        EnvironmentSettingsStore.ApplyToProcess(settings);

        var start = new ProcessStartInfo
        {
            FileName = _nodeExe,
            ArgumentList = { _cliScript, "agent-bridge" },
            WorkingDirectory = _helmionRoot,
            UseShellExecute = false,
            RedirectStandardInput = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            CreateNoWindow = true,
            StandardOutputEncoding = Encoding.UTF8,
            StandardErrorEncoding = Encoding.UTF8,
        };

        // Explicitly stamp keys onto the child env. Node also loads .env and
        // now overrides Helmion-managed keys from file (see src/agent/env.mjs).
        SetChildEnv(start, "OPENAI_API_KEY", settings.OpenAiApiKey);
        SetChildEnv(start, "ANTHROPIC_API_KEY", settings.AnthropicApiKey);
        SetChildEnv(start, "GEMINI_API_KEY", settings.GeminiApiKey);
        SetChildEnv(start, "XAI_API_KEY", settings.GrokApiKey);
        SetChildEnv(start, "GROK_API_KEY", settings.GrokApiKey);
        SetChildEnv(start, "HELMION_DATABASE_URL", settings.DatabaseUrl);
        SetChildEnv(start, "HELMION_EXPECTED_ENDPOINT_ID", settings.ExpectedEndpointId);
        SetChildEnv(start, "HELMION_MAESTRO_COORDINATOR", settings.MaestroCoordinator);
        SetChildEnv(
            start,
            "HELMION_PERMISSION_MODE",
            Environment.GetEnvironmentVariable("HELMION_PERMISSION_MODE")
                ?? AgentPermission.ReadOnly);
        SetChildEnv(start, "WORKSPACE_PATH", _helmionRoot);
        SetChildEnv(start, "HELMION_WORKSPACE_PATH", _helmionRoot);

        // User-defined OpenAI-compatible endpoints. Node resolves a coordinator name
        // against this list when it is not one of the four built-ins.
        try
        {
            var custom = DesktopSettingsStore.Load().CustomProviders;
            SetChildEnv(start, "HELMION_CUSTOM_PROVIDERS", SerializeCustomProviders(custom));
        }
        catch
        {
            // Desktop settings are optional for the bridge; built-ins still work.
        }

        var process = new Process { StartInfo = start, EnableRaisingEvents = true };
        if (!process.Start())
        {
            throw new InvalidOperationException("Failed to start helmion agent-bridge");
        }

        lock (_gate)
        {
            _process = process;
            _stdin = process.StandardInput;
            _stdin.AutoFlush = true;
            _readerTask = Task.Run(() => DrainStderr(process), CancellationToken.None);
        }

        // Warm hello (ignore errors — first turn will reconfigure).
        try
        {
            await foreach (var _ in RequestAsync(
                               new { cmd = "hello" },
                               cancellationToken).ConfigureAwait(false))
            {
                // consume
            }
        }
        catch
        {
            // Bridge may still accept configure/turn.
        }
    }

    public async IAsyncEnumerable<AgentBridgeEvent> TurnAsync(
        string text,
        string workspace,
        string provider,
        string? permissionMode = null,
        IReadOnlyList<CustomProviderProfile>? customProviders = null,
        [System.Runtime.CompilerServices.EnumeratorCancellation]
        CancellationToken cancellationToken = default)
    {
        await EnsureStartedAsync(cancellationToken).ConfigureAwait(false);

        var permission = AgentPermission.Normalize(permissionMode);
        await foreach (var ev in RequestAsync(
                           new
                           {
                               cmd = "turn",
                               text,
                               workspace,
                               provider,
                               permission,
                               customProviders = ToWirePayload(customProviders),
                           },
                           cancellationToken).ConfigureAwait(false))
        {
            if (ev.Event == "ready" || ev.Event == "hello")
            {
                LastWorkspace = ev.Workspace ?? LastWorkspace;
                LastProvider = ev.Provider ?? LastProvider;
            }
            yield return ev;
        }
    }

    public async Task ConfigureAsync(
        string workspace,
        string provider,
        string? permissionMode = null,
        IReadOnlyList<CustomProviderProfile>? customProviders = null,
        CancellationToken cancellationToken = default)
    {
        await EnsureStartedAsync(cancellationToken).ConfigureAwait(false);
        var permission = AgentPermission.Normalize(permissionMode);
        await foreach (var ev in RequestAsync(
                           new
                           {
                               cmd = "configure",
                               workspace,
                               provider,
                               permission,
                               customProviders = ToWirePayload(customProviders),
                           },
                           cancellationToken).ConfigureAwait(false))
        {
            if (ev.Event is "ready" or "hello")
            {
                LastWorkspace = ev.Workspace ?? workspace;
                LastProvider = ev.Provider ?? provider;
            }
        }
    }

    /// <summary>
    /// Answer one <c>permission_request</c> from the agent (ask mode).
    /// Written straight to the bridge's stdin rather than through
    /// <see cref="RequestAsync"/>, because the turn that asked is still in
    /// flight and is blocked waiting for exactly this line.
    /// </summary>
    /// <param name="id">The id from the permission_request event.</param>
    /// <param name="decision">allow-once | allow-session | deny.</param>
    public async Task RespondToPermissionAsync(string id, string decision)
    {
        StreamWriter stdin;
        lock (_gate)
        {
            if (_stdin is null) return;
            stdin = _stdin;
        }

        var json = JsonSerializer.Serialize(new
        {
            cmd = "permission_response",
            id,
            decision,
        });
        await stdin.WriteLineAsync(json).ConfigureAwait(false);
    }

    public async Task ResetAsync(CancellationToken cancellationToken = default)
    {
        if (!IsRunning) return;
        await foreach (var _ in RequestAsync(new { cmd = "reset" }, cancellationToken)
                           .ConfigureAwait(false))
        {
        }
    }

    /// <summary>
    /// Ask the bridge what slash commands exist right now. The bridge re-scans
    /// the command directories before answering, so a file added since startup
    /// shows up without a restart.
    /// </summary>
    /// <param name="workspace">
    /// The folder to scan. PASS THIS — without it the bridge answers about
    /// whatever directory it started in, which is the Helmion repo root
    /// (<c>WORKSPACE_PATH</c> is stamped to it in <see cref="EnsureStartedAsync"/>),
    /// not the workspace the user registered. The result then lists commands
    /// from a project they are not working in.
    ///
    /// Optional only so existing zero-argument callers keep compiling; a null
    /// here preserves the old, wrong-folder behaviour.
    /// </param>
    /// <returns>
    /// The <c>commands</c> event, or an <c>error</c> event describing why the
    /// listing failed. Never null — a caller can always render something. The
    /// event's <c>workspace</c> is the folder actually scanned, so a caller can
    /// always say which folder it is describing.
    /// </returns>
    public async Task<AgentBridgeEvent> ListCommandsAsync(
        string? workspace = null,
        CancellationToken cancellationToken = default)
    {
        await EnsureStartedAsync(cancellationToken).ConfigureAwait(false);

        // Sent as a plain field on the `commands` request rather than through
        // ConfigureAsync: `configure` calls the bridge's reconfigure(), which
        // throws when the selected provider has no API key (src/agent/bridge.mjs
        // reconfigure). Listing command files needs no model, and must not start
        // needing a key.
        object request = string.IsNullOrWhiteSpace(workspace)
            ? new { cmd = "commands" }
            : new { cmd = "commands", workspace };

        AgentBridgeEvent? last = null;
        await foreach (var ev in RequestAsync(request, cancellationToken)
                           .ConfigureAwait(false))
        {
            last = ev;
            if (ev.Event == "commands") return ev;
        }

        return last ?? new AgentBridgeEvent("error", Message: "No answer from agent-bridge.");
    }

    private async IAsyncEnumerable<AgentBridgeEvent> RequestAsync(
        object request,
        [System.Runtime.CompilerServices.EnumeratorCancellation]
        CancellationToken cancellationToken)
    {
        Process process;
        StreamWriter stdin;
        lock (_gate)
        {
            process = _process ?? throw new InvalidOperationException("Bridge not started");
            stdin = _stdin ?? throw new InvalidOperationException("Bridge stdin missing");
        }

        var json = JsonSerializer.Serialize(request);
        await stdin.WriteLineAsync(json).ConfigureAwait(false);
        cancellationToken.ThrowIfCancellationRequested();

        // Read events until done/error-done for this turn.
        // Note: hello/configure also end with ready (no done) — stop on ready for those,
        // or done for turn.
        var cmd = request.GetType().GetProperty("cmd")?.GetValue(request)?.ToString()
            ?? "turn";

        while (!cancellationToken.IsCancellationRequested)
        {
            if (process.HasExited)
            {
                yield return new AgentBridgeEvent(
                    "error",
                    Message: $"agent-bridge exited with code {process.ExitCode}");
                yield return new AgentBridgeEvent("done");
                yield break;
            }

            string? line;
            try
            {
                line = await process.StandardOutput
                    .ReadLineAsync(cancellationToken)
                    .ConfigureAwait(false);
            }
            catch (OperationCanceledException)
            {
                yield break;
            }

            if (line is null)
            {
                yield return new AgentBridgeEvent("error", Message: "agent-bridge closed stdout");
                yield return new AgentBridgeEvent("done");
                yield break;
            }

            AgentBridgeEvent? ev = null;
            string? parseError = null;
            try
            {
                ev = ParseEvent(line);
            }
            catch (Exception ex)
            {
                parseError = ex.Message;
            }

            if (parseError is not null)
            {
                yield return new AgentBridgeEvent("error", Message: $"Bad event JSON: {parseError}");
                continue;
            }

            if (ev is null) continue;
            yield return ev;

            if (ev.Event == "done") yield break;
            if (cmd is "configure" or "hello" or "reset" or "ping"
                && ev.Event is "ready" or "hello" or "pong")
            {
                yield break;
            }

            // commands/expand answer with a single event and no "done". Without
            // these the reader would block until the NEXT command's output.
            // Their error paths do emit "done" (bridge.mjs:391-395), so a
            // failure still terminates on the check above.
            if (cmd == "commands" && ev.Event == "commands") yield break;
            if (cmd == "expand" && ev.Event == "expanded") yield break;
        }
    }

    private static AgentBridgeEvent? ParseEvent(string line)
    {
        using var doc = JsonDocument.Parse(line);
        var root = doc.RootElement;
        var ev = root.TryGetProperty("event", out var e) ? e.GetString() : null;
        if (string.IsNullOrEmpty(ev)) return null;

        string? GetStr(string name) =>
            root.TryGetProperty(name, out var p) && p.ValueKind == JsonValueKind.String
                ? p.GetString()
                : null;

        string? argsJson = null;
        if (root.TryGetProperty("args", out var argsEl))
        {
            argsJson = argsEl.GetRawText();
        }

        return new AgentBridgeEvent(
            Event: ev!,
            Message: GetStr("message"),
            Text: GetStr("text"),
            Name: GetStr("name"),
            Preview: GetStr("preview"),
            Provider: GetStr("provider"),
            ProviderId: GetStr("providerId"),
            Workspace: GetStr("workspace"),
            ArgsJson: argsJson,
            Partial: root.TryGetProperty("partial", out var part) && part.ValueKind == JsonValueKind.True,
            Id: GetStr("id"),
            Tool: GetStr("tool"),
            Summary: GetStr("summary"),
            Decision: GetStr("decision"),
            Source: GetStr("source"),
            TimeoutMs: root.TryGetProperty("timeoutMs", out var t) && t.ValueKind == JsonValueKind.Number
                ? t.GetInt32()
                : null,
            // model event: which model the router picked for this round, which
            // tier, and why. The `provenance` event carries the same three
            // fields for the model that actually answered.
            Model: GetStr("model"),
            Tier: GetStr("tier"),
            Reason: GetStr("reason"),
            // command event (src/agent/bridge.mjs:311): the file that was expanded.
            CommandPath: GetStr("path"),
            Round: root.TryGetProperty("round", out var r) && r.ValueKind == JsonValueKind.Number
                ? r.GetInt32()
                : null,
            // provenance event: where the answer actually came from. IsLocal
            // defaults to false ONLY because every other event lacks the field
            // entirely; a provenance event always carries it explicitly, and
            // ShowAnsweringModel reads it only from that event.
            EndpointHost: GetStr("endpointHost"),
            IsLocal: root.TryGetProperty("isLocal", out var local)
                && local.ValueKind == JsonValueKind.True,
            SessionId: GetStr("sessionId"),
            // commands event (src/agent/bridge.mjs:279-292).
            Commands: ParseCommands(root),
            Plugins: ParsePlugins(root));
    }

    private static IReadOnlyList<AgentSlashCommand>? ParseCommands(JsonElement root)
    {
        if (!root.TryGetProperty("commands", out var el) || el.ValueKind != JsonValueKind.Array)
        {
            return null;
        }

        var list = new List<AgentSlashCommand>();
        foreach (var item in el.EnumerateArray())
        {
            if (item.ValueKind != JsonValueKind.Object) continue;

            string? Field(string name) =>
                item.TryGetProperty(name, out var p) && p.ValueKind == JsonValueKind.String
                    ? p.GetString()
                    : null;

            var name = Field("name");
            if (string.IsNullOrWhiteSpace(name)) continue;

            list.Add(new AgentSlashCommand(
                name!,
                Field("description"),
                Field("argumentHint"),
                Field("source"),
                Field("path"),
                // Absent means invocable; only an explicit false hides it.
                !(item.TryGetProperty("userInvocable", out var ui)
                  && ui.ValueKind == JsonValueKind.False)));
        }

        return list;
    }

    private static IReadOnlyList<string>? ParsePlugins(JsonElement root)
    {
        if (!root.TryGetProperty("plugins", out var el) || el.ValueKind != JsonValueKind.Array)
        {
            return null;
        }

        var list = new List<string>();
        foreach (var item in el.EnumerateArray())
        {
            if (item.ValueKind == JsonValueKind.String)
            {
                var s = item.GetString();
                if (!string.IsNullOrWhiteSpace(s)) list.Add(s!);
                continue;
            }

            if (item.ValueKind == JsonValueKind.Object
                && item.TryGetProperty("name", out var n)
                && n.ValueKind == JsonValueKind.String)
            {
                var s = n.GetString();
                if (!string.IsNullOrWhiteSpace(s)) list.Add(s!);
            }
        }

        return list;
    }

    private static async Task DrainStderr(Process process)
    {
        try
        {
            while (!process.HasExited)
            {
                var line = await process.StandardError.ReadLineAsync().ConfigureAwait(false);
                if (line is null) break;
                // Intentionally not forwarded to UI (may contain noise); available for debugger.
                Debug.WriteLine($"[agent-bridge stderr] {line}");
            }
        }
        catch
        {
            // ignore
        }
    }

    public async Task StopAsync()
    {
        Process? process;
        lock (_gate)
        {
            process = _process;
            _process = null;
            try { _stdin?.Dispose(); } catch { /* ignore */ }
            _stdin = null;
        }

        if (process is null) return;
        try
        {
            if (!process.HasExited)
            {
                process.Kill(entireProcessTree: true);
                await process.WaitForExitAsync().ConfigureAwait(false);
            }
        }
        catch
        {
            // ignore
        }
        finally
        {
            process.Dispose();
        }
    }

    public void Dispose()
    {
        if (_disposed) return;
        _disposed = true;
        StopAsync().GetAwaiter().GetResult();
    }

    public static string? FindHelmionRoot()
    {
        var candidates = new List<string>();
        var envWs = Environment.GetEnvironmentVariable("WORKSPACE_PATH")
            ?? Environment.GetEnvironmentVariable("HELMION_WORKSPACE_PATH");
        if (!string.IsNullOrWhiteSpace(envWs)) candidates.Add(envWs);
        candidates.Add(@"E:\Helmion");
        candidates.Add(AppContext.BaseDirectory);

        foreach (var start in candidates.Distinct(StringComparer.OrdinalIgnoreCase))
        {
            var dir = new DirectoryInfo(start);
            for (var i = 0; i < 10 && dir is not null; i++)
            {
                var script = Path.Combine(dir.FullName, "bin", "helmion.mjs");
                if (File.Exists(script)) return dir.FullName;
                dir = dir.Parent;
            }
        }
        return null;
    }

    public static string? FindNodeExecutable()
    {
        var path = Environment.GetEnvironmentVariable("PATH") ?? "";
        foreach (var part in path.Split(Path.PathSeparator))
        {
            if (string.IsNullOrWhiteSpace(part)) continue;
            var exe = Path.Combine(part.Trim(), "node.exe");
            if (File.Exists(exe)) return exe;
            var unix = Path.Combine(part.Trim(), "node");
            if (File.Exists(unix)) return unix;
        }
        // Common install locations on Windows
        foreach (var guess in new[]
                 {
                     Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "nodejs", "node.exe"),
                     Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86), "nodejs", "node.exe"),
                 })
        {
            if (File.Exists(guess)) return guess;
        }
        return null;
    }

    /// <summary>
    /// Shape the Node agent expects for a custom provider: name, baseUrl, apiKey, model.
    /// Returns null (rather than an empty array) so the bridge keeps its existing list
    /// when a caller has nothing to send.
    /// </summary>
    internal static IReadOnlyList<CustomProviderWire>? ToWirePayload(
        IReadOnlyList<CustomProviderProfile>? customProviders)
    {
        if (customProviders is null || customProviders.Count == 0) return null;
        return customProviders
            .Where(p => !string.IsNullOrWhiteSpace(p.Name) && !string.IsNullOrWhiteSpace(p.EndpointUrl))
            .Select(p => new CustomProviderWire(
                p.Name.Trim(),
                p.EndpointUrl.Trim(),
                p.ApiKey ?? "",
                CustomChatSession.ResolveModelId(p)))
            .ToList();
    }

    /// <summary>JSON for the HELMION_CUSTOM_PROVIDERS child env var; "" when there are none.</summary>
    internal static string SerializeCustomProviders(
        IReadOnlyList<CustomProviderProfile>? customProviders)
    {
        var wire = ToWirePayload(customProviders);
        return wire is null || wire.Count == 0 ? "" : JsonSerializer.Serialize(wire);
    }

    private static void SetChildEnv(ProcessStartInfo start, string key, string? value)
    {
        if (string.IsNullOrWhiteSpace(value))
        {
            // Leave unset so Node can still fill from .env override path.
            return;
        }

        start.Environment[key] = value.Trim();
    }
}

/// <summary>Wire shape sent to the Node agent for one user-defined endpoint.</summary>
public sealed record CustomProviderWire(
    [property: System.Text.Json.Serialization.JsonPropertyName("name")] string Name,
    [property: System.Text.Json.Serialization.JsonPropertyName("baseUrl")] string BaseUrl,
    [property: System.Text.Json.Serialization.JsonPropertyName("apiKey")] string ApiKey,
    [property: System.Text.Json.Serialization.JsonPropertyName("model")] string Model);

public sealed record AgentBridgeEvent(
    string Event,
    string? Message = null,
    string? Text = null,
    string? Name = null,
    string? Preview = null,
    string? Provider = null,
    string? ProviderId = null,
    string? Workspace = null,
    string? ArgsJson = null,
    bool Partial = false,
    // permission_request / permission_decision (ask mode)
    string? Id = null,
    string? Tool = null,
    string? Summary = null,
    string? Decision = null,
    string? Source = null,
    int? TimeoutMs = null,
    // model (per-task router: which model it INTENDS to use this round, and why).
    //
    // The old comment here said "which model answered this round". It does not,
    // and the difference is the whole 2026-07-30 incident: src/agent/loop.mjs
    // emits this BEFORE the request goes out, so when a fallback fires it names
    // a model that never produced a word. For what actually answered, read the
    // `provenance` event below — these three fields are populated by both.
    string? Model = null,
    string? Tier = null,
    string? Reason = null,
    int? Round = null,
    string? CommandPath = null,
    // provenance (src/agent/bridge.mjs): emitted AFTER the response arrived and
    // after the row was written to .helmion/audit/provenance-*.jsonl. Reuses
    // Model / Tier / Provider / ProviderId / Round above and adds the two fields
    // that make "which model am I talking to" answerable.
    string? EndpointHost = null,
    bool IsLocal = false,
    string? SessionId = null,
    // commands (slash-command registry listing)
    IReadOnlyList<AgentSlashCommand>? Commands = null,
    IReadOnlyList<string>? Plugins = null);

/// <summary>One user-defined slash command as reported by the bridge.</summary>
public sealed record AgentSlashCommand(
    string Name,
    string? Description,
    string? ArgumentHint,
    string? Source,
    string? Path,
    bool UserInvocable);
