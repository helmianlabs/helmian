using System.Diagnostics;
using System.Windows;
using System.Windows.Media;
using Helmion.Desktop.Core;

namespace Helmion.Desktop;

/// <summary>
/// ChatGPT subscription status + login trigger.
///
/// <para>
/// REWORKED 2026-08-04: no longer drives its own browser OAuth flow. OpenAI's subscription chat
/// backend is undocumented (see ProviderCliChatSession.cs remarks) and Anthropic-style raw
/// bearer-token reuse risks silently breaking. Instead this adopts the OpenAI Codex CLI's own
/// login (read-only, via CodexCliSessionReader) and, when signed in, chat turns shell out to
/// `codex exec` (ProviderCliChatSession.SendToCodexAsync) so the CLI — which already knows the
/// correct private request format — makes the actual call.
/// </para>
/// </summary>
public partial class MainWindow
{
    private void InitializeChatGpt() => RefreshChatGptStatus();

    /// <summary>No-op — kept so OnClosing's call site doesn't need touching. Nothing here owns
    /// a live resource; the CLI subprocess in ProviderCliChatSession is per-request and disposes
    /// itself.</summary>
    private void DisposeChatGpt() { }

    private void RefreshChatGptStatus()
    {
        ProviderCliSession? session;
        try
        {
            session = CodexCliSessionReader.TryRead();
        }
        catch (Exception ex)
        {
            SetChatGptStatus($"Could not check Codex CLI login ({ex.Message}).", isError: true);
            return;
        }

        if (session is null)
        {
            SetChatGptStatus(
                "Not signed in — ChatGPT will use the API key below. Run \"codex login\" in a "
                + "terminal to sign in with your ChatGPT subscription, then press \"Check again\".",
                isError: false);
            return;
        }

        if (session.IsExpired(DateTimeOffset.UtcNow))
        {
            SetChatGptStatus(
                "The Codex CLI login has expired. Run \"codex login\" again, then press "
                + "\"Check again\".",
                isError: true);
            return;
        }

        var who = string.IsNullOrWhiteSpace(session.Email) ? "" : $" as {session.Email}";
        SetChatGptStatus($"Using ChatGPT subscription{who} · via the Codex CLI", isError: false);
    }

    private void ChatGptLogin_Click(object sender, RoutedEventArgs e)
    {
        try
        {
            Process.Start(new ProcessStartInfo("codex", "login") { UseShellExecute = true });
            SetChatGptStatus(
                "Opened \"codex login\" — finish signing in there, then press \"Check again\".",
                isError: false);
        }
        catch (Exception ex)
        {
            SetChatGptStatus(
                $"Could not launch the Codex CLI ({ex.Message}). Install it and run "
                + "\"codex login\" yourself in a terminal.",
                isError: true);
        }
    }

    private void ChatGptCheckAgain_Click(object sender, RoutedEventArgs e) => RefreshChatGptStatus();

    private void ChatGptSignOut_Click(object sender, RoutedEventArgs e)
    {
        // Read-only by design (mirrors GrokCliSessionReader) — Helmion never rewrites the CLI's
        // own auth file. Sign-out happens in the CLI itself.
        try
        {
            Process.Start(new ProcessStartInfo("codex", "logout") { UseShellExecute = true, CreateNoWindow = true });
        }
        catch { /* best effort */ }
        RefreshChatGptStatus();
        AppendConsoleLine("[ChatGPT → ran \"codex logout\" · falling back to the API key if one is set]");
    }

    private void SetChatGptStatus(string text, bool isError)
    {
        ChatGptStatusLabel.Text = text;
        ChatGptStatusLabel.Foreground = isError
            ? (Brush)FindResource("AmberBrush")
            : (Brush)FindResource("MutedTextBrush");
    }
}
