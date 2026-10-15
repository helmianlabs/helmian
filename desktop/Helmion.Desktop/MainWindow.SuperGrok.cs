using System.Diagnostics;
using System.Windows;
using System.Windows.Media;
using Helmion.Desktop.Core;

namespace Helmion.Desktop;

/// <summary>
/// "Login with SuperGrok" — the OAuth device-code sign-in for the Grok provider, and the
/// status line that says which credential Grok is actually about to use.
///
/// <para>
/// A SEPARATE PARTIAL, same reason as MainWindow.PlusMenu.cs: MainWindow.xaml.cs is 2,700
/// lines and claimed by other work. The whole flow — endpoints, polling, refresh, DPAPI
/// storage, Grok CLI adoption — lives in Helmion.Desktop.Core (SuperGrokOAuth.cs,
/// SuperGrokTokenStore.cs, SuperGrokCredential.cs) so it can be tested with no window open.
/// This file is only buttons, text, and one browser launch.
/// </para>
///
/// <para>
/// NOTHING HERE EVER RENDERS A TOKEN. The device code panel shows the user code, which is
/// meant to be read aloud and typed into a browser; the access and refresh tokens go straight
/// from the HTTP response into the DPAPI store and are never assigned to a control.
/// </para>
/// </summary>
public partial class MainWindow
{
    private SuperGrokCredentialProvider? _superGrok;
    private CancellationTokenSource? _superGrokLoginCts;

    /// <summary>
    /// Build the credential provider and hand it to the console session. Called once from
    /// MainWindow_Loaded, after the ConsoleSession exists.
    /// </summary>
    private void InitializeSuperGrok()
    {
        try
        {
            _superGrok = new SuperGrokCredentialProvider();
            if (_consoleSession is not null)
            {
                _consoleSession.SuperGrok = _superGrok;
            }
        }
        catch (Exception ex)
        {
            // A broken token store must not stop the app from opening — Grok just falls
            // back to the API key, and the status line says so instead of staying blank.
            SetSuperGrokStatus(
                $"SuperGrok sign-in is unavailable ({ex.Message}). The API key below still works.",
                isError: true);
            return;
        }

        RefreshSuperGrokStatus();
    }

    private void DisposeSuperGrok()
    {
        try { _superGrokLoginCts?.Cancel(); } catch { /* closing */ }
        _superGrokLoginCts?.Dispose();
        _superGrokLoginCts = null;
        _superGrok?.Dispose();
        _superGrok = null;
    }

    /// <summary>Repaint the status line and the Integrations Grok card, without any network call.</summary>
    private void RefreshSuperGrokStatus()
    {
        RefreshSuperGrokStatusLine();
        if (ProviderRegistryList is not null) ShowProviderProfiles();
    }

    /// <summary>
    /// Bind the provider registry, overlaying the live SuperGrok state onto the Grok card
    /// (its catalog row is static) and giving that card a Sign in / Sign out button.
    /// </summary>
    private void ShowProviderProfiles()
    {
        // Status comes from the official Grok CLI's own sign-in: that is what read-only Grok
        // turns (grok -p) actually use.
        var signedIn = GrokCliLogin.HasCliSession();
        _providerProfiles = _providerProfiles
            .Select(profile =>
            {
                if (profile.Id != "grok") return profile;
                return signedIn
                    ? profile with
                    {
                        SetupState = "Signed in (SuperGrok)",
                        Availability = "Signed in through the official Grok app (Grok Build)",
                        ActionLabel = "Sign out"
                    }
                    : profile with
                    {
                        SetupState = "Not configured",
                        ActionLabel = "Sign in with SuperGrok"
                    };
            })
            .ToArray();
        ProviderRegistryList.ItemsSource = null;
        ProviderRegistryList.ItemsSource = _providerProfiles;
    }

    private void ProviderCardAction_Click(object sender, RoutedEventArgs e)
    {
        if ((sender as FrameworkElement)?.Tag as string != "grok") return;
        // The code panel and status line live in Settings; show them, then act.
        NavigateTo("Settings");
        SuperGrokLoginButton?.BringIntoView();
        if (GrokCliLogin.HasCliSession())
        {
            SuperGrokSignOut_Click(sender, e);
            return;
        }
        SuperGrokLogin_Click(sender, e);
    }

