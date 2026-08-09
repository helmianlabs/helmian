using System.Diagnostics;
using System.Runtime.CompilerServices;

namespace Helmion.Desktop.Core;

/// <summary>
/// Owns the interactive PowerShell shell plus the active Maestro chat REST client.
/// Maestro routes only to primary providers: OpenAI, Anthropic (Claude), Gemini, xAI Grok.
/// Groq / Llama are not used.
/// </summary>
public sealed class ConsoleSession : IDisposable
{
    public const string OpenAiChatCompletionsEndpoint = OpenAiChatSession.ChatCompletionsEndpoint;
    public const string AnthropicMessagesEndpoint = ClaudeChatSession.MessagesEndpoint;
    public const string GeminiStreamEndpointBase =
        "https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-latest:streamGenerateContent";
    public const string XaiGrokChatCompletionsEndpoint = GrokChatSession.ChatCompletionsEndpoint;

    private Process? _process;
    private readonly object _lock = new();
    private bool _disposed;
    private GeminiChatSession? _geminiSession;
    private GrokChatSession? _grokSession;
    private OpenAiChatSession? _openAiSession;
    private ClaudeChatSession? _claudeSession;
    private CustomChatSession? _customSession;
    private SuperGrokCredentialProvider? _superGrok;

    public bool IsRunning => _process is { HasExited: false };

    /// <summary>
    /// SuperGrok subscription credentials for the Grok route. Set once at startup by the
    /// window; when null, Grok falls back to the API key exactly as it did before.
    /// </summary>
    public SuperGrokCredentialProvider? SuperGrok
    {
        get => _superGrok;
        set
        {
            _superGrok = value;
            _grokSession?.UpdateSuperGrok(value);
        }
    }

    /// <summary>
    /// When false, console is read-only chat: tool side effects are refused.
    /// Prefer <see cref="PermissionMode"/> — this mirrors full vs not-full for older call sites.
    /// </summary>
    public bool IsExecutionEnabled
    {
        get => AgentPermission.Normalize(PermissionMode) == AgentPermission.Full;
        set => PermissionMode = value ? AgentPermission.Full : AgentPermission.ReadOnly;
    }

    /// <summary>
    /// Tool permission for the Node agent bridge (all LLMs):
    /// read-only | read-tools | full.
    /// </summary>
    public string PermissionMode { get; set; } = AgentPermission.ReadOnly;

    public string ActiveCoordinator { get; private set; } = "Gemini";

    /// <summary>Active REST endpoint (or null when coordinator has no console chat client).</summary>
    public string? ActiveEndpoint { get; private set; }

    public bool HasActiveApiKey { get; private set; }

    public string ActiveProviderLabel => ActiveCoordinator;

    /// <summary>
    /// Name of the user-defined custom provider currently routed, or null when the
    /// active coordinator is one of the four built-ins.
    /// </summary>
    public string? ActiveCustomProviderName { get; private set; }

    /// <summary>Match a coordinator name against the saved custom providers.</summary>
    public static CustomProviderProfile? ResolveCustomProvider(
        string? coordinator,
        IReadOnlyList<CustomProviderProfile>? customProviders)
    {
        if (customProviders is null || string.IsNullOrWhiteSpace(coordinator)) return null;
        var name = coordinator.Trim();
        return customProviders.FirstOrDefault(p =>
            string.Equals(p.Name?.Trim(), name, StringComparison.OrdinalIgnoreCase));
    }

