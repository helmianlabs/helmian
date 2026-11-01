using System.Collections.ObjectModel;
using System.IO;
using System.Net.Http;
using System.Text.RegularExpressions;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;
using System.Windows.Threading;
using Helmion.Desktop.Core;

namespace Helmion.Desktop;

/// <summary>
/// Envoy team chat inside the desktop app, using the same helmian.cloud channel,
/// message, Free-Willy debate, GitHub link, and Custom Agent APIs as helmian.cloud/app.
/// </summary>
public partial class TeamChatPanel : UserControl
{
    private static readonly HttpClient Http = new() { Timeout = TimeSpan.FromSeconds(20) };
    private readonly EnvoyCloudLinkStore _store = new();
    private readonly ObservableCollection<ChatLine> _lines = [];
    private readonly ObservableCollection<CustomMentionPill> _customPills = [];
    private readonly DispatcherTimer _poll = new() { Interval = TimeSpan.FromSeconds(4) };
    private EnvoyCloudChatClient? _client;
    private EnvoyCloudLink? _link;
    private string? _channelId;
    private EnvoyChannelConfig? _channelConfig;
    private bool _busy;

    public TeamChatPanel()
    {
        InitializeComponent();
        MessagesList.ItemsSource = _lines;
        CustomMentionList.ItemsSource = _customPills;
        _poll.Tick += async (_, _) => await RefreshMessagesAsync();
    }

