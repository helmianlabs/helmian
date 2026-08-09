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

    /// <summary>Repaint the status line from the stored session, without any network call.</summary>
    private void RefreshSuperGrokStatus()
    {
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

    private async void SuperGrokLogin_Click(object sender, RoutedEventArgs e)
    {
        if (_superGrok is null)
        {
            SetSuperGrokStatus("SuperGrok sign-in is unavailable in this session.", isError: true);
            return;
        }

        _superGrokLoginCts?.Cancel();
        _superGrokLoginCts?.Dispose();
        _superGrokLoginCts = new CancellationTokenSource();
        var cancellationToken = _superGrokLoginCts.Token;

        SuperGrokLoginButton.IsEnabled = false;
        SetSuperGrokStatus("Asking xAI for a sign-in code…", isError: false);

        try
        {
            using var client = new SuperGrokOAuthClient();
            var device = await client.RequestDeviceCodeAsync(cancellationToken);

            SuperGrokUserCodeText.Text = device.UserCode;
            SuperGrokVerificationUriText.Text =
                $"Go to {device.VerificationUri} and enter the code above. "
                + "Your browser should have opened there already.";
            SuperGrokCodePanel.Visibility = Visibility.Visible;
            SetSuperGrokStatus(
                "Waiting for you to approve the sign-in in your browser…",
                isError: false);

            OpenInBrowser(device.VerificationUriComplete);

            var progress = new Progress<string>(text => SetSuperGrokStatus(text, isError: false));
            var tokens = await client.PollForTokenAsync(device, progress, cancellationToken);

            _superGrok.Adopt(tokens);
            ApplySuperGrokToConsole();
            SuperGrokCodePanel.Visibility = Visibility.Collapsed;
            SuperGrokUserCodeText.Text = "";
            RefreshSuperGrokStatus();
            AppendConsoleLine("[Grok → signed in with SuperGrok subscription]");
        }
        catch (OperationCanceledException)
        {
            SuperGrokCodePanel.Visibility = Visibility.Collapsed;
            SuperGrokUserCodeText.Text = "";
            SetSuperGrokStatus("Sign-in cancelled. Nothing was changed.", isError: false);
        }
        catch (SuperGrokAuthException ex)
        {
            SuperGrokCodePanel.Visibility = Visibility.Collapsed;
            SuperGrokUserCodeText.Text = "";
            SetSuperGrokStatus(ex.Message, isError: true);
        }
        finally
        {
            SuperGrokLoginButton.IsEnabled = true;
        }
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

    private void SuperGrokSignOut_Click(object sender, RoutedEventArgs e)
    {
        _superGrokLoginCts?.Cancel();
        SuperGrokCodePanel.Visibility = Visibility.Collapsed;
        SuperGrokUserCodeText.Text = "";

        _superGrok?.SignOut();
        ApplySuperGrokToConsole();
        RefreshSuperGrokStatus();
        AppendConsoleLine(
            "[Grok → signed out of SuperGrok · falling back to the API key if one is set]");
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
