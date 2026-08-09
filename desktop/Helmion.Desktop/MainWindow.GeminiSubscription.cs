using System.Diagnostics;
using System.Windows;
using System.Windows.Media;
using Helmion.Desktop.Core;

namespace Helmion.Desktop;

/// <summary>
/// Google/Gemini subscription status + login trigger.
///
/// <para>
/// REWORKED 2026-08-04 — same reasoning as MainWindow.ChatGpt.cs: Google's subscription chat
/// backend (cloudcode-pa.googleapis.com) requires a Cloud-project-onboarding step Helmion has no
/// verified way to replicate, so this adopts the Gemini CLI's own login (read-only, via
/// GeminiCliSessionReader) instead of driving OAuth itself, and chat turns shell out to
/// `gemini -p` (ProviderCliChatSession.SendToGeminiAsync).
/// </para>
/// </summary>
public partial class MainWindow
{
    private void InitializeGeminiSubscription() => RefreshGeminiSubscriptionStatus();

    /// <summary>No-op — kept so OnClosing's call site doesn't need touching.</summary>
    private void DisposeGeminiSubscription() { }

    private void RefreshGeminiSubscriptionStatus()
    {
        ProviderCliSession? session;
        try
        {
            session = GeminiCliSessionReader.TryRead();
        }
        catch (Exception ex)
        {
            SetGeminiSubscriptionStatus($"Could not check Gemini CLI login ({ex.Message}).", isError: true);
            return;
        }

        if (session is null)
        {
            SetGeminiSubscriptionStatus(
                "Not signed in — Gemini will use the API key below. Run \"gemini\" in a terminal "
                + "once to sign in with your Google account, then press \"Check again\".",
                isError: false);
            return;
        }

        if (session.IsExpired(DateTimeOffset.UtcNow))
        {
            SetGeminiSubscriptionStatus(
                "The Gemini CLI login has expired. Run \"gemini\" again to renew it, then press "
                + "\"Check again\".",
                isError: true);
            return;
        }

        var who = string.IsNullOrWhiteSpace(session.Email) ? "" : $" as {session.Email}";
        SetGeminiSubscriptionStatus($"Using Google subscription{who} · via the Gemini CLI", isError: false);
    }

    private void GeminiLogin_Click(object sender, RoutedEventArgs e)
    {
        try
        {
            // No dedicated "login" subcommand is confirmed for this CLI (unlike codex login) —
            // launching it interactively is what triggers its own first-run sign-in prompt.
            Process.Start(new ProcessStartInfo("gemini", "") { UseShellExecute = true });
            SetGeminiSubscriptionStatus(
                "Opened the Gemini CLI — finish signing in there, then press \"Check again\".",
                isError: false);
        }
        catch (Exception ex)
        {
            SetGeminiSubscriptionStatus(
                $"Could not launch the Gemini CLI ({ex.Message}). Install it and run \"gemini\" "
                + "yourself in a terminal to sign in.",
                isError: true);
        }
    }

    private void GeminiCheckAgain_Click(object sender, RoutedEventArgs e) => RefreshGeminiSubscriptionStatus();

    private void GeminiSignOut_Click(object sender, RoutedEventArgs e)
    {
        RefreshGeminiSubscriptionStatus();
        AppendConsoleLine(
            "[Gemini → sign out from within the Gemini CLI itself · Helmion only reads its login, "
            + "never clears it]");
    }

    private void SetGeminiSubscriptionStatus(string text, bool isError)
    {
        GeminiSubscriptionStatusLabel.Text = text;
        GeminiSubscriptionStatusLabel.Foreground = isError
            ? (Brush)FindResource("AmberBrush")
            : (Brush)FindResource("MutedTextBrush");
    }
}
