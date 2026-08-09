using System.Windows;
using System.Windows.Media;
using Helmion.Desktop.Core;

namespace Helmion.Desktop;

/// <summary>
/// Paste-a-token sign-in for the Claude provider. Unlike SuperGrok/ChatGPT/Gemini, Anthropic
/// does not allow a third-party app to drive its own browser OAuth flow against a Pro/Max
/// subscription — see ClaudeSubscriptionCredential.cs for the citations. The sanctioned path is
/// "claude setup-token" run by the user in their own terminal; this file just accepts what they
/// paste back.
/// </summary>
public partial class MainWindow
{
    private ClaudeSubscriptionCredentialProvider? _claudeSubscription;

    private void InitializeClaudeSubscription()
    {
        try
        {
            _claudeSubscription = new ClaudeSubscriptionCredentialProvider();
        }
        catch (Exception ex)
        {
            SetClaudeSubscriptionStatus(
                $"Claude subscription sign-in is unavailable ({ex.Message}). The API key below "
                + "still works.",
                isError: true);
            return;
        }

        RefreshClaudeSubscriptionStatus();
    }

    private void RefreshClaudeSubscriptionStatus()
    {
        if (_claudeSubscription is null)
        {
            SetClaudeSubscriptionStatus("Claude subscription sign-in is unavailable in this session.", isError: true);
            return;
        }

        if (!_claudeSubscription.IsSignedIn)
        {
            SetClaudeSubscriptionStatus(
                "No token saved — Claude will use the API key below. Run \"claude setup-token\" "
                + "in a terminal and paste the result above.",
                isError: false);
            return;
        }

        var who = string.IsNullOrWhiteSpace(_claudeSubscription.SignedInEmail)
            ? ""
            : $" as {_claudeSubscription.SignedInEmail}";
        var expiry = _claudeSubscription.TokenExpiresAt is { } at
            ? $" · expires {at.ToLocalTime():d}"
            : "";
        SetClaudeSubscriptionStatus($"Using Claude subscription{who}{expiry}", isError: false);
    }

    private void ClaudeSaveToken_Click(object sender, RoutedEventArgs e)
    {
        if (_claudeSubscription is null)
        {
            SetClaudeSubscriptionStatus("Claude subscription sign-in is unavailable in this session.", isError: true);
            return;
        }

        try
        {
            _claudeSubscription.SaveToken(ClaudeSetupTokenInput.Text);
            ClaudeSetupTokenInput.Text = "";
            RefreshClaudeSubscriptionStatus();
            AppendConsoleLine("[Claude → saved a subscription token from \"claude setup-token\"]");
        }
        catch (ClaudeSubscriptionAuthException ex)
        {
            SetClaudeSubscriptionStatus(ex.Message, isError: true);
        }
    }

    private void ClaudeSignOut_Click(object sender, RoutedEventArgs e)
    {
        _claudeSubscription?.SignOut();
        RefreshClaudeSubscriptionStatus();
        AppendConsoleLine("[Claude → cleared the saved subscription token · falling back to the API key if one is set]");
    }

    private void SetClaudeSubscriptionStatus(string text, bool isError)
    {
        ClaudeSubscriptionStatusLabel.Text = text;
        ClaudeSubscriptionStatusLabel.Foreground = isError
            ? (Brush)FindResource("AmberBrush")
            : (Brush)FindResource("MutedTextBrush");
    }
}