    public sealed record ChatLine(string Who, string When, string Body);
    public sealed record CustomMentionPill(string Label, string Mention, string Tooltip);

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
        MentionBar.Visibility = linked ? Visibility.Visible : Visibility.Collapsed;
        Composer.Visibility = linked ? Visibility.Visible : Visibility.Collapsed;
        FreeWillyButton.Visibility = linked ? Visibility.Visible : Visibility.Collapsed;
        LinkGitHubButton.Visibility = linked ? Visibility.Visible : Visibility.Collapsed;
        NewCustomAgentButton.Visibility = linked ? Visibility.Visible : Visibility.Collapsed;
        UnlinkButton.Visibility = linked ? Visibility.Visible : Visibility.Collapsed;
        if (!linked)
        {
            GitHubDrawer.Visibility = Visibility.Collapsed;
            CustomAgentDrawer.Visibility = Visibility.Collapsed;
            DebateBadge.Visibility = Visibility.Collapsed;
            GitHubBadge.Visibility = Visibility.Collapsed;
        }
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
        await Task.WhenAll(RefreshChannelConfigAsync(), RefreshMessagesAsync());
    }

    private async Task RefreshChannelConfigAsync()
    {
        if (_link is null || _channelId is null) return;
        try
        {
            _channelConfig = await Client(new Uri(_link.Origin)).GetChannelConfigAsync(_link.Token, _channelId);
            ApplyChannelConfig(_channelConfig);
        }
        catch
        {
            /* non-fatal: keep last known config */
        }
    }

    private void ApplyChannelConfig(EnvoyChannelConfig cfg)
    {
        var debateOn = string.Equals(cfg.DebateMode, "free-willy", StringComparison.OrdinalIgnoreCase);
        DebateBadge.Visibility = debateOn ? Visibility.Visible : Visibility.Collapsed;
        DebateBadgeText.Text = $"Free-Willy ({cfg.MaxRoundTurns} turns)";
        FreeWillyButton.Content = debateOn ? "⚡ Debate: ON" : "⚡ Free-Willy";

        var repo = cfg.Github?.Repo;
        var hasRepo = !string.IsNullOrWhiteSpace(repo);
        GitHubBadge.Visibility = hasRepo ? Visibility.Visible : Visibility.Collapsed;
        GitHubBadgeText.Text = hasRepo ? $"GitHub {repo}" : "GitHub";
        LinkGitHubButton.Content = hasRepo ? "GitHub Linked" : "Link GitHub";
        if (hasRepo && string.IsNullOrWhiteSpace(GitHubRepoBox.Text)) GitHubRepoBox.Text = repo!;

        _customPills.Clear();
        foreach (var ca in cfg.CustomAgents)
        {
            var emoji = string.IsNullOrWhiteSpace(ca.Emoji) ? "🤖" : ca.Emoji;
            _customPills.Add(new CustomMentionPill(
                $"{emoji} @{ca.Handle}",
                $"@{ca.Handle}",
                $"{ca.Name} (@{ca.Handle}) · {ca.Provider}" + (string.IsNullOrWhiteSpace(ca.JobTitle) ? string.Empty : $" · {ca.JobTitle}")));
        }
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
                    EnvoyCloudChatClient.DescribeAuthor(m.AuthorSubject, m.AuthorKind),
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

    private async void FreeWillyButton_Click(object sender, RoutedEventArgs e)
    {
        if (_link is null || _channelId is null || _busy) return;
        var nextOn = !string.Equals(_channelConfig?.DebateMode, "free-willy", StringComparison.OrdinalIgnoreCase);
        _busy = true;
        try
        {
            _channelConfig = await Client(new Uri(_link.Origin)).SetDebateModeAsync(_link.Token, _channelId, nextOn, 12);
            ApplyChannelConfig(_channelConfig);
            ChatStatus.Text = nextOn ? "Free-Willy Debate Mode enabled (12 turns max)." : "Free-Willy Debate Mode turned off.";
            await RefreshMessagesAsync();
        }
        catch (Exception ex)
        {
            ChatStatus.Text = $"Could not update Free-Willy mode: {ex.Message}";
        }
        finally { _busy = false; }
    }

    private void LinkGitHubButton_Click(object sender, RoutedEventArgs e)
    {
        CustomAgentDrawer.Visibility = Visibility.Collapsed;
        GitHubDrawer.Visibility = GitHubDrawer.Visibility == Visibility.Visible ? Visibility.Collapsed : Visibility.Visible;
        if (GitHubDrawer.Visibility == Visibility.Visible)
        {
            GitHubRepoBox.Text = _channelConfig?.Github?.Repo ?? GitHubRepoBox.Text;
            GitHubRepoBox.Focus();
        }
    }

    private async void SaveGitHubButton_Click(object sender, RoutedEventArgs e)
    {
        if (_link is null || _channelId is null || _busy) return;
        _busy = true;
        try
        {
            _channelConfig = await Client(new Uri(_link.Origin)).LinkGitHubAsync(_link.Token, _channelId, GitHubRepoBox.Text);
            ApplyChannelConfig(_channelConfig);
            GitHubDrawer.Visibility = Visibility.Collapsed;
            ChatStatus.Text = $"Linked GitHub repository {_channelConfig.Github?.Repo}.";
            await RefreshMessagesAsync();
        }
        catch (Exception ex)
        {
            ChatStatus.Text = ex.Message;
        }
        finally { _busy = false; }
    }

    private async void RemoveGitHubButton_Click(object sender, RoutedEventArgs e)
    {
        if (_link is null || _channelId is null || _busy) return;
        _busy = true;
        try
        {
            _channelConfig = await Client(new Uri(_link.Origin)).UnlinkGitHubAsync(_link.Token, _channelId);
            GitHubRepoBox.Clear();
            ApplyChannelConfig(_channelConfig);
            GitHubDrawer.Visibility = Visibility.Collapsed;
            ChatStatus.Text = "GitHub repository unlinked.";
            await RefreshMessagesAsync();
        }
        catch (Exception ex)
        {
            ChatStatus.Text = ex.Message;
        }
        finally { _busy = false; }
    }

    private void NewCustomAgentButton_Click(object sender, RoutedEventArgs e)
    {
        GitHubDrawer.Visibility = Visibility.Collapsed;
        CustomAgentDrawer.Visibility = CustomAgentDrawer.Visibility == Visibility.Visible ? Visibility.Collapsed : Visibility.Visible;
        if (CustomAgentDrawer.Visibility == Visibility.Visible) CustomAgentNameBox.Focus();
    }

    private void CancelCustomAgentButton_Click(object sender, RoutedEventArgs e) =>
        CustomAgentDrawer.Visibility = Visibility.Collapsed;

    private async void SaveCustomAgentButton_Click(object sender, RoutedEventArgs e)
    {
        if (_link is null || _channelId is null || _busy) return;
        var name = CustomAgentNameBox.Text.Trim();
        var rawHandle = string.IsNullOrWhiteSpace(CustomAgentHandleBox.Text) ? name : CustomAgentHandleBox.Text;
        var handle = Regex.Replace(rawHandle.ToLowerInvariant(), "[^a-z0-9_-]+", "-").Trim('-');
        if (string.IsNullOrWhiteSpace(name) || handle.Length < 2)
        {
            ChatStatus.Text = "Enter a name and @handle (at least 2 characters) for the custom agent.";
            return;
        }
        var provider = (CustomAgentProviderBox.SelectedItem as ComboBoxItem)?.Content?.ToString() ?? "claude";
        var agent = new EnvoyCustomAgent(
            $"ca_{handle}",
            name,
            handle,
            "🤖",
            provider,
            "subscription",
            CustomAgentJobBox.Text.Trim(),
            CustomAgentPromptBox.Text.Trim());
        _busy = true;
        try
        {
            _channelConfig = await Client(new Uri(_link.Origin)).UpsertCustomAgentAsync(_link.Token, _channelId, agent);
            ApplyChannelConfig(_channelConfig);
            CustomAgentNameBox.Clear();
            CustomAgentHandleBox.Clear();
            CustomAgentJobBox.Clear();
            CustomAgentPromptBox.Clear();
            CustomAgentDrawer.Visibility = Visibility.Collapsed;
            ChatStatus.Text = $"Created custom agent {name} (@{handle}).";
            await RefreshMessagesAsync();
        }
        catch (Exception ex)
        {
            ChatStatus.Text = ex.Message;
        }
        finally { _busy = false; }
    }

    private void MentionPill_Click(object sender, RoutedEventArgs e)
    {
        if (sender is not Button { Tag: string mention } || string.IsNullOrWhiteSpace(mention)) return;
        var prefix = MessageBox.Text.Length > 0 && !MessageBox.Text.EndsWith(' ') ? " " : string.Empty;
        MessageBox.Text += $"{prefix}{mention} ";
        MessageBox.CaretIndex = MessageBox.Text.Length;
        MessageBox.Focus();
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

    private void OpenCloneButton_Click(object sender, RoutedEventArgs e)
    {
        var origin = _link is not null && Uri.TryCreate(_link.Origin, UriKind.Absolute, out var o)
            ? o
            : EnvoyCloudChatClient.OriginFromEnvironment();
        var cloneUri = Client(origin).BuildFullCloneUri(_channelId);
        try
        {
            System.Diagnostics.Process.Start(new System.Diagnostics.ProcessStartInfo(cloneUri.AbsoluteUri) { UseShellExecute = true });
        }
        catch
        {
            Clipboard.SetText(cloneUri.AbsoluteUri);
            ChatStatus.Text = $"Copied full clone URL: {cloneUri.AbsoluteUri}";
        }
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
        _link = null; _channelId = null; _channelConfig = null;
        _lines.Clear();
        _customPills.Clear();
        ShowLinked(false);
        ShowLinkError(message);
    }
}
