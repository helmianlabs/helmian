namespace Helmion.Desktop.Core;

/// <summary>One provider card on the desktop Integrations surface.</summary>
/// <param name="ProviderId">The connect road's provider id (credential-connect.mjs CONNECT_PROVIDERS).</param>
/// <param name="Name">Display name — the web card's word.</param>
/// <param name="Blurb">The line under the name — the web card's word where one exists.</param>
/// <param name="HasPasswordRoad">True when the card carries Email + Password + Connect. No card carries it since 2026-11-17 (letter 935): every card carries only the API-key slot. The flag stays in the model so the surface change is data, not surgery.</param>
public sealed record ProviderCredentialCard(string ProviderId, string Name, string Blurb, bool HasPasswordRoad);

/// <summary>
/// The desktop Integrations credential cards — the parity twin of the web
/// app's "Connect your AI" cards (web/marketing/app/integrations-view.mjs).
/// Same providers, same names, same lines. Every card carries the API-key
/// slot: since Troy's order of 2026-11-17 (Scribe letter 935 — Helmian
/// stops storing customers' AI account passwords) the key is the connect
/// road on the seats too, not a backup door beside a password road; on
/// the tool cards (Runway, HeyGen, Higgsfield) it was always the only
/// road. All of it writes to the same cloud credential vault as the web
/// cards — nothing is stored on this PC.
/// </summary>
public static class ProviderCredentialCards
{
    public static readonly IReadOnlyList<ProviderCredentialCard> Seats = Array.AsReadOnly(new[]
    {
        new ProviderCredentialCard("claude", "Claude", "Connect with a key from your Claude Console account.", false),
        new ProviderCredentialCard("openai", "ChatGPT", "Connect with a key from your OpenAI account.", false),
        new ProviderCredentialCard("gemini", "Gemini", "Connect with a key from your Google AI Studio account.", false),
        new ProviderCredentialCard("grok", "Grok", "Connect with a key from your xAI account.", false),
        new ProviderCredentialCard("mistral", "Mistral Le Chat", "Connect with a key from your Mistral account.", false),
    });

    public static readonly IReadOnlyList<ProviderCredentialCard> Tools = Array.AsReadOnly(new[]
    {
        new ProviderCredentialCard("runway", "Runway", "Connect with a key from your Runway developer account — for video and image generation.", false),
        new ProviderCredentialCard("heygen", "HeyGen", "Video generation with your HeyGen API key.", false),
        new ProviderCredentialCard("higgsfield", "Higgsfield", "Video generation with your Higgsfield API key.", false),
    });

    public static readonly IReadOnlyList<ProviderCredentialCard> All = Array.AsReadOnly(Seats.Concat(Tools).ToArray());

    /// <summary>
    /// The status word a card shows for a provider_connections auth_mode.
    /// A stored sign-in reads "Sign-in saved", not "Connected": the row's
    /// lifecycle stays pending until the box establishes a session off it,
    /// and the card must not claim more than the vault write earned.
    /// (Rows written before 2026-11-17 can still carry password_session
    /// until they are revoked per tenant; the word stays truthful for
    /// them.)
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
