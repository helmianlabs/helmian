using System.Net.Http;
using System.Net.Http.Json;
using System.Runtime.CompilerServices;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace Helmion.Desktop.Core;

/// <summary>
/// Sends one user turn to Gemini 2.0 Flash and streams the text response back
/// using the Gemini generateContent REST API. No SDK dependency required.
/// </summary>
public sealed class GeminiChatSession : IDisposable
{
    private const string ApiBase = "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:streamGenerateContent";
    private readonly HttpClient _http;
    private readonly List<GeminiMessage> _history = [];
    private string _apiKey;

    public GeminiChatSession(string apiKey)
    {
        _apiKey = apiKey;
        _http = new HttpClient { Timeout = TimeSpan.FromSeconds(60) };
    }

    public void UpdateApiKey(string apiKey) => _apiKey = apiKey;

    public bool HasKey => !string.IsNullOrWhiteSpace(_apiKey);

    /// <summary>
    /// Sends <paramref name="userText"/> and yields response text chunks as they arrive.
    /// </summary>
    public async IAsyncEnumerable<string> SendAsync(
        string userText,
        [EnumeratorCancellation] CancellationToken cancellationToken = default)
    {
        if (string.IsNullOrWhiteSpace(_apiKey))
        {
            yield return "[No Gemini API key configured — enter one in Settings]";
            yield break;
        }

        _history.Add(new GeminiMessage("user", [new GeminiPart(userText)]));

        var requestBody = new GeminiRequest(
            _history,
            new GeminiSystemInstruction(PilotToolPrompt.ForProvider("Gemini")));

        var url = $"{ApiBase}?key={Uri.EscapeDataString(_apiKey)}&alt=sse";
        using var request = new HttpRequestMessage(HttpMethod.Post, url)
        {
            Content = JsonContent.Create(requestBody, options: JsonOptions)
        };

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
            yield return $"[Gemini API error {(int)response.StatusCode}: {body[..Math.Min(200, body.Length)]}]";
            yield break;
        }

        var assistantText = new System.Text.StringBuilder();
        await using var stream = await response.Content.ReadAsStreamAsync(cancellationToken);
        using var reader = new System.IO.StreamReader(stream);

        string? line;
        while ((line = await reader.ReadLineAsync(cancellationToken)) != null && !cancellationToken.IsCancellationRequested)
        {
            if (string.IsNullOrWhiteSpace(line)) continue;
            if (!line.StartsWith("data:", StringComparison.Ordinal)) continue;

            var json = line["data:".Length..].Trim();
            if (json == "[DONE]") break;

            string? chunk = null;
            try
            {
                using var doc = JsonDocument.Parse(json);
                var root = doc.RootElement;
                if (root.TryGetProperty("candidates", out var candidates)
                    && candidates.GetArrayLength() > 0)
                {
                    var first = candidates[0];
                    if (first.TryGetProperty("content", out var content)
                        && content.TryGetProperty("parts", out var parts)
                        && parts.GetArrayLength() > 0
                        && parts[0].TryGetProperty("text", out var textEl))
                    {
                        chunk = textEl.GetString();
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
            _history.Add(new GeminiMessage(
                "model",
                [new GeminiPart(assistantText.ToString())]));
        }
    }

    public void ClearHistory() => _history.Clear();

    public void Dispose() => _http.Dispose();

    // ── JSON model ────────────────────────────────────────────────────────────

    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull
    };

    private sealed record GeminiRequest(
        [property: JsonPropertyName("contents")] List<GeminiMessage> Contents,
        [property: JsonPropertyName("system_instruction")] GeminiSystemInstruction SystemInstruction);

    private sealed class GeminiSystemInstruction
    {
        [JsonPropertyName("parts")]
        public GeminiPart[] Parts { get; }

        public GeminiSystemInstruction(string text)
        {
            Parts = [new(text)];
        }
    }

    private sealed record GeminiMessage(
        [property: JsonPropertyName("role")] string Role,
        [property: JsonPropertyName("parts")] List<GeminiPart> Parts);

    private sealed record GeminiPart(
        [property: JsonPropertyName("text")] string Text);

    private sealed record GeminiConfig(string SystemText)
    {
        // Not actually used in this request shape — kept for future extensions
    }
}
