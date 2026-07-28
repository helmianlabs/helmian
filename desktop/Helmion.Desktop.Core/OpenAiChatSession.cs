using System.Net.Http;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Runtime.CompilerServices;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace Helmion.Desktop.Core;

/// <summary>
/// Streams chat completions from OpenAI (GPT-4o / GPT-4o-mini).
/// </summary>
public sealed class OpenAiChatSession : IDisposable
{
    public const string ChatCompletionsEndpoint = "https://api.openai.com/v1/chat/completions";
    public const string DefaultModelId = "gpt-4o-mini";

    private readonly HttpClient _http;
    private readonly List<ChatMessage> _history = [];
    private string _apiKey;

    public OpenAiChatSession(string apiKey)
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
            yield return "[No OpenAI API key configured — enter one in Settings]";
            yield break;
        }

        _history.Add(new ChatMessage("user", userText));

        var messages = new List<ChatMessage>
        {
            new("system", PilotToolPrompt.ForProvider("GPT-4o-mini (OpenAI)"))
        };
        messages.AddRange(_history);

        var requestBody = new ChatRequest(DefaultModelId, messages, true);

        using var request = new HttpRequestMessage(HttpMethod.Post, ChatCompletionsEndpoint)
        {
            Content = JsonContent.Create(requestBody, options: JsonOptions)
        };
        request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", _apiKey);

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
            yield return $"[OpenAI API error {(int)response.StatusCode}: {body[..Math.Min(200, body.Length)]}]";
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
