using System.Net.Http;
using System.Net.Http.Json;
using System.Runtime.CompilerServices;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace Helmion.Desktop.Core;

/// <summary>
/// Streams messages from Anthropic Claude (Messages API).
/// </summary>
public sealed class ClaudeChatSession : IDisposable
{
    public const string MessagesEndpoint = "https://api.anthropic.com/v1/messages";
    public const string DefaultModelId = "claude-sonnet-4-5";
    private const string AnthropicVersion = "2023-06-01";

    private readonly HttpClient _http;
    private readonly List<ClaudeMessage> _history = [];
    private string _apiKey;

    public ClaudeChatSession(string apiKey)
    {
        _apiKey = apiKey;
        _http = new HttpClient { Timeout = TimeSpan.FromSeconds(90) };
    }

    public void UpdateApiKey(string apiKey) => _apiKey = apiKey;

    public bool HasKey => !string.IsNullOrWhiteSpace(_apiKey);

    public async IAsyncEnumerable<string> SendAsync(
        string userText,
        [EnumeratorCancellation] CancellationToken cancellationToken = default)
    {
        if (string.IsNullOrWhiteSpace(_apiKey))
        {
            yield return "[No Anthropic API key configured — enter one in Settings]";
            yield break;
        }

        _history.Add(new ClaudeMessage("user", userText));

        var requestBody = new ClaudeRequest(
            DefaultModelId,
            4096,
            true,
            PilotToolPrompt.ForProvider("Claude (Anthropic)"),
            _history);

        using var request = new HttpRequestMessage(HttpMethod.Post, MessagesEndpoint)
        {
            Content = JsonContent.Create(requestBody, options: JsonOptions)
        };
        request.Headers.TryAddWithoutValidation("x-api-key", _apiKey);
        request.Headers.TryAddWithoutValidation("anthropic-version", AnthropicVersion);

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
            yield return $"[Anthropic API error {(int)response.StatusCode}: {body[..Math.Min(200, body.Length)]}]";
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
            if (json is "[DONE]" or "") continue;

            string? chunk = null;
            try
            {
                using var doc = JsonDocument.Parse(json);
                var root = doc.RootElement;
                if (root.TryGetProperty("type", out var typeEl)
                    && typeEl.GetString() == "content_block_delta"
                    && root.TryGetProperty("delta", out var delta)
                    && delta.TryGetProperty("text", out var textEl))
                {
                    chunk = textEl.GetString();
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
            _history.Add(new ClaudeMessage("assistant", assistantText.ToString()));
        }
    }

    public void Dispose() => _http.Dispose();

    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull
    };

    private sealed record ClaudeRequest(
        [property: JsonPropertyName("model")] string Model,
        [property: JsonPropertyName("max_tokens")] int MaxTokens,
        [property: JsonPropertyName("stream")] bool Stream,
        [property: JsonPropertyName("system")] string System,
        [property: JsonPropertyName("messages")] List<ClaudeMessage> Messages);

    private sealed record ClaudeMessage(
        [property: JsonPropertyName("role")] string Role,
        [property: JsonPropertyName("content")] string Content);
}