    private void RefreshSuperGrokStatusLine()
    {
        if (GrokCliLogin.HasCliSession())
        {
            SetSuperGrokStatus(
                "Signed in through the official Grok app (Grok Build). Read-only Grok turns use it.",
                isError: false);
            return;
        }
        if (_superGrok is null)
        {
            SetSuperGrokStatus("SuperGrok sign-in is unavailable in this session.", isError: true);
            return;
        }

        if (!_superGrok.IsSignedIn)
        {
            var cliAvailable = GrokCliSessionReader.TryRead() is not null;
            SetSuperGrokStatus(
                cliAvailable
                    ? "Not signed in — Grok will use the API key below. A Grok CLI session was "
                        + "found on this machine: press \"Use existing Grok CLI session\" to reuse "
                        + "it without approving a new code."
                    : "Not signed in — Grok will use the API key below.",
                isError: false);
            return;
        }

        var who = string.IsNullOrWhiteSpace(_superGrok.SignedInEmail)
            ? ""
            : $" as {_superGrok.SignedInEmail}";
        var via = _superGrok.SessionOrigin == SuperGrokTokens.OriginGrokCli
            ? " (adopted from the Grok CLI)"
            : "";
        var expiry = _superGrok.SessionExpiresAt is { } at
            ? $" · session renews after {at.ToLocalTime():t}"
            : "";
        var problem = _superGrok.LastAuthMessage is { } message ? $" · {message}" : "";

        SetSuperGrokStatus(
            $"Using SuperGrok subscription{who}{via}{expiry}{problem}",
            isError: _superGrok.LastAuthMessage is not null);
    }

    private string? _grokLoginUrl;

    /// <summary>
    /// Sign the official Grok CLI in by running <c>grok login --device-auth</c> hidden. The URL
    /// and user code it prints are shown here with an Open browser button; when the CLI exits
    /// the status is re-read from its auth file (read-only).
    /// </summary>
    private async void SuperGrokLogin_Click(object sender, RoutedEventArgs e)
    {
        _superGrokLoginCts?.Cancel();
        _superGrokLoginCts?.Dispose();
        _superGrokLoginCts = new CancellationTokenSource();
        var cancellationToken = _superGrokLoginCts.Token;

        SuperGrokLoginButton.IsEnabled = false;
        _grokLoginUrl = null;
        SuperGrokUserCodeText.Text = "";
        SuperGrokVerificationUriText.Text = "";
        SuperGrokOpenBrowserButton.IsEnabled = false;
        SetSuperGrokStatus("Starting the Grok sign-in…", isError: false);

        void OnLine(string line)
        {
            var url = GrokCliLogin.ParseVerificationUrl(line);
            var code = GrokCliLogin.ParseUserCode(line);
            if (url is null && code is null) return;
            Dispatcher.InvokeAsync(() =>
            {
                if (url is not null && _grokLoginUrl is null)
                {
                    _grokLoginUrl = url;
                    SuperGrokVerificationUriText.Text =
                        $"Press Open browser (or go to {url}), sign in with your Grok account, and enter the code above.";
                    SuperGrokOpenBrowserButton.IsEnabled = true;
                }
                if (code is not null && string.IsNullOrEmpty(SuperGrokUserCodeText.Text))
                {
                    SuperGrokUserCodeText.Text = code;
                }
                SuperGrokCodePanel.Visibility = Visibility.Visible;
                SetSuperGrokStatus("Waiting for you to approve the sign-in in your browser…", isError: false);
            });
        }

        try
        {
            var result = await GrokCliLogin.RunLoginAsync(OnLine, cancellationToken);
            SuperGrokCodePanel.Visibility = Visibility.Collapsed;
            SuperGrokUserCodeText.Text = "";
            if (!result.Started)
            {
                SetSuperGrokStatus(GrokCliLogin.NotInstalledMessage, isError: true);
                return;
            }

            RefreshSuperGrokStatus();
            if (GrokCliLogin.HasCliSession())
            {
                AppendConsoleLine("[Grok → signed in through the official Grok app]");
            }
            else
            {
                var friendly = GrokCliLogin.FriendlyError(result.Output.Trim());
                SetSuperGrokStatus(
                    friendly == GrokCliLogin.PlanMissingMessage
                        ? friendly
                        : "Sign-in didn't finish. Press Login with SuperGrok to try again."
                            + (string.IsNullOrWhiteSpace(friendly) ? "" : $" ({LastLine(friendly)})"),
                    isError: true);
            }
        }
        catch (OperationCanceledException)
        {
            SuperGrokCodePanel.Visibility = Visibility.Collapsed;
            SuperGrokUserCodeText.Text = "";
            SetSuperGrokStatus("Sign-in cancelled or timed out. Nothing was changed.", isError: false);
        }
        finally
        {
            SuperGrokLoginButton.IsEnabled = true;
        }
    }

