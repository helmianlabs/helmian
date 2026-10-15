using System.Net.Http;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Runtime.CompilerServices;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace Helmion.Desktop.Core;

/// <summary>
/// Streams chat completions from <b>xAI Grok</b> (api.x.ai) — not Groq, not Llama.
/// OpenAI-compatible <c>/v1/chat/completions</c> endpoint.
///
/// <para>
/// Two ways to authenticate, in this order: a SuperGrok subscription signed in through
/// <see cref="SuperGrokCredentialProvider"/> (OAuth bearer), or the pasted xAI API key. Both
/// go out as <c>Authorization: Bearer</c>; the OAuth path adds the client header the official
/// Grok CLI sends. <see cref="LastAuthStatus"/> records which one the last request used.
/// </para>
/// </summary>
public sealed class GrokChatSession : IDisposable
{
    public const string ChatCompletionsEndpoint = "https://api.x.ai/v1/chat/completions";

    /// <summary>Current xAI flagship chat model (Grok 4.5). Not a Groq/Llama id.</summary>
    public const string DefaultModelId = "grok-4.5";

    /// <summary>
    /// Client marker the official Grok CLI sends alongside a subscription bearer token
    /// (read out of grok.exe v0.2.118 next to its Authorization header handling).
    /// </summary>
    public const string SubscriptionClientHeader = "X-XAI-Token-Auth";
    public const string SubscriptionClientHeaderValue = "xai-grok-cli";

    private readonly HttpClient _http;
    private readonly List<ChatMessage> _history = [];
    private string _apiKey;
    private SuperGrokCredentialProvider? _superGrok;

    public GrokChatSession(string apiKey, SuperGrokCredentialProvider? superGrok = null)
    {
        _apiKey = apiKey;
        _superGrok = superGrok;
        _http = new HttpClient { Timeout = TimeSpan.FromSeconds(90) };
    }

    public void UpdateApiKey(string apiKey) => _apiKey = apiKey;

    /// <summary>Attach (or detach) the SuperGrok subscription credential source.</summary>
    public void UpdateSuperGrok(SuperGrokCredentialProvider? superGrok) => _superGrok = superGrok;

    /// <summary>True when EITHER a SuperGrok session or an API key can authenticate a request.</summary>
    public bool HasKey => !string.IsNullOrWhiteSpace(_apiKey) || _superGrok?.IsSignedIn == true;

    /// <summary>
    /// How the most recent request authenticated ("Using SuperGrok subscription" /
    /// "Using API key"), or null before the first request. Never contains a token.
    /// </summary>
    public string? LastAuthStatus { get; private set; }

    /// <summary>
    /// Resolve the credential for the next request without sending one, so Settings can show
    /// the live status.
    /// </summary>
    public Task<GrokCredential> DescribeAuthAsync(CancellationToken cancellationToken = default) =>
        _superGrok is null
            ? Task.FromResult(string.IsNullOrWhiteSpace(_apiKey)
                ? new GrokCredential(GrokAuthMode.None, null, "No xAI credential configured.")
                : new GrokCredential(GrokAuthMode.ApiKey, _apiKey, "Using API key"))
            : _superGrok.ResolveAsync(_apiKey, cancellationToken);

