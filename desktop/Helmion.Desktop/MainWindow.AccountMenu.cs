using System;
using System.Diagnostics;
using System.Net.Http;
using System.Threading.Tasks;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Controls.Primitives;
using Helmion.Desktop.Core;

namespace Helmion.Desktop;

// The bottom-corner account menu in the sidebar foot — the desktop twin of
// the web app's account menu (web/marketing/app/account-menu.mjs). Same
// items, same order, same words (DesktopAccountMenu in Core carries the
// list): Settings, Keyboard shortcuts, Download apps, Report an issue,
// Log out. The button itself carries the identity headline, like the web's
// sidebar foot: the linked workspace's name, or "Account" when this PC is
// not linked.
//
// Log out is the guarantee, not the mechanism: the desktop holds no Clerk
// session, it holds the Envoy desktop link token. Logging out revokes that
// token on the server (EnvoyCloudChatClient.UnlinkAsync →
// POST /api/admin/desktop/link/revoke; the server's token check refuses
// revoked tokens) and clears the local DPAPI copy, so signing out ends
// access — the same promise the web's sign-out makes. The revoke is best
// effort (a dead network must not trap the token on this PC); the local
// clear always runs.
public partial class MainWindow
{
    private readonly EnvoyCloudLinkStore _accountLinkStore = new();
    private static readonly HttpClient AccountHttp = new() { Timeout = TimeSpan.FromSeconds(20) };

    /// <summary>Re-read the link and repaint the account button + the Settings identity card.</summary>
    internal void RefreshAccountIdentity()
    {
        var link = _accountLinkStore.Load();
        var headline = DesktopAccountMenu.IdentityHeadline(link);
        AccountButton.Content = link is null ? "Account" : headline;
        AccountButton.ToolTip = link is null
            ? "Account — not linked to helmian.cloud yet"
            : $"{headline} — account";
        SettingsAccountHeadline.Text = headline;
        SettingsAccountDetail.Text = DesktopAccountMenu.IdentityDetail(link);
        SettingsAccountLogOutButton.Visibility = link is null ? Visibility.Collapsed : Visibility.Visible;
    }

    private void AccountButton_Click(object sender, RoutedEventArgs e)
    {
        RefreshAccountIdentity();
        var link = _accountLinkStore.Load();
        var menu = new ContextMenu();
        menu.Items.Add(new MenuItem { Header = DesktopAccountMenu.IdentityHeadline(link), IsEnabled = false });
        menu.Items.Add(new Separator());
        foreach (var item in DesktopAccountMenu.Items)
        {
            var entry = new MenuItem
            {
                Header = item.Label,
                Tag = item.Id,
                IsEnabled = item.Id != "logout" || link is not null,
            };
            entry.Click += AccountMenuItem_Click;
            menu.Items.Add(entry);
        }
        menu.PlacementTarget = AccountButton;
        menu.Placement = PlacementMode.Top;
        menu.IsOpen = true;
    }

    private async void AccountMenuItem_Click(object sender, RoutedEventArgs e)
    {
        if (sender is not MenuItem { Tag: string id }) return;
        switch (id)
        {
            case "settings":
                NavigateTo("Settings");
                break;
            case "shortcuts":
                MenuShortcuts_Click(sender, e);
                break;
            case "downloads":
                OpenAccountUri(DesktopAccountMenu.DownloadsUri(AccountOrigin()));
                break;
            case "report":
                OpenAccountUri(new Uri(DesktopAccountMenu.ReportIssueHref()));
                break;
            case "logout":
                await LogOutAccountAsync();
                break;
        }
    }

    private void AccountLogOut_Click(object sender, RoutedEventArgs e) => _ = LogOutAccountAsync();

    private async Task LogOutAccountAsync()
    {
        var link = _accountLinkStore.Load();
        if (link is not null)
        {
            try
            {
                await new EnvoyCloudChatClient(AccountHttp, new Uri(link.Origin)).UnlinkAsync(link.Token);
            }
            catch (Exception)
            {
                // Revoke is best effort by design (UnlinkAsync already
                // swallows transport failures; an already-revoked token
                // answers 401). The local clear below always runs.
            }
        }
        _accountLinkStore.Clear();
        TeamChatPanel.HandleAccountSignedOut();
        RefreshAccountIdentity();
    }

    private Uri AccountOrigin()
    {
        var origin = _accountLinkStore.Load()?.Origin;
        return Uri.TryCreate(origin, UriKind.Absolute, out var uri) ? uri : EnvoyCloudChatClient.DefaultOrigin;
    }

    private static void OpenAccountUri(Uri uri)
    {
        try
        {
            Process.Start(new ProcessStartInfo(uri.AbsoluteUri) { UseShellExecute = true });
        }
        catch (Exception)
        {
            // No browser/mail client answered; nothing better to do here.
        }
    }
}
