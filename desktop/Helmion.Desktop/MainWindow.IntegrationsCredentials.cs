using System;
using System.Collections.Generic;
using System.Net.Http;
using System.Threading.Tasks;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Media;
using Helmion.Desktop.Core;

namespace Helmion.Desktop;

// The Integrations "Sign in to your AI" cards — the desktop twin of the
// web app's cards (web/marketing/app/integrations-view.mjs), same section
// title, same providers, same words (ProviderCredentialCards in Core
// carries the catalog). Each seat card carries Email + Password +
// Connect, and every card — seats and tool cards alike — carries the
// API-key slot Troy ordered 2026-11-04 (a seat's backup door; a tool
// service's only road). Every save posts to the SAME cloud credential
// vault the web cards write, under the desktop link token, which
// carries the owner's subject and role. Nothing is stored on this PC:
// the fields clear the moment a save succeeds, and card state is read
// back from the workspace's connection rows, never from local storage.
public partial class MainWindow
{
    private readonly Dictionary<string, TextBlock> _credentialStatusByProvider = new(StringComparer.Ordinal);
    private bool _credentialCardsBuilt;

    private async void IntegrationsPage_IsVisibleChanged(object sender, DependencyPropertyChangedEventArgs e)
    {
        if (e.NewValue is not true) return;
        BuildCredentialCards();
        await RefreshCredentialStatusesAsync();
    }

    private void BuildCredentialCards()
    {
        if (_credentialCardsBuilt) return;
        _credentialCardsBuilt = true;
        foreach (var card in ProviderCredentialCards.All)
            CredentialCardsHost.Children.Add(BuildCredentialCard(card));
    }

    private StackPanel BuildCredentialCard(ProviderCredentialCard card)
    {
        var panel = new StackPanel { Margin = new Thickness(0, 14, 0, 0) };
        var name = new TextBlock { Text = card.Name, FontWeight = FontWeights.SemiBold, FontSize = 13 };
        panel.Children.Add(name);
        panel.Children.Add(new TextBlock
        {
            Text = card.Blurb,
            FontSize = 11,
            Foreground = (Brush)FindResource("FaintTextBrush"),
            Margin = new Thickness(0, 2, 0, 0),
        });
        var status = new TextBlock
        {
            Text = ProviderCredentialCards.StatusText(null),
            FontSize = 11,
            Margin = new Thickness(0, 4, 0, 0),
        };
        panel.Children.Add(status);
        _credentialStatusByProvider[card.ProviderId] = status;

        var feedback = new TextBlock { FontSize = 11, Margin = new Thickness(0, 6, 0, 0), TextWrapping = TextWrapping.Wrap };

        if (card.HasPasswordRoad)
        {
            var email = new TextBox { Height = 30, Margin = new Thickness(0, 8, 0, 0) };
            var password = new PasswordBox { Height = 30, Margin = new Thickness(0, 6, 0, 0) };
            var connect = new Button
            {
                Content = "Connect",
                MinWidth = 96,
                Padding = new Thickness(14, 8, 14, 8),
                Margin = new Thickness(0, 8, 0, 0),
                HorizontalAlignment = HorizontalAlignment.Left,
                Style = (Style)FindResource("PrimaryButtonStyle"),
            };
            connect.Click += async (_, _) => await SaveCredentialAsync(status, feedback, connect,
                (client, token) => client.ConnectCredentialAsync(token, card.ProviderId, email.Text.Trim(), password.Password),
                () => password.Clear());
            panel.Children.Add(FieldLabel("Email"));
            panel.Children.Add(email);
            panel.Children.Add(FieldLabel("Password"));
            panel.Children.Add(password);
            panel.Children.Add(connect);
        }

        var apiKey = new PasswordBox { Height = 30, Margin = new Thickness(0, 6, 0, 0) };
        var saveKey = new Button
        {
            Content = "Save API key",
            MinWidth = 110,
            Padding = new Thickness(14, 8, 14, 8),
            Margin = new Thickness(0, 8, 0, 0),
            HorizontalAlignment = HorizontalAlignment.Left,
            Style = (Style)FindResource("ConsoleNeutralButtonStyle"),
        };
        saveKey.Click += async (_, _) => await SaveCredentialAsync(status, feedback, saveKey,
            (client, token) => client.StoreApiKeyAsync(token, card.ProviderId, apiKey.Password),
            () => apiKey.Clear());
        panel.Children.Add(FieldLabel(card.HasPasswordRoad ? "API key (backup)" : "API key"));
        panel.Children.Add(apiKey);
        panel.Children.Add(saveKey);
        panel.Children.Add(feedback);
        return panel;
    }

    private TextBlock FieldLabel(string text) => new()
    {
        Text = text,
        FontSize = 11,
        Foreground = (Brush)FindResource("FaintTextBrush"),
        Margin = new Thickness(0, 10, 0, 0),
    };

    private async Task SaveCredentialAsync(
        TextBlock status,
        TextBlock feedback,
        Button button,
        Func<EnvoyCloudChatClient, string, Task<EnvoyProviderConnection?>> save,
        Action clearSecret)
    {
        var link = _accountLinkStore.Load();
        if (link is null)
        {
            feedback.Text = "Link this computer from Team Chat first.";
            return;
        }
        button.IsEnabled = false;
        feedback.Text = "Saving…";
        try
        {
            var client = new EnvoyCloudChatClient(AccountHttp, new Uri(link.Origin));
            var connection = await save(client, link.Token);
            clearSecret();
            if (connection is not null) status.Text = ProviderCredentialCards.StatusText(connection.AuthMode);
            feedback.Text = "Saved to your workspace vault.";
        }
        catch (UnauthorizedAccessException ex)
        {
            feedback.Text = ex.Message;
        }
        catch (Exception ex) when (ex is HttpRequestException or InvalidOperationException or ArgumentException)
        {
            feedback.Text = ex is ArgumentException
                ? "Fill in every field first."
                : "Could not save. Check your connection and try again.";
        }
        finally
        {
            button.IsEnabled = true;
        }
    }

    private async Task RefreshCredentialStatusesAsync()
    {
        var link = _accountLinkStore.Load();
        if (link is null)
        {
            foreach (var status in _credentialStatusByProvider.Values)
                status.Text = "Link this computer from Team Chat to connect your AI accounts.";
            return;
        }
        try
        {
            var client = new EnvoyCloudChatClient(AccountHttp, new Uri(link.Origin));
            var rows = await client.ListConnectionsAsync(link.Token);
            var byProvider = new Dictionary<string, EnvoyProviderConnection>(StringComparer.Ordinal);
            foreach (var row in rows) byProvider[row.ProviderId] = row;
            foreach (var (providerId, status) in _credentialStatusByProvider)
                status.Text = ProviderCredentialCards.StatusText(
                    byProvider.TryGetValue(providerId, out var row) ? row.AuthMode : null);
        }
        catch (Exception ex) when (ex is HttpRequestException or InvalidOperationException or UnauthorizedAccessException)
        {
            // Card state is a read-back nicety; a failed read leaves the
            // neutral "Not connected" word rather than blocking the page.
        }
    }
}
