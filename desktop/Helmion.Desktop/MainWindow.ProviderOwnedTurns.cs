using System.Text;
using Helmion.Desktop.Core;

namespace Helmion.Desktop;

/// <summary>
/// The desktop-only subscription route. It deliberately does not pass consumer
/// session material into Node, a cloud process, or Helmion's tool executor.
/// </summary>
public partial class MainWindow
{
    /// <summary>
    /// Runs an official local provider CLI only for read-only turns. Returns false
    /// when the existing AgentBridge should retain ownership of the turn.
    /// </summary>
    private async Task<bool> TryRunProviderOwnedReadOnlyTurnAsync(
        string provider,
        string permission,
        string prompt,
        bool hasImages,
        AgentSession? session,
        CancellationToken cancellationToken)
    {
        var decision = ProviderOwnedTurnRouting.Decide(provider, permission);
        if (decision.Kind == ProviderOwnedTurnRouting.Kind.AgentBridge) return false;

        if (hasImages)
        {
            const string message =
                "This read-only provider session does not send image attachments. Remove the image, "
                + "or use an approved API connection for an attachment-capable agent turn.";
            AppendConsoleLine($"Action needed — {message}");
            ReportProviderOwnedTurn(session, provider, message, failed: true);
            return true;
        }

        ConsoleServiceSessionText.Text = $"Provider-owned session · {provider} · read-only";
        AppendConsoleLine(session?.Name ?? "Maestro");

        ProviderCliChatResult? result = null;
        switch (decision.Kind)
        {
            case ProviderOwnedTurnRouting.Kind.CodexCli:
                await foreach (var item in ProviderCliChatSession.SendToCodexAsync(prompt, cancellationToken))
                    result = item;
                break;
            case ProviderOwnedTurnRouting.Kind.ClaudeCli:
                await foreach (var item in ProviderCliChatSession.SendToClaudeAsync(prompt, cancellationToken))
                    result = item;
                break;
            case ProviderOwnedTurnRouting.Kind.GeminiCli:
                await foreach (var item in ProviderCliChatSession.SendToGeminiAsync(prompt, cancellationToken))
                    result = item;
                break;
            case ProviderOwnedTurnRouting.Kind.GrokCli:
                await foreach (var item in ProviderCliChatSession.SendToGrokAsync(prompt, cancellationToken))
                    result = item;
                break;
        }

        if (result is null || result.IsError)
        {
            var message = result?.Text ?? "The provider-owned CLI returned no result.";
            AppendConsoleLine($"Action needed — {message}");
            ReportProviderOwnedTurn(session, provider, message, failed: true);
            return true;
        }

        if (!string.IsNullOrWhiteSpace(result.Text))
        {
            AppendConsoleLine(result.Text);
        }
        AppendConsoleLine("");
        ReportProviderOwnedTurn(session, provider, "Read-only provider-owned session completed.", failed: false);

        if (_voiceSession is { IsVoiceModeActive: true } && !string.IsNullOrWhiteSpace(result.Text))
        {
            try
            {
                await _voiceSession.SpeakAsync(result.Text);
            }
            catch (Exception voiceEx)
            {
                AppendConsoleLine($"[Voice TTS error: {voiceEx.Message}]");
            }
        }

        return true;
    }

    private void ReportProviderOwnedTurn(
        AgentSession? session,
        string provider,
        string detail,
        bool failed)
    {
        if (session is null) return;

        ReportSessionTurn(
            session,
            failed ? GuardLevel.Warning : GuardLevel.Normal,
            failed
                ? $"\"{session.Name}\" provider session needs attention"
                : $"\"{session.Name}\" completed a provider session turn",
            $"{provider}: {detail}");
    }
}