    /// <summary>
    /// Point console chat at the selected Maestro coordinator's REST endpoint and key.
    /// Built-ins: OpenAI, Claude, Gemini, Grok (xAI). Any other name is matched against
    /// <paramref name="customProviders"/> and routed as an OpenAI-compatible endpoint.
    /// </summary>
    public void ConfigureMaestro(
        string? coordinator,
        EnvironmentSettings settings,
        IReadOnlyList<CustomProviderProfile>? customProviders = null)
    {
        ArgumentNullException.ThrowIfNull(settings);

        var name = string.IsNullOrWhiteSpace(coordinator) ? "Gemini" : coordinator.Trim();
        ActiveCoordinator = name;
        ActiveCustomProviderName = null;

        _geminiSession ??= new GeminiChatSession(settings.GeminiApiKey ?? "");
        _grokSession ??= new GrokChatSession(settings.GrokApiKey ?? "", _superGrok);
        _openAiSession ??= new OpenAiChatSession(settings.OpenAiApiKey ?? "");
        _claudeSession ??= new ClaudeChatSession(settings.AnthropicApiKey ?? "");

        _geminiSession.UpdateApiKey(settings.GeminiApiKey ?? "");
        _grokSession.UpdateApiKey(settings.GrokApiKey ?? "");
        _grokSession.UpdateSuperGrok(_superGrok);
        _openAiSession.UpdateApiKey(settings.OpenAiApiKey ?? "");
        _claudeSession.UpdateApiKey(settings.AnthropicApiKey ?? "");

        if (IsOpenAiCoordinator(name))
        {
            ActiveEndpoint = OpenAiChatCompletionsEndpoint;
            HasActiveApiKey = _openAiSession.HasKey;
            return;
        }

        if (IsClaudeCoordinator(name))
        {
            ActiveEndpoint = AnthropicMessagesEndpoint;
            HasActiveApiKey = _claudeSession.HasKey;
            return;
        }

        if (string.Equals(name, "Gemini", StringComparison.OrdinalIgnoreCase))
        {
            ActiveEndpoint = GeminiStreamEndpointBase;
            HasActiveApiKey = _geminiSession.HasKey;
            return;
        }

        if (IsXaiGrokCoordinator(name))
        {
            ActiveEndpoint = XaiGrokChatCompletionsEndpoint;
            HasActiveApiKey = _grokSession.HasKey;
            return;
        }

        // Not a built-in: try the user's saved OpenAI-compatible endpoints.
        var custom = ResolveCustomProvider(name, customProviders);
        if (custom is not null)
        {
            if (_customSession is null)
            {
                _customSession = new CustomChatSession(custom);
            }
            else
            {
                _customSession.UpdateProfile(custom);
            }

            ActiveCustomProviderName = custom.Name;
            ActiveEndpoint = _customSession.EndpointUrl;
            // Local endpoints legitimately run keyless, so reachability — not a key —
            // is what SendChatAsync depends on here.
            HasActiveApiKey = _customSession.HasKey;
            return;
        }

        // Codex / unknown: no primary REST chat client.
        ActiveEndpoint = null;
        HasActiveApiKey = false;
    }

    public static bool IsOpenAiCoordinator(string? coordinator) =>
        string.Equals(coordinator, "OpenAI", StringComparison.OrdinalIgnoreCase)
        || string.Equals(coordinator, "GPT", StringComparison.OrdinalIgnoreCase);

    public static bool IsClaudeCoordinator(string? coordinator) =>
        string.Equals(coordinator, "Claude", StringComparison.OrdinalIgnoreCase)
        || string.Equals(coordinator, "Anthropic", StringComparison.OrdinalIgnoreCase);

    /// <summary>xAI Grok only — never Groq/Llama.</summary>
    public static bool IsXaiGrokCoordinator(string? coordinator) =>
        string.Equals(coordinator, "Grok", StringComparison.OrdinalIgnoreCase)
        || string.Equals(coordinator, "xAI", StringComparison.OrdinalIgnoreCase);

    /// <summary>Legacy name — prefer <see cref="IsXaiGrokCoordinator"/>.</summary>
    public static bool IsGroqCoordinator(string? coordinator) => IsXaiGrokCoordinator(coordinator);

