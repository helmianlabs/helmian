using System.Collections.ObjectModel;
using System.IO;
using System.Net.Http;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;
using System.Windows.Threading;
using Helmion.Desktop.Core;

namespace Helmion.Desktop;

/// <summary>
/// Envoy team chat inside the desktop app, using the same helmian.cloud channel and
/// message APIs as helmian.cloud/app. Polls every few seconds while visible.
/// </summary>
public partial class TeamChatPanel : UserControl
{
    private static readonly HttpClient Http = new() { Timeout = TimeSpan.FromSeconds(20) };
    private readonly EnvoyCloudLinkStore _store = new();
    private readonly ObservableCollection<ChatLine> _lines = [];
    private readonly DispatcherTimer _poll = new() { Interval = TimeSpan.FromSeconds(4) };
    private EnvoyCloudChatClient? _client;
    private EnvoyCloudLink? _link;
    private string? _channelId;
    private bool _busy;

    public TeamChatPanel()
    {
        InitializeComponent();
        MessagesList.ItemsSource = _lines;
        _poll.Tick += async (_, _) => await RefreshMessagesAsync();
    }

    public sealed record ChatLine(string Who, string When, string Body);

    private EnvoyCloudChatClient Client(Uri origin) => _client ??= new EnvoyCloudChatClient(Http, origin);

    private async void TeamChatPanel_IsVisibleChanged(object sender, DependencyPropertyChangedEventArgs e)
    {
        if (!IsVisible) { _poll.Stop(); return; }
        _link ??= _store.Load();
        ShowLinked(_link is not null);
        if (_link is not null) { await LoadChannelsAsync(); _poll.Start(); }
    }

    private void ShowLinked(bool linked)
    {
        LinkCard.Visibility = linked ? Visibility.Collapsed : Visibility.Visible;
        MessagesCard.Visibility = linked ? Visibility.Visible : Visibility.Collapsed;
        Composer.Visibility = linked ? Visibility.Visible : Visibility.Collapsed;
        UnlinkButton.Visibility = linked ? Visibility.Visible : Visibility.Collapsed;
        ChatStatus.Text = linked ? $"Linked to {_link?.Organization ?? "your team"} on helmian.cloud" : "Not linked";
    }

    private async void LinkButton_Click(object sender, RoutedEventArgs e) => await LinkAsync();

    private async void LinkCodeBox_KeyDown(object sender, KeyEventArgs e)
    {
        if (e.Key == Key.Enter) { e.Handled = true; await LinkAsync(); }
    }

    private async Task LinkAsync()
    {
        if (_busy) return;
        LinkError.Visibility = Visibility.Collapsed;
        if (EnvoyCloudChatClient.NormalizeLinkCode(LinkCodeBox.Text) is null)
        {
            ShowLinkError("That code doesn't look right. It has 8 letters and numbers, like ABCD-EFGH.");
            return;
        }
        _busy = true; LinkButton.IsEnabled = false;
        try
        {
            var link = await Client(EnvoyCloudChatClient.OriginFromEnvironment()).LinkAsync(LinkCodeBox.Text);
            _store.Save(link);
            _link = link;
            LinkCodeBox.Clear();
            ShowLinked(true);
            await LoadChannelsAsync();
            _poll.Start();
        }
        catch (Exception ex) when (ex is ArgumentException or InvalidOperationException or InvalidDataException or HttpRequestException or TaskCanceledException)
        {
            ShowLinkError(ex is HttpRequestException or TaskCanceledException ? "Couldn't reach helmian.cloud. Check your connection and try again." : ex.Message);
        }
        finally { _busy = false; LinkButton.IsEnabled = true; }
    }

    private void ShowLinkError(string text) { LinkError.Text = text; LinkError.Visibility = Visibility.Visible; }

