namespace Helmion.Desktop.Core;

/// <summary>
/// Desktop-only route selection for provider-owned subscription sessions.
///
/// The Node AgentBridge is intentionally not given consumer subscription tokens.
/// When an operator chooses a built-in provider in read-only mode, Helmion invokes
/// that provider's official local CLI instead. Tool-capable work remains on the
/// existing AgentBridge/API connection path because a CLI plan-mode turn cannot
/// safely participate in Helmion's approval protocol.
/// </summary>
public static class ProviderOwnedTurnRouting
{
    public enum Kind
    {
        AgentBridge,
        CodexCli,
        ClaudeCli,
        GeminiCli,
        GrokCli,
    }

    public sealed record Decision(Kind Kind, string? Reason = null);

    public static Decision Decide(string? provider, string? permissionMode)
    {
        if (AgentPermission.Normalize(permissionMode) != AgentPermission.ReadOnly)
        {
            return new Decision(Kind.AgentBridge);
        }

        return MaestroKey.Normalize(provider) switch
        {
            MaestroKey.OpenAi => new Decision(Kind.CodexCli),
            MaestroKey.Claude => new Decision(Kind.ClaudeCli),
            MaestroKey.Gemini => new Decision(Kind.GeminiCli),
            MaestroKey.Grok => new Decision(Kind.GrokCli),
            _ => new Decision(Kind.AgentBridge),
        };
    }
}