    public async IAsyncEnumerable<string> SendChatAsync(
        string userText,
        [EnumeratorCancellation] CancellationToken cancellationToken = default)
    {
        if (IsOpenAiCoordinator(ActiveCoordinator))
        {
            if (_openAiSession is null || !_openAiSession.HasKey)
            {
                yield return "[No OpenAI API key configured — enter one in Settings]";
                yield break;
            }

            await foreach (var chunk in _openAiSession.SendAsync(userText, cancellationToken))
            {
                yield return chunk;
            }

            yield break;
        }

        if (IsClaudeCoordinator(ActiveCoordinator))
        {
            if (_claudeSession is null || !_claudeSession.HasKey)
            {
                yield return "[No Anthropic API key configured — enter one in Settings]";
                yield break;
            }

            await foreach (var chunk in _claudeSession.SendAsync(userText, cancellationToken))
            {
                yield return chunk;
            }

            yield break;
        }

        if (string.Equals(ActiveCoordinator, "Gemini", StringComparison.OrdinalIgnoreCase))
        {
            if (_geminiSession is null || !_geminiSession.HasKey)
            {
                yield return "[No Gemini API key configured — enter one in Settings]";
                yield break;
            }

            await foreach (var chunk in _geminiSession.SendAsync(userText, cancellationToken))
            {
                yield return chunk;
            }

            yield break;
        }

        if (IsXaiGrokCoordinator(ActiveCoordinator))
        {
            if (_grokSession is null || !_grokSession.HasKey)
            {
                yield return
                    "[No xAI Grok credential — press \"Login with SuperGrok\" in Settings, "
                    + "or enter an XAI/Grok API key there (not Groq)]";
                yield break;
            }

            await foreach (var chunk in _grokSession.SendAsync(userText, cancellationToken))
            {
                yield return chunk;
            }

            yield break;
        }

        if (ActiveCustomProviderName is not null && _customSession is not null)
        {
            await foreach (var chunk in _customSession.SendAsync(userText, cancellationToken))
            {
                yield return chunk;
            }

            yield break;
        }

        yield return
            $"[Console chat is not wired for coordinator '{ActiveCoordinator}'. " +
            "Select OpenAI, Claude, Gemini, Grok (xAI), or a saved custom endpoint in Settings. " +
            "Groq/Llama is not used.]";
    }

    public async IAsyncEnumerable<ConsoleLine> SendAsync(
        string command,
        [EnumeratorCancellation] CancellationToken cancellationToken = default)
    {
        EnsureStarted();

        if (_process is null)
        {
            yield return new ConsoleLine("Could not start shell session.", ConsoleLine.Kind.Error);
            yield break;
        }

        const string Sentinel = "__HELMION_EOC__";
        await _process.StandardInput.WriteLineAsync(command);
        await _process.StandardInput.WriteLineAsync($"Write-Host \"{Sentinel}\"");
        await _process.StandardInput.FlushAsync(cancellationToken);

        while (!cancellationToken.IsCancellationRequested)
        {
            if (_process.HasExited)
            {
                yield return new ConsoleLine("[Shell exited]", ConsoleLine.Kind.Error);
                yield break;
            }

            string? line;
            try
            {
                line = await _process.StandardOutput.ReadLineAsync(cancellationToken);
            }
            catch (OperationCanceledException)
            {
                yield break;
            }

            if (line is null) yield break;
            if (line == Sentinel) yield break;

            yield return new ConsoleLine(line, ConsoleLine.Kind.Output);
        }
    }

    private void EnsureStarted()
    {
        lock (_lock)
        {
            if (_process is { HasExited: false }) return;

            _process?.Dispose();

            var startInfo = new ProcessStartInfo
            {
                FileName = "powershell.exe",
                Arguments = "-NoLogo -NoProfile -NonInteractive -Command -",
                UseShellExecute = false,
                RedirectStandardInput = true,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                CreateNoWindow = true
            };

            _process = new Process { StartInfo = startInfo };
            _process.ErrorDataReceived += (_, _) => { };
            _process.Start();
            _process.BeginErrorReadLine();
        }
    }

    public void Stop()
    {
        lock (_lock)
        {
            try
            {
                if (_process is { HasExited: false })
                {
                    _process.Kill(entireProcessTree: true);
                }
            }
            catch
            {
            }
        }
    }

    public void Dispose()
    {
        if (_disposed) return;
        _disposed = true;
        Stop();
        _process?.Dispose();
        _process = null;
        _geminiSession?.Dispose();
        _grokSession?.Dispose();
        _openAiSession?.Dispose();
        _claudeSession?.Dispose();
        _customSession?.Dispose();
        _geminiSession = null;
        _grokSession = null;
        _openAiSession = null;
        _claudeSession = null;
        _customSession = null;
    }
}

public sealed record ConsoleLine(string Text, ConsoleLine.Kind LineKind)
{
    public enum Kind { Output, Error }
}
