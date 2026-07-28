using System.Net.Http;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Runtime.CompilerServices;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace Helmion.Desktop.Core;

/// <summary>Outcome of a live probe against a user-defined endpoint.</summary>
public sealed record CustomProviderProbeResult(bool Ok, string Detail);

/// <summary>
/// Streams chat completions from any OpenAI-compatible endpoint (Ollama, vLLM,
/// LM Studio, DeepSeek, Qwen, …). Same wire format as <see cref="OpenAiChatSession"/>;
/// the base URL, model id, and key come from a user-defined
/// <see cref="CustomProviderProfile"/> instead of being compiled in.
/// </summary>
public sealed class CustomChatSession : IDisposable
{
    private readonly HttpClient _http;
    private readonly List<ChatMessage> _history = [];
    private CustomProviderProfile _profile;

    public CustomChatSession(CustomProviderProfile profile)
    {
        ArgumentNullException.ThrowIfNull(profile);
        _profile = profile;
        _http = new HttpClient { Timeout = TimeSpan.FromSeconds(90) };
    }

    /// <summary>Swap the active profile. Clears history when the target endpoint changes.</summary>
    public void UpdateProfile(CustomProviderProfile profile)
    {
        ArgumentNullException.ThrowIfNull(profile);
        var endpointChanged = !string.Equals(
            _profile.EndpointUrl,
            profile.EndpointUrl,
            StringComparison.OrdinalIgnoreCase);
        _profile = profile;
        if (endpointChanged) _history.Clear();
    }

    public string ProviderName => _profile.Name;

    /// <summary>The concrete POST target derived from the user's base URL.</summary>
    public string EndpointUrl => ResolveChatCompletionsUrl(_profile.EndpointUrl);

    /// <summary>
    /// Local endpoints (Ollama, vLLM, LM Studio) legitimately need no key, so a
    /// blank key is not a misconfiguration the way it is for a hosted provider.
    /// </summary>
    public bool HasKey => !string.IsNullOrWhiteSpace(_profile.ApiKey);

    /// <summary>Model id sent on the wire: explicit Model, else the profile name.</summary>
    public string ModelId => ResolveModelId(_profile);

    public static string ResolveModelId(CustomProviderProfile profile)
    {
        ArgumentNullException.ThrowIfNull(profile);
        return string.IsNullOrWhiteSpace(profile.Model)
            ? profile.Name.Trim()
            : profile.Model!.Trim();
    }

    /// <summary>
    /// Accept every base-URL shape users actually paste:
    /// <c>http://host:11434</c>, <c>…/v1</c>, or the full <c>…/v1/chat/completions</c>.
    /// </summary>
    public static string ResolveChatCompletionsUrl(string endpointUrl)
    {
        var url = (endpointUrl ?? string.Empty).Trim().TrimEnd('/');
        if (url.Length == 0) return string.Empty;
        if (url.EndsWith("/chat/completions", StringComparison.OrdinalIgnoreCase)) return url;
        if (url.EndsWith("/v1", StringComparison.OrdinalIgnoreCase)) return url + "/chat/completions";
        return url + "/v1/chat/completions";
    }

    /// <summary>
    /// One real non-streaming request against the configured endpoint. This is the
    /// only thing that may promote a saved custom provider to "verified" — existing
    /// in settings proves nothing about whether the endpoint answers.
    /// </summary>
    public static async Task<CustomProviderProbeResult> ProbeAsync(
        CustomProviderProfile profile,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(profile);
        var url = ResolveChatCompletionsUrl(profile.EndpointUrl);
        if (url.Length == 0)
        {
            return new CustomProviderProbeResult(false, "No endpoint URL configured");
        }

        using var http = new HttpClient { Timeout = TimeSpan.FromSeconds(20) };
        var body = new ProbeRequest(
            ResolveModelId(profile),
            [new ChatMessage("user", "ping")],
            1);

        using var request = new HttpRequestMessage(HttpMethod.Post, url)
        {
            Content = JsonContent.Create(body, options: JsonOptions)
        };
        if (!string.IsNullOrWhiteSpace(profile.ApiKey))
        {
            request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", profile.ApiKey);
        }

        try
        {
            using var response = await http.SendAsync(request, cancellationToken);
            var text = await response.Content.ReadAsStringAsync(cancellationToken);
            if (!response.IsSuccessStatusCode)
            {
                return new CustomProviderProbeResult(
                    false,
                    $"HTTP {(int)response.StatusCode} from {url}: {Clip(text, 160)}");
            }

            using var doc = JsonDocument.Parse(text);
            if (!doc.RootElement.TryGetProperty("choices", out var choices)
                || choices.ValueKind != JsonValueKind.Array
                || choices.GetArrayLength() == 0)
            {
                return new CustomProviderProbeResult(
                    false,
                    $"{url} answered HTTP 200 but returned no choices — not OpenAI-compatible");
            }

            return new CustomProviderProbeResult(true, $"HTTP 200 from {url} · model {ResolveModelId(profile)}");
        }
        catch (JsonException ex)
        {
            return new CustomProviderProbeResult(false, $"{url} returned non-JSON: {ex.Message}");
        }
        catch (Exception ex) when (ex is HttpRequestException or TaskCanceledException)
        {
            return new CustomProviderProbeResult(false, $"Cannot reach {url}: {ex.Message}");
        }
    }

    public async IAsyncEnumerable<string> SendAsync(
        string userText,
        [EnumeratorCancellation] CancellationToken cancellationToken = default)
    {
        var url = EndpointUrl;
        if (url.Length == 0)
        {
            yield return $"[Custom provider '{_profile.Name}' has no endpoint URL — set one in Settings]";
            yield break;
        }

        _history.Add(new ChatMessage("user", userText));

        var messages = new List<ChatMessage>
        {
            new("system", PilotToolPrompt.ForProvider($"{_profile.Name} (custom OpenAI-compatible endpoint)"))
        };
        messages.AddRange(_history);

        var requestBody = new ChatRequest(ModelId, messages, true);

        using var request = new HttpRequestMessage(HttpMethod.Post, url)
        {
            Content = JsonContent.Create(requestBody, options: JsonOptions)
        };
        if (HasKey)
        {
            request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", _profile.ApiKey);
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
            connectionError = $"[Connection error reaching {url}: {ex.Message}]";
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
            yield return $"[{_profile.Name} API error {(int)response.StatusCode}: {Clip(body, 200)}]";
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
                if (doc.RootElement.TryGetProperty("choices", out var choices)
                    && choices.GetArrayLength() > 0
                    && choices[0].TryGetProperty("delta", out var delta)
                    && delta.TryGetProperty("content", out var contentEl))
                {
                    chunk = contentEl.GetString();
                }
            }
            catch (JsonException)
            {
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

    public void Dispose() => _http.Dispose();

    private static string Clip(string? value, int max)
    {
        if (string.IsNullOrEmpty(value)) return "";
        return value.Length <= max ? value : value[..max];
    }

    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull
    };

    private sealed record ChatRequest(
        [property: JsonPropertyName("model")] string Model,
        [property: JsonPropertyName("messages")] List<ChatMessage> Messages,
        [property: JsonPropertyName("stream")] bool Stream);

    private sealed record ProbeRequest(
        [property: JsonPropertyName("model")] string Model,
        [property: JsonPropertyName("messages")] List<ChatMessage> Messages,
        [property: JsonPropertyName("max_tokens")] int MaxTokens);

    private sealed record ChatMessage(
        [property: JsonPropertyName("role")] string Role,
        [property: JsonPropertyName("content")] string Content);
}