    public async IAsyncEnumerable<string> SendAsync(
        string userText,
        [EnumeratorCancellation] CancellationToken cancellationToken = default)
    {
        GrokCredential credential;
        string? authError = null;
        try
        {
            credential = await DescribeAuthAsync(cancellationToken);
        }
        catch (SuperGrokAuthException ex)
        {
            authError = $"[SuperGrok sign-in problem: {ex.Message}]";
            credential = null!;
        }

        if (authError != null)
        {
            yield return authError;
            yield break;
        }

        LastAuthStatus = credential.StatusLabel;

        if (!credential.CanSend)
        {
            yield return $"[{credential.StatusLabel}]";
            yield break;
        }

        _history.Add(new ChatMessage("user", userText));

        var messages = new List<ChatMessage>
        {
            new("system", PilotToolPrompt.ForProvider("Grok (xAI)"))
        };
        messages.AddRange(_history);

        var requestBody = new ChatRequest(DefaultModelId, messages, true);

        using var request = new HttpRequestMessage(HttpMethod.Post, ChatCompletionsEndpoint)
        {
            Content = JsonContent.Create(requestBody, options: JsonOptions)
        };
        request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", credential.Token);
        if (credential.Mode == GrokAuthMode.SuperGrok)
        {
            request.Headers.TryAddWithoutValidation(
                SubscriptionClientHeader,
                SubscriptionClientHeaderValue);
        }

        HttpResponseMessage response;
        string? connectionError = null;
        try
        {
            response = await _http.SendAsync(
                request,
                HttpCompletionOption.ResponseHeadersRead,
                cancellationToken);
        }
        catch (Exception ex) when (ex is HttpRequestException or TaskCanceledException)
        {
            connectionError = $"[Connection error: {ex.Message}]";
            response = null!;
        }

        if (connectionError != null)
        {
            yield return connectionError;
            yield break;
        }

        if (!response.IsSuccessStatusCode)
        {
            var body = await response.Content.ReadAsStringAsync(cancellationToken);
            var detail = body[..Math.Min(200, body.Length)];

            // 401/403 on the subscription path means the token was revoked or is not entitled.
            // Say so, and say what to do — an OAuth bearer failing looks identical to a bad API
            // key otherwise, and the user has no way to tell which credential was even used.
            var hint = credential.Mode == GrokAuthMode.SuperGrok
                && response.StatusCode is System.Net.HttpStatusCode.Unauthorized
                    or System.Net.HttpStatusCode.Forbidden
                ? " — your SuperGrok sign-in was rejected. Sign out and sign in again in "
                    + "Settings, or paste an xAI API key."
                : "";

            yield return $"[xAI Grok API error {(int)response.StatusCode} · {credential.StatusLabel}: {detail}{hint}]";
            yield break;
        }

        var assistantText = new System.Text.StringBuilder();
        await using var stream = await response.Content.ReadAsStreamAsync(cancellationToken);
        using var reader = new StreamReader(stream);

        string? line;
        while ((line = await reader.ReadLineAsync(cancellationToken)) != null
            && !cancellationToken.IsCancellationRequested)
        {
            if (string.IsNullOrWhiteSpace(line)) continue;

            var lineTrimmed = line.Trim();
            if (!lineTrimmed.StartsWith("data:", StringComparison.Ordinal)) continue;

            var json = lineTrimmed["data:".Length..].Trim();
            if (json == "[DONE]") break;

            string? chunk = null;
            try
            {
                using var doc = JsonDocument.Parse(json);
                var root = doc.RootElement;
                if (root.TryGetProperty("choices", out var choices)
                    && choices.GetArrayLength() > 0)
                {
                    var first = choices[0];
                    if (first.TryGetProperty("delta", out var delta)
                        && delta.TryGetProperty("content", out var contentEl))
                    {
                        chunk = contentEl.GetString();
                    }
                }
            }
            catch (JsonException)
            {
                // Skip malformed chunks
            }

            if (!string.IsNullOrEmpty(chunk))
            {
                assistantText.Append(chunk);
                yield return chunk;
            }
        }

        if (assistantText.Length > 0)
        {
            _history.Add(new ChatMessage("assistant", assistantText.ToString()));
        }
    }

    public void ClearHistory() => _history.Clear();

    public void Dispose() => _http.Dispose();

    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull
    };

    private sealed record ChatRequest(
        [property: JsonPropertyName("model")] string Model,
        [property: JsonPropertyName("messages")] List<ChatMessage> Messages,
        [property: JsonPropertyName("stream")] bool Stream);

    private sealed record ChatMessage(
        [property: JsonPropertyName("role")] string Role,
        [property: JsonPropertyName("content")] string Content);
}