    private async Task LoadChannelsAsync()
    {
        if (_link is null) return;
        try
        {
            var channels = await Client(new Uri(_link.Origin)).ListChannelsAsync(_link.Token);
            ChannelBox.ItemsSource = channels;
            ChannelBox.Visibility = channels.Count > 1 ? Visibility.Visible : Visibility.Collapsed;
            if (channels.Count == 0)
            {
                _channelId = null;
                ChatTitle.Text = "Team";
                _lines.Clear();
                _lines.Add(new ChatLine("Helmian", string.Empty, "No team channel yet. An owner can open helmian.cloud/app once to create it."));
                return;
            }
            ChannelBox.SelectedItem = channels.FirstOrDefault(c => c.Id == _channelId) ?? channels[0];
        }
        catch (UnauthorizedAccessException ex) { Unlinked(ex.Message); }
        catch (Exception ex) when (ex is InvalidOperationException or HttpRequestException or TaskCanceledException)
        {
            ChatStatus.Text = "Team chat is reconnecting…";
        }
    }

    private async void ChannelBox_SelectionChanged(object sender, SelectionChangedEventArgs e)
    {
        if (ChannelBox.SelectedItem is not EnvoyChannel channel) return;
        _channelId = channel.Id;
        ChatTitle.Text = channel.Title;
        _lines.Clear();
        await RefreshMessagesAsync();
    }

    private async Task RefreshMessagesAsync()
    {
        if (_link is null || _channelId is null || !IsVisible) return;
        try
        {
            var messages = await Client(new Uri(_link.Origin)).ListMessagesAsync(_link.Token, _channelId);
            var atBottom = MessagesScroll.VerticalOffset >= MessagesScroll.ScrollableHeight - 24;
            _lines.Clear();
            if (messages.Count == 0) _lines.Add(new ChatLine("Helmian", string.Empty, "No messages yet. Say hello below."));
            foreach (var m in messages.OrderBy(m => m.CreatedAt))
            {
                _lines.Add(new ChatLine(
                    m.AuthorKind == "human" ? "Member" : m.AuthorKind,
                    m.CreatedAt?.ToLocalTime().ToString("MMM d, h:mm tt") ?? string.Empty,
                    m.Body));
            }
            if (atBottom) MessagesScroll.ScrollToEnd();
            ChatStatus.Text = $"Linked to {_link.Organization ?? "your team"} on helmian.cloud";
        }
        catch (UnauthorizedAccessException ex) { Unlinked(ex.Message); }
        catch (Exception ex) when (ex is InvalidOperationException or HttpRequestException or TaskCanceledException)
        {
            ChatStatus.Text = "Team chat is reconnecting…";
        }
    }

    private async void SendButton_Click(object sender, RoutedEventArgs e) => await SendAsync();

    private async void MessageBox_KeyDown(object sender, KeyEventArgs e)
    {
        if (e.Key == Key.Enter && (Keyboard.Modifiers & ModifierKeys.Shift) == 0) { e.Handled = true; await SendAsync(); }
    }

    private async Task SendAsync()
    {
        if (_link is null || _channelId is null || string.IsNullOrWhiteSpace(MessageBox.Text) || _busy) return;
        _busy = true; SendButton.IsEnabled = false;
        try
        {
            await Client(new Uri(_link.Origin)).SendMessageAsync(_link.Token, _channelId, MessageBox.Text);
            MessageBox.Clear();
            await RefreshMessagesAsync();
            MessagesScroll.ScrollToEnd();
        }
        catch (UnauthorizedAccessException ex) { Unlinked(ex.Message); }
        catch (Exception ex) when (ex is ArgumentException or InvalidOperationException or HttpRequestException or TaskCanceledException)
        {
            ChatStatus.Text = "Not sent — your message is still in the box.";
        }
        finally { _busy = false; SendButton.IsEnabled = true; }
    }

    private async void UnlinkButton_Click(object sender, RoutedEventArgs e)
    {
        if (_link is not null) await Client(new Uri(_link.Origin)).UnlinkAsync(_link.Token);
        Unlinked("Unlinked. Team chat is off on this computer.");
    }

    private void Unlinked(string message)
    {
        _poll.Stop();
        _store.Clear();
        _link = null; _channelId = null;
        _lines.Clear();
        ShowLinked(false);
        ShowLinkError(message);
    }
}