    private static string LastLine(string text)
    {
        var lines = text.Split('\n', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
        var last = lines.Length == 0 ? text : lines[^1];
        return last.Length <= 160 ? last : last[..160];
    }

    private void SuperGrokOpenBrowser_Click(object sender, RoutedEventArgs e)
    {
        if (_grokLoginUrl is not null) OpenInBrowser(_grokLoginUrl);
    }

    /// <summary>
    /// Adopt the official Grok CLI's existing session instead of approving a second device
    /// code. Reads one known file, read-only, only when the user presses this button.
    /// </summary>
    private void SuperGrokUseCli_Click(object sender, RoutedEventArgs e)
    {
        if (_superGrok is null)
        {
            SetSuperGrokStatus("SuperGrok sign-in is unavailable in this session.", isError: true);
            return;
        }

        SuperGrokTokens? cliSession;
        try
        {
            cliSession = GrokCliSessionReader.TryRead();
        }
        catch (Exception ex)
        {
            SetSuperGrokStatus(
                $"Could not read the Grok CLI session ({ex.Message}). "
                + "Press \"Login with SuperGrok\" instead.",
                isError: true);
            return;
        }

        if (cliSession is null)
        {
            SetSuperGrokStatus(
                "No usable Grok CLI session found at "
                + $"{GrokCliSessionReader.DefaultAuthFilePath()} — it is missing, or its sign-in "
                + "has expired. Press \"Login with SuperGrok\" instead.",
                isError: true);
            return;
        }

        _superGrok.Adopt(cliSession);
        ApplySuperGrokToConsole();
        RefreshSuperGrokStatus();
        AppendConsoleLine("[Grok → adopted the existing Grok CLI sign-in · that CLI was not modified]");
    }

    private async void SuperGrokSignOut_Click(object sender, RoutedEventArgs e)
    {
        _superGrokLoginCts?.Cancel();
        SuperGrokCodePanel.Visibility = Visibility.Collapsed;
        SuperGrokUserCodeText.Text = "";

        // Older builds kept a separate desktop copy of the sign-in; clear it too.
        _superGrok?.SignOut();
        ApplySuperGrokToConsole();

        if (GrokCliLogin.HasCliSession())
        {
            try
            {
                var result = await GrokCliLogin.RunLogoutAsync(CancellationToken.None);
                if (!result.Started)
                {
                    SetSuperGrokStatus(GrokCliLogin.NotInstalledMessage, isError: true);
                    return;
                }
            }
            catch (OperationCanceledException)
            {
                SetSuperGrokStatus("Sign-out timed out. Try again.", isError: true);
                return;
            }
        }

        RefreshSuperGrokStatus();
        AppendConsoleLine("[Grok → signed out · falling back to the API key if one is set]");
    }

    private void ApplySuperGrokToConsole()
    {
        if (_consoleSession is not null)
        {
            _consoleSession.SuperGrok = _superGrok;
        }
    }

    private void SetSuperGrokStatus(string text, bool isError)
    {
        SuperGrokStatusLabel.Text = text;
        SuperGrokStatusLabel.Foreground = isError
            ? (Brush)FindResource("AmberBrush")
            : (Brush)FindResource("MutedTextBrush");
    }

    private void OpenInBrowser(string url)
    {
        try
        {
            Process.Start(new ProcessStartInfo(url) { UseShellExecute = true });
        }
        catch (Exception ex)
        {
            // The code panel is already on screen with the URL in it, so a failed launch is
            // recoverable by hand — say that rather than aborting the sign-in.
            SetSuperGrokStatus(
                $"Could not open your browser ({ex.Message}). Open the address shown above "
                + "manually and enter the code.",
                isError: true);
        }
    }
}
