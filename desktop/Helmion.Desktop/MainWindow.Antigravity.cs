using System.Diagnostics;
using System.IO;
using System.Windows;
using System.Windows.Media;
using Helmion.Desktop.Core;

namespace Helmion.Desktop;

/// <summary>
/// Antigravity (Google) subscription status.
///
/// <para>
/// Mirrors MainWindow.ChatGpt.cs / MainWindow.GeminiSubscription.cs: Helmion never drives the
/// OAuth flow itself and never writes to the CLI's own state. It reads whether Antigravity's CLI
/// already holds an authenticated session (AntigravityCliSessionReader.TryReadAuthenticatedEmail,
/// which tails the CLI's own log) and reports that.
/// </para>
/// <para>
/// Antigravity has no login subcommand of its own — the CLI shares whatever session the
/// Antigravity desktop app established. So "Sign in" here launches the CLI interactively, which
/// is what triggers its first-run sign-in, exactly as GeminiLogin_Click does for `gemini`.
/// </para>
/// <para>
/// SCOPE, stated plainly so nobody reads more into this panel than it does: like the ChatGPT,
/// Gemini and Claude panels beside it, this reports sign-in status only. It does not change where
/// a chat turn goes. Turns are routed by AgentBridge.TurnAsync to the Node agent
/// (src/agent/env.mjs resolveProvider), which has no antigravity provider id, and
/// ProviderCliChatSession.SendToAntigravityAsync currently has no caller.
/// </para>
/// </summary>
public partial class MainWindow
{
    private void InitializeAntigravity() => RefreshAntigravityStatus();

    /// <summary>No-op — kept so OnClosing's call site doesn't need touching. Nothing here owns a
    /// live resource.</summary>
    private void DisposeAntigravity() { }

    private void RefreshAntigravityStatus()
    {
        if (!File.Exists(AntigravityCliSessionReader.ExecutablePath()))
        {
            SetAntigravityStatus(
                "Antigravity CLI is not installed on this machine. Install it from "
                + "antigravity.google/cli/install, sign in, then press \"Check again\".",
                isError: false);
            return;
        }

        string? email;
        try
        {
            email = AntigravityCliSessionReader.TryReadAuthenticatedEmail();
        }
        catch (Exception ex)
        {
            SetAntigravityStatus($"Could not check the Antigravity CLI login ({ex.Message}).", isError: true);
            return;
        }

        if (string.IsNullOrWhiteSpace(email))
        {
            SetAntigravityStatus(
                "Antigravity CLI is installed but not signed in. Press \"Sign in\" (or open the "
                + "Antigravity desktop app) to sign in with your Google account, then press "
                + "\"Check again\".",
                isError: false);
            return;
        }

        SetAntigravityStatus($"Antigravity CLI signed in as {email}", isError: false);
    }

    private void AntigravityLogin_Click(object sender, RoutedEventArgs e)
    {
        try
        {
            // Antigravity has no login subcommand — launching the CLI interactively is what
            // triggers its own sign-in, same as GeminiLogin_Click. Full path, not PATH: the
            // installer drops agy.exe under %LOCALAPPDATA% and does not always put it on PATH.
            Process.Start(new ProcessStartInfo(AntigravityCliSessionReader.ExecutablePath())
            {
                UseShellExecute = true,
            });
            SetAntigravityStatus(
                "Opened the Antigravity CLI — finish signing in there, then press \"Check again\".",
                isError: false);
        }
        catch (Exception ex)
        {
            SetAntigravityStatus(
                $"Could not launch the Antigravity CLI ({ex.Message}). Install it from "
                + "antigravity.google/cli/install and sign in yourself.",
                isError: true);
        }
    }

    private void AntigravityCheckAgain_Click(object sender, RoutedEventArgs e) => RefreshAntigravityStatus();

    private void AntigravitySignOut_Click(object sender, RoutedEventArgs e)
    {
        RefreshAntigravityStatus();
        AppendConsoleLine(
            "[Antigravity → sign out from the Antigravity app or CLI itself · Helmion only reads "
            + "its login, never clears it]");
    }

    private void SetAntigravityStatus(string text, bool isError)
    {
        AntigravityStatusLabel.Text = text;
        AntigravityStatusLabel.Foreground = isError
            ? (Brush)FindResource("AmberBrush")
            : (Brush)FindResource("MutedTextBrush");
    }
}
