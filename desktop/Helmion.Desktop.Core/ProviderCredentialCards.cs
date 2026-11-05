namespace Helmion.Desktop.Core;

/// <summary>One provider card on the desktop Integrations surface.</summary>
/// <param name="ProviderId">The connect road's provider id (credential-connect.mjs CONNECT_PROVIDERS).</param>
/// <param name="Name">Display name — the web card's word.</param>
/// <param name="Blurb">The line under the name — the web card's word where one exists.</param>
/// <param name="HasPasswordRoad">True when the card carries Email + Password + Connect (the seats). Tool cards carry only the API-key slot.</param>
public sealed record ProviderCredentialCard(string ProviderId, string Name, string Blurb, bool HasPasswordRoad);

/// <summary>
/// The desktop Integrations credential cards — the parity twin of the web
/// app's "Sign in to your AI" cards (web/marketing/app/integrations-view.mjs).
/// Same providers, same names, same sign-in lines. Every card also carries
/// the API-key slot Troy ordered 2026-11-04: on a seat it is the backup
/// door beside the password road; on a tool card (Runway, HeyGen,
/// Higgsfield) it is the only road. All of it writes to the same cloud
/// credential vault as the web cards — nothing is stored on this PC.
/// </summary>
public static class ProviderCredentialCards
{
    public static readonly IReadOnlyList<ProviderCredentialCard> Seats = Array.AsReadOnly(new[]
    {
        new ProviderCredentialCard("claude", "Claude", "Sign in with your Claude account.", true),
        new ProviderCredentialCard("openai", "ChatGPT", "Sign in with your ChatGPT account.", true),
        new ProviderCredentialCard("gemini", "Gemini", "Sign in with your Google account.", true),
        new ProviderCredentialCard("grok", "Grok", "Sign in with your Grok account.", true),
        new ProviderCredentialCard("mistral", "Mistral Le Chat", "Sign in with your Mistral account.", true),
    });

    public static readonly IReadOnlyList<ProviderCredentialCard> Tools = Array.AsReadOnly(new[]
    {
        new ProviderCredentialCard("runway", "Runway", "Use your Runway account for video and image generation.", false),
        new ProviderCredentialCard("heygen", "HeyGen", "Video generation with your HeyGen API key.", false),
        new ProviderCredentialCard("higgsfield", "Higgsfield", "Video generation with your Higgsfield API key.", false),
    });

    public static readonly IReadOnlyList<ProviderCredentialCard> All = Array.AsReadOnly(Seats.Concat(Tools).ToArray());

    /// <summary>
    /// The status word a card shows for a provider_connections auth_mode.
    /// A stored sign-in reads "Sign-in saved", not "Connected": the row's
    /// lifecycle stays pending until the box establishes a session off it,
    /// and the card must not claim more than the vault write earned.
    /// </summary>
    public static string StatusText(string? authMode) => authMode switch
    {
        null or "" => "Not connected",
        "password_session" => "Sign-in saved",
        "api_key" => "API key saved",
        "oauth_subscription" => "Connected",
        _ => "Connected",
    };
}
