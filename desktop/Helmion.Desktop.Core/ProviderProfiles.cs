namespace Helmion.Desktop.Core;

public sealed record ProviderProfileSummary(
    string Id,
    string Name,
    string CoordinatorRole,
    string Interface,
    string Availability,
    string SetupState,
    string AuthenticationClass,
    string AuthenticationGuidance,
    string DocumentationBasis,
    string AuthBoundary,
    string ActivationPlan,
    string? LocalCapabilityId,
    bool AcceptsSecrets,
    bool IsActivated);

public static class ProviderProfileCatalog
{
    /// <summary>
    /// Build the provider registry rows. <paramref name="verifiedCustomNames"/> holds the
    /// custom providers whose endpoint answered a real probe during THIS run — nothing else
    /// may be labelled active. Existing in settings only proves the user typed a URL.
    /// </summary>
    public static IReadOnlyList<ProviderProfileSummary> CreateUnconfigured(
        IReadOnlyList<CustomProviderProfile>? customProfiles = null,
        IReadOnlySet<string>? verifiedCustomNames = null)
    {
        var list = new List<ProviderProfileSummary>
        {
            new(
                "codex-cli",
                "Codex CLI",
                "Coordinator candidate",
                "Local CLI adapter",
                "Not checked",
                "Not configured",
                "CLI account sign-in",
                "Provider-owned browser/session flow; Helmion receives no password or API key.",
                "Official Codex authentication docs verified · account sign-in profile only",
                "Existing Codex configuration and auth state are not read or changed.",
                "Detect → redacted sign-in status test → read-only canary",
                "codex-cli",
                false,
                false),
            new(
                "openai-api",
                "OpenAI API",
                "Coordinator candidate",
                "Direct API adapter",
                "API profile not enrolled",
                "Not configured",
                "API key / bearer credential",
                "Future enrollment goes directly to DPAPI-protected local-service storage.",
                "Official OpenAI API authentication docs verified",
                "Never renderer, console, chat, logs, history, arguments, or source control.",
                "Protected enrollment → redacted identity/project test → read-only canary",
                null,
                false,
                false),
            new(
                "claude-code-cli",
                "Claude Code CLI",
                "Coordinator candidate · docs gate",
                "Local CLI adapter",
                "Not checked",
                "Design-only",
                "Authentication not verified in this slice",
                "No existing Claude configuration, hooks, or session state are inspected.",
                "Current provider documentation review required before activation",
                "An explicit isolated Helmion profile is required; existing setup stays untouched.",
                "Documentation → isolation review → identity test → read-only canary",
                "claude-code-cli",
                false,
                false),
            new(
                "gemini-cli",
                "Gemini CLI",
                "Coordinator candidate",
                "Local CLI adapter",
                "Not checked",
                "Not configured",
                "CLI Google account sign-in",
                "Provider-owned browser sign-in; Helmion receives no Google password or API key.",
                "Official Gemini CLI authentication docs verified · Google sign-in profile",
                "Existing Gemini configuration and cached credentials are not read or changed.",
                "Detect → redacted sign-in status test → read-only canary",
                "gemini-cli",
                false,
                false),
            new(
                "gemini-api",
                "Gemini API",
                "Coordinator candidate",
                "Direct API adapter",
                "API profile not enrolled",
                "Not configured",
                "Gemini authorization API key",
                "Future enrollment goes directly to DPAPI-protected local-service storage.",
                "Official Gemini API-key docs verified · restrictions still require user review",
                "Never renderer, console, chat, logs, history, arguments, or source control.",
                "Protected enrollment → redacted project test → read-only canary",
                null,
                false,
                false),
            new(
                "grok",
                "Grok",
                "Coordinator candidate · docs gate",
                "Adapter surface not selected",
                "Not checked",
                "Design-only",
                "Authentication not verified in this slice",
                "No auth or capability parity is assumed from other providers.",
                "Supported documented API/CLI/local endpoint review required",
                "No consumer UI automation or credential discovery.",
                "Documentation → adapter contract → identity test → read-only canary",
                "grok-cli",
                false,
                false),
            new(
                "neon-development",
                "Neon Development",
                "Isolated durable development state",
                "Direct PostgreSQL adapter",
                "Exact target hard-bound",
                "Protected material not enrolled",
                "Database credential",
                "Future value is encrypted with Windows CurrentUser DPAPI by the local service.",
                "Official Neon direct-vs-pooled endpoint docs verified",
                "Helmion Development · ep-divine-leaf-ay38p1af · neondb · direct only",
                "Protected enrollment → exact-target read-only inspect → isolated canary",
                null,
                false,
                false),
            new(
                "github",
                "GitHub",
                "Source and review integration · docs gate",
                "CLI / provider API candidate",
                "Not checked",
                "Design-only",
                "Authentication not verified in this slice",
                "No existing GitHub auth state is read or reused.",
                "Current provider documentation and least-privilege scope review required",
                "Future service-owned grant only; no renderer credential field.",
                "Documentation → account/scope test → read-only repository canary",
                "github-cli",
                false,
                false),
            new(
                "cursor-ide",
                "Cursor IDE",
                "AI-native editor integration",
                "Local workspace adapter",
                "Not checked",
                "Design-only",
                "Authentication not verified in this slice",
                "No credentials or system-level tokens are read or stored.",
                "Cursor configuration and workspace tracking review required",
                "Supported by direct project rules and file-boundary enforcement.",
                "Documentation → editor tracking → sandbox test → read-only canary",
                "cursor-cli",
                false,
                false),
            new(
                "chatgpt-web",
                "ChatGPT Web",
                "Web-based assistant integration",
                "Browser / standalone adapter",
                "Not checked",
                "Design-only",
                "Session-token authentication",
                "Authentication goes directly to local secure DPAPI-protected storage.",
                "Official OpenAI standalone/web session docs verified",
                "Helmion browser-isolation and proxy security rules active.",
                "Documentation → session verification → read-only sandbox",
                null,
                false,
                false),
            new(
                "claude-api",
                "Claude API (Direct)",
                "Direct API adapter candidate",
                "Direct REST API adapter",
                "API profile not enrolled",
                "Not configured",
                "Anthropic API key / bearer",
                "Future enrollment goes directly to DPAPI-secured local-service storage.",
                "Official Anthropic API-key docs verified",
                "Never renderer, console, chat, logs, history, or source control.",
                "Protected enrollment → identity/project test → read-only canary",
                null,
                false,
                false)
        };

        if (customProfiles is not null)
        {
            foreach (var custom in customProfiles)
            {
                var verified = verifiedCustomNames is not null
                    && verifiedCustomNames.Contains(custom.Name.Trim());

                list.Add(new ProviderProfileSummary(
                    "custom-" + custom.Name.ToLowerInvariant().Replace(" ", "-"),
                    custom.Name,
                    "Custom LLM / OpenAI-compatible endpoint",
                    "Custom Direct API adapter",
                    verified
                        ? "Endpoint answered · verified this run"
                        : "Saved · endpoint not contacted",
                    verified
                        ? "Saved · verified this run"
                        : "Saved · unverified",
                    "Custom API key",
                    "Stored in local application settings for this Windows user.",
                    verified
                        ? $"Endpoint: {custom.EndpointUrl} · probe returned an OpenAI-compatible completion"
                        : $"Endpoint: {custom.EndpointUrl} · never contacted — press Verify to test it",
                    "User-defined custom model configuration.",
                    "Custom endpoint → Verify probe → console routing",
                    null,
                    true,
                    verified));
            }
        }

        return list;
    }
}
