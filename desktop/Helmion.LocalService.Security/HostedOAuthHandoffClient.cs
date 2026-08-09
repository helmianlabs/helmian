using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace Helmion.LocalService.Security;

/// <summary>
/// Moves a short-lived provider authorization code from an HTTPS callback to the
/// current-user Local Service. The hosted service never receives a provider
/// client secret and never exchanges or stores a provider access token.
/// </summary>
internal sealed class HostedOAuthHandoffClient(HttpClient httpClient)
{
    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web);

    public async Task RegisterAsync(
        Uri baseUri,
        string handoffToken,
        string requestId,
        string state,
        string redemptionSecret,
        CancellationToken cancellationToken)
    {
        RequireBaseUri(baseUri);
        using var request = AuthorizedRequest(HttpMethod.Post, new Uri(baseUri, "start"), handoffToken);
        request.Content = JsonContent.Create(new
        {
            requestId,
            stateHash = HashProof(state),
            redemptionChallenge = HashProof(redemptionSecret)
        });
        using var response = await httpClient.SendAsync(request, cancellationToken);
        if (response.StatusCode != HttpStatusCode.Created)
        {
            throw new InvalidOperationException(
                $"Slack's hosted callback handoff could not start (HTTP {(int)response.StatusCode}). No provider page was opened.");
        }
    }

    public async Task<string> ReceiveCodeAsync(
        Uri baseUri,
        string handoffToken,
        string requestId,
        string redemptionSecret,
        CancellationToken cancellationToken)
    {
        RequireBaseUri(baseUri);
        var endpoint = new Uri(baseUri, "redeem");
        while (true)
        {
            cancellationToken.ThrowIfCancellationRequested();
            using var request = AuthorizedRequest(HttpMethod.Post, endpoint, handoffToken);
            request.Content = JsonContent.Create(new { requestId, redemptionSecret });
            using var response = await httpClient.SendAsync(request, cancellationToken);
            if (response.StatusCode == HttpStatusCode.Accepted)
            {
                await Task.Delay(TimeSpan.FromSeconds(1), cancellationToken);
                continue;
            }
            if (response.StatusCode == HttpStatusCode.Conflict)
            {
                throw new InvalidOperationException("Slack authorization was declined or could not be completed.");
            }
            if (response.StatusCode != HttpStatusCode.OK)
            {
                throw new InvalidOperationException(
                    $"Slack's hosted callback handoff failed (HTTP {(int)response.StatusCode}). No token was stored.");
            }
            var receipt = await response.Content.ReadFromJsonAsync<HandoffReceipt>(
                JsonOptions,
                cancellationToken);
            if (receipt is null || receipt.Code.Length is <= 0 or > 4096)
            {
                throw new InvalidDataException("Slack's hosted callback returned no valid one-time authorization code.");
            }
            return receipt.Code;
        }
    }

    internal static string HashProof(string value) =>
        Base64Url(SHA256.HashData(Encoding.UTF8.GetBytes(value)));

    private static HttpRequestMessage AuthorizedRequest(HttpMethod method, Uri uri, string handoffToken)
    {
        if (string.IsNullOrWhiteSpace(handoffToken) || handoffToken.Length < 32)
        {
            throw new InvalidOperationException("Slack's hosted handoff service credential is missing or too short.");
        }
        var request = new HttpRequestMessage(method, uri);
        request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", handoffToken);
        return request;
    }

    private static void RequireBaseUri(Uri baseUri)
    {
        if (!baseUri.IsAbsoluteUri
            || baseUri.Scheme != Uri.UriSchemeHttps
            || baseUri.IsLoopback
            || !baseUri.AbsolutePath.EndsWith("/", StringComparison.Ordinal)
            || !string.IsNullOrEmpty(baseUri.Query)
            || !string.IsNullOrEmpty(baseUri.Fragment)
            || !string.IsNullOrEmpty(baseUri.UserInfo))
        {
            throw new InvalidOperationException(
                "Slack's handoff base URI must be a non-loopback HTTPS address ending in /. ");
        }
    }

    private static string Base64Url(byte[] bytes) =>
        Convert.ToBase64String(bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_');

    private sealed record HandoffReceipt(string Code);
}
