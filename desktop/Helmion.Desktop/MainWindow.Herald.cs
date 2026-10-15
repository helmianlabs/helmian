using System.IO;
using System.Diagnostics;
using System.Text;
using System.Windows;
using System.Windows.Media.Imaging;
using System.Windows.Threading;
using Helmion.Desktop.Core;
using QRCoder;

namespace Helmion.Desktop;

/// <summary>
/// Desktop-owned Herald seam. Sharing starts an outbound-only first-party relay
/// session; no public listener is opened on this computer. Every remote request
/// still crosses this selected-session gateway before reaching Maestro.
/// </summary>
public partial class MainWindow
{
    private HeraldDesktopGateway? _heraldGateway;
    private CancellationTokenSource? _heraldSharingCancellation;
    private Task? _heraldPipeTask;
    private Process? _heraldProcess;
    private bool _heraldClosedWired;
    private DispatcherTimer? _heraldPairingExpiryTimer;
    private string? _heraldPhoneUrl;
    private readonly Queue<string> _heraldErrorTail = new();

    /// <summary>%LOCALAPPDATA%\Helmion\logs\herald-companion.log (companion output, no secrets).</summary>
    internal static string HeraldCompanionLogPath => Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Helmion", "logs", "herald-companion.log");

    private static void AppendHeraldLog(string line)
    {
        try
        {
            Directory.CreateDirectory(Path.GetDirectoryName(HeraldCompanionLogPath)!);
            File.AppendAllText(HeraldCompanionLogPath, $"{DateTimeOffset.Now:yyyy-MM-dd HH:mm:ss zzz} {line}{Environment.NewLine}");
        }
        catch { /* logging must never break sharing */ }
    }

    /// <summary>Plain status text when the companion exits; keeps the real error visible.</summary>
    internal static string HeraldExitMessage(int? exitCode, IReadOnlyCollection<string> errorTail)
    {
        var why = errorTail.Count > 0 ? string.Join("\n", errorTail) : "It printed no error.";
        var code = exitCode is int c ? $" (exit code {c})" : string.Empty;
        return $"Phone sharing stopped: the companion ended{code}.\n{why}\nDetails: {HeraldCompanionLogPath}";
    }

    /// <summary>Cloud relay origin: HELMION_REMOTE_CONTROL_ORIGIN, else https://helmian.cloud.</summary>
    private static Uri HeraldRemoteOrigin =>
        Uri.TryCreate(Environment.GetEnvironmentVariable("HELMION_REMOTE_CONTROL_ORIGIN"), UriKind.Absolute, out var o)
            && o.Scheme == Uri.UriSchemeHttps
            ? o : new Uri("https://helmian.cloud");

    internal HeraldDesktopGateway HeraldGateway =>
        _heraldGateway ??= new HeraldDesktopGateway(
            CurrentHeraldSnapshot,
            QueueHeraldInstructionAsync,
            ApplyHeraldApprovalAsync,
            AppendHeraldAuditAsync);

    private async void ToggleHeraldSharingButton_Click(object sender, System.Windows.RoutedEventArgs e)
    {
        if (_heraldProcess is { HasExited: false })
        {
            await StopHeraldSharingAsync("Phone sharing stopped locally.");
            return;
        }
        await StartHeraldSharingAsync();
    }

    private async Task StartHeraldSharingAsync(bool localNetwork = false)
    {
        // Pairing no longer needs an active agent session. The phone pairs first,
        // and instructions/approvals are refused politely by the gateway until a
        // project + session is selected (on the desktop or later from the phone).
        var root = AgentBridge.FindHelmionRoot();
        var node = AgentBridge.FindNodeExecutable();
        var workspace = string.IsNullOrWhiteSpace(_registeredWorkspacePath) ? root : _registeredWorkspacePath;
        if (string.IsNullOrWhiteSpace(root) || string.IsNullOrWhiteSpace(node)
            || string.IsNullOrWhiteSpace(workspace))
        {
            SetHeraldSharingUi(
                "COULD NOT START",
                string.IsNullOrWhiteSpace(node)
                    ? "Phone pairing needs Node.js 20+ on this PC (nodejs.org). Install it, then try again. Nothing was opened."
                    : "Helmian could not find its Herald files (bin\\helmion.mjs) next to the app. Nothing was opened.",
                running: false);
            return;
        }

        await StopHeraldSharingAsync(null);
        EnsureRemoteControlDesktopGatewayStarted();
        var pipeName = HeraldDesktopPipeServer.PipeNameForCurrentUser();

        try
        {
            var start = new ProcessStartInfo
            {
                FileName = node,
                WorkingDirectory = workspace,
                UseShellExecute = false,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                CreateNoWindow = true,
                StandardOutputEncoding = Encoding.UTF8,
                StandardErrorEncoding = Encoding.UTF8,
            };
            start.ArgumentList.Add(Path.Combine(root, "bin", "helmion.mjs"));
            start.ArgumentList.Add("herald");
            if (localNetwork)
            {
                // Same-Wi-Fi fallback: no cloud account or relay. Serves the phone
                // page on this PC's LAN address; the one-time code is still
                // single-use, 5-minute and per-device.
                start.ArgumentList.Add("--lan");
            }
            else
            {
                start.ArgumentList.Add("--remote");
                start.ArgumentList.Add("--origin");
                start.ArgumentList.Add(HeraldRemoteOrigin.ToString().TrimEnd('/'));
            }
            start.ArgumentList.Add("--desktop-pipe");
            start.ArgumentList.Add("--desktop-pipe-name");
            start.ArgumentList.Add(pipeName);

            // The Herald shell never calls a provider or database. Do not hand
            // credentials to a process that has no reason to possess them.
            foreach (var name in new[]
            {
                "OPENAI_API_KEY", "ANTHROPIC_API_KEY", "GEMINI_API_KEY", "XAI_API_KEY",
                "GROK_API_KEY", "GITHUB_TOKEN", "HELMION_DATABASE_URL", "DATABASE_URL",
                "HELMION_RELAY_KEY", "MCP_SECRET",
            })
            {
                start.Environment.Remove(name);
            }

            var process = new Process { StartInfo = start, EnableRaisingEvents = true };
            _heraldErrorTail.Clear();
            AppendHeraldLog($"start: \"{node}\" {string.Join(' ', start.ArgumentList)} (cwd {workspace})");
            process.OutputDataReceived += (_, args) =>
            {
                if (!string.IsNullOrWhiteSpace(args.Data))
                {
                    AppendHeraldLog($"out: {(args.Data.Contains("Pairing code:", StringComparison.Ordinal) ? "Pairing code: [hidden]" : args.Data)}");
                    Dispatcher.BeginInvoke(() => AppendHeraldStatusLine(args.Data));
                }
            };
            process.ErrorDataReceived += (_, args) =>
            {
                if (!string.IsNullOrWhiteSpace(args.Data))
                {
                    AppendHeraldLog($"err: {args.Data}");
                    lock (_heraldErrorTail)
                    {
                        _heraldErrorTail.Enqueue(args.Data.Length > 400 ? args.Data[..400] : args.Data);
                        while (_heraldErrorTail.Count > 4) _heraldErrorTail.Dequeue();
                    }
                    Dispatcher.BeginInvoke(() => AppendHeraldStatusLine($"Could not continue: {args.Data}"));
                }
            };
            process.Exited += (_, _) => Dispatcher.BeginInvoke(async () =>
            {
                if (ReferenceEquals(_heraldProcess, process))
                {
                    int? exitCode = null;
                    try { process.WaitForExit(); exitCode = process.ExitCode; } catch { }
                    await Task.Delay(150); // let the last stderr lines arrive
                    string[] tail;
                    lock (_heraldErrorTail) tail = _heraldErrorTail.ToArray();
                    AppendHeraldLog($"exit: {exitCode?.ToString() ?? "unknown"}");
                    await StopHeraldSharingAsync(HeraldExitMessage(exitCode, tail));
                }
            });
            if (!process.Start()) throw new InvalidOperationException("The Herald companion process did not start.");
            _heraldProcess = process;
            process.BeginOutputReadLine();
            process.BeginErrorReadLine();

            if (!_heraldClosedWired)
            {
                _heraldClosedWired = true;
                Closed += async (_, _) => await StopHeraldSharingAsync(null);
            }
            SetHeraldSharingUi(
                "STARTING",
                "Opening the outbound Helmian relay. Waiting for the cellular phone link and short-lived pairing code…",
                running: true);
        }
        catch (Exception error)
        {
            AppendHeraldLog($"start failed: {error.Message}");
            await StopHeraldSharingAsync($"Phone sharing did not start: {error.Message}\nDetails: {HeraldCompanionLogPath}");
        }
    }

    private async Task StopHeraldSharingAsync(string? message)
    {
        var process = _heraldProcess;
        _heraldProcess = null;
        if (process is not null)
        {
            try
            {
                if (!process.HasExited) process.Kill(entireProcessTree: true);
                await process.WaitForExitAsync();
            }
            catch { /* only the process this window owns is being stopped */ }
            process.Dispose();
        }

        var cancellation = _heraldSharingCancellation;
        _heraldSharingCancellation = null;
        cancellation?.Cancel();
        if (_heraldPipeTask is { } pipeTask)
        {
            try { await pipeTask; } catch (OperationCanceledException) { }
        }
        _heraldPipeTask = null;
        cancellation?.Dispose();

        if (message is not null)
        {
            SetHeraldSharingUi("NOT SHARING", message, running: false);
        }
    }

    private void SetHeraldSharingUi(string state, string detail, bool running)
    {
        SetHeraldFriendlyStatus(state);
        if (HeraldSharingDetailText is not null) HeraldSharingDetailText.Text = detail;
        if (ToggleHeraldSharingButton is not null)
        {
            ToggleHeraldSharingButton.Content = running ? "Stop phone sharing" : "Start phone sharing";
            ToggleHeraldSharingButton.ToolTip = running
                ? "Stop the owned Herald relay session and current-user desktop pipe."
                : "Explicitly start cellular phone sharing and display a short-lived pairing code.";
        }
        if (!running) ClearHeraldPairingQr();
    }

    /// <summary>
    /// One plain-language status line for the simple panel. Internal state codes
    /// stay in the activity log under Show details.
    /// </summary>
    private void SetHeraldFriendlyStatus(string state)
    {
        if (HeraldSharingStateText is null) return;
        HeraldSharingStateText.Text = state switch
        {
            "READY TO PAIR" or "READY TO SHARE" or "NOT SHARING" => "Ready to start",
            "STARTING" => "Connecting...",
            "PAIRING AVAILABLE" => "Ready to scan",
            "PAIRING EXPIRED" => "Code expired. Stop and start phone sharing for a new one.",
            "COULD NOT START" => "Couldn't connect. Open Show details for the reason.",
            _ => state.Length > 0 ? char.ToUpperInvariant(state[0]) + state[1..].ToLowerInvariant() : state
        };
    }

    internal void RefreshHeraldPrerequisiteUi()
    {
        if (_heraldProcess is { HasExited: false }) return;
        var current = CurrentHeraldSnapshot();
        if (current is null)
        {
            SetHeraldSharingUi(
                "READY TO PAIR",
                "Press Start phone sharing (cloud) or Pair on same Wi\u2011Fi to show a QR. No agent session is needed to pair; open a project and session whenever you want the phone to send instructions.",
                running: false);
            if (OpenHeraldConsoleButton is not null)
            {
                OpenHeraldConsoleButton.Visibility = Visibility.Visible;
            }
            return;
        }

        SetHeraldSharingUi(
            "READY TO SHARE",
            $"Ready to pair a phone to {current.Project.Name} · {current.Session.Name}. Press Start phone sharing to create the short-lived QR code.",
            running: false);
        if (OpenHeraldConsoleButton is not null)
        {
            OpenHeraldConsoleButton.Visibility = Visibility.Collapsed;
        }
    }

    private void OpenHeraldConsoleButton_Click(object sender, RoutedEventArgs e)
    {
        NavigateTo("Console");
    }

    private void AppendHeraldStatusLine(string line)
    {
        if (HeraldSharingDetailText is null) return;
        var existing = HeraldSharingDetailText.Text ?? string.Empty;
        var combined = string.IsNullOrWhiteSpace(existing) ? line : $"{existing}\n{line}";
        HeraldSharingDetailText.Text = combined.Length <= 2_400 ? combined : combined[^2_400..];
        if (line.StartsWith("Phone: ", StringComparison.Ordinal))
        {
            _heraldPhoneUrl = line["Phone: ".Length..].Trim();
            TryShowHeraldPairingQr(_heraldPhoneUrl);
        }
        if (line.Contains("Pairing link", StringComparison.Ordinal))
        {
            var at = line.IndexOf("http", StringComparison.Ordinal);
            if (at >= 0) TryShowHeraldPairingQr(line[at..].Trim());
        }
        else if (line.Contains("Pairing code:", StringComparison.Ordinal))
        {
            SetHeraldFriendlyStatus("PAIRING AVAILABLE");
            ScheduleHeraldPairingExpiry(line);
            // Upgrade the QR so scanning also carries the one-time code (in the
            // URL fragment) and the phone does not have to type it.
            var link = HeraldPairingLink.TryBuild(
                _heraldPhoneUrl, HeraldPairingLink.ParseCliPairingCode(line), HeraldPairingLink.PairKey);
            if (link is not null) TryShowHeraldPairingQr(link);
        }
    }

    private void TryShowHeraldPairingQr(string candidate)
    {
        if (!Uri.TryCreate(candidate, UriKind.Absolute, out var uri)) return;
        var cloud = uri.Scheme == Uri.UriSchemeHttps
            && string.Equals(uri.Host, HeraldRemoteOrigin.Host, StringComparison.OrdinalIgnoreCase)
            && uri.AbsolutePath.StartsWith("/herald", StringComparison.Ordinal);
        if (!cloud && !HeraldPairingLink.IsPrivateLanHttp(uri)) return;

        var png = PngByteQRCodeHelper.GetQRCode(candidate, QRCodeGenerator.ECCLevel.Q, 8);
        using var stream = new MemoryStream(png, writable: false);
        var image = new BitmapImage();
        image.BeginInit();
        image.CacheOption = BitmapCacheOption.OnLoad;
        image.StreamSource = stream;
        image.EndInit();
        image.Freeze();
        HeraldPairingQrImage.Source = image;
        // Never surface the one-time code in a tooltip; show the base link only.
        HeraldPairingQrPanel.ToolTip = uri.GetLeftPart(UriPartial.Query);
        HeraldPairingQrPanel.Visibility = Visibility.Visible;
        if (HeraldQrPlaceholderText is not null)
            HeraldQrPlaceholderText.Visibility = Visibility.Collapsed;
        // Keep QR at the user-chosen slider size.
        ApplyHeraldQrImageSize(_desktopSettings.ResolvedHeraldQrSize);
    }

    private void ScheduleHeraldPairingExpiry(string line)
    {
        const string marker = "(expires ";
        var start = line.IndexOf(marker, StringComparison.Ordinal);
        var end = line.LastIndexOf(')');
        if (start < 0 || end <= start
            || !DateTimeOffset.TryParse(line[(start + marker.Length)..end], out var expiry))
        {
            return;
        }

        _heraldPairingExpiryTimer?.Stop();
        var remaining = expiry - DateTimeOffset.UtcNow;
        if (remaining <= TimeSpan.Zero)
        {
            ExpireHeraldPairing();
            return;
        }
        _heraldPairingExpiryTimer = new DispatcherTimer { Interval = remaining };
        _heraldPairingExpiryTimer.Tick += (_, _) => ExpireHeraldPairing();
        _heraldPairingExpiryTimer.Start();
    }

    private void ExpireHeraldPairing()
    {
        ClearHeraldPairingQr();
        if (_heraldProcess is { HasExited: false })
        {
            SetHeraldFriendlyStatus("PAIRING EXPIRED");
            HeraldSharingDetailText.Text += "\nThe pairing code expired. Stop and restart phone sharing for a new code.";
        }
    }

    private void ClearHeraldPairingQr()
    {
        _heraldPairingExpiryTimer?.Stop();
        _heraldPairingExpiryTimer = null;
        if (HeraldPairingQrImage is not null) HeraldPairingQrImage.Source = null;
        if (HeraldPairingQrPanel is not null)
        {
            HeraldPairingQrPanel.ToolTip = null;
            HeraldPairingQrPanel.Visibility = Visibility.Collapsed;
        }
        if (HeraldQrPlaceholderText is not null)
            HeraldQrPlaceholderText.Visibility = Visibility.Visible;
    }

    private bool _heraldLayoutApplying;

    /// <summary>
    /// Apply saved Herald pane sizes / QR / font from desktop settings.
    /// Call after InitializeComponent and when settings load.
    /// </summary>
    internal void ApplyHeraldLayoutFromSettings(bool saveLabel = false)
    {
        if (HeraldLayoutRoot is null) return;
        _heraldLayoutApplying = true;
        try
        {
            var qr = _desktopSettings.ResolvedHeraldQrSize;
            var logH = _desktopSettings.ResolvedHeraldLogHeight;
            var font = _desktopSettings.ResolvedHeraldDetailFontSize;

            if (HeraldQrSizeSlider is not null) HeraldQrSizeSlider.Value = qr;
            if (HeraldDetailFontSlider is not null) HeraldDetailFontSlider.Value = font;
            if (HeraldQrSizeValueLabel is not null) HeraldQrSizeValueLabel.Text = $"{qr:0}";
            if (HeraldDetailFontValueLabel is not null) HeraldDetailFontValueLabel.Text = $"{font:0}";

            ApplyHeraldQrImageSize(qr);
            ApplyHeraldDetailFont(font);

            if (HeraldLogRowDef is not null)
                HeraldLogRowDef.Height = new GridLength(logH);

            if (saveLabel && HeraldLayoutSavedLabel is not null)
                HeraldLayoutSavedLabel.Text = "Herald layout restored from saved preferences.";
        }
        finally
        {
            _heraldLayoutApplying = false;
        }
    }

    private void ApplyHeraldQrImageSize(double size)
    {
        size = HeraldLayoutRange.ClampQrSize(size);
        if (HeraldPairingQrImage is not null)
        {
            HeraldPairingQrImage.Width = size;
            HeraldPairingQrImage.Height = size;
        }
    }

    private void ApplyHeraldDetailFont(double size)
    {
        size = HeraldLayoutRange.ClampDetailFontSize(size);
        if (HeraldSharingDetailText is not null)
            HeraldSharingDetailText.FontSize = size;
    }

    private void PersistHeraldLayoutSettings()
    {
        if (_heraldLayoutApplying || !_persistTheme) return;

        var qr = HeraldQrSizeSlider is not null
            ? HeraldLayoutRange.ClampQrSize(HeraldQrSizeSlider.Value)
            : _desktopSettings.ResolvedHeraldQrSize;
        var font = HeraldDetailFontSlider is not null
            ? HeraldLayoutRange.ClampDetailFontSize(HeraldDetailFontSlider.Value)
            : _desktopSettings.ResolvedHeraldDetailFontSize;
        var logH = HeraldLogRowDef is not null && HeraldLogRowDef.Height.IsAbsolute
            ? HeraldLayoutRange.ClampLogHeight(HeraldLogRowDef.Height.Value)
            : _desktopSettings.ResolvedHeraldLogHeight;

        // The simplified panel has no controls/QR column split; keep the stored share unchanged.
        var share = _desktopSettings.ResolvedHeraldControlsShare;

        _desktopSettings = _desktopSettings with
        {
            HeraldQrSize = qr,
            HeraldDetailFontSize = font,
            HeraldLogHeight = logH,
            HeraldControlsShare = share
        };
        try
        {
            DesktopSettingsStore.Save(_desktopSettings);
            if (HeraldLayoutSavedLabel is not null)
                HeraldLayoutSavedLabel.Text = "Layout saved for this Windows user.";
        }
        catch
        {
            if (HeraldLayoutSavedLabel is not null)
                HeraldLayoutSavedLabel.Text = "Could not save Herald layout (settings write failed).";
        }
    }

    private void HeraldQrSizeSlider_ValueChanged(object sender, RoutedPropertyChangedEventArgs<double> e)
    {
        if (_heraldLayoutApplying) return;
        var size = HeraldLayoutRange.ClampQrSize(e.NewValue);
        if (HeraldQrSizeValueLabel is not null) HeraldQrSizeValueLabel.Text = $"{size:0}";
        ApplyHeraldQrImageSize(size);
        PersistHeraldLayoutSettings();
    }

    private void HeraldDetailFontSlider_ValueChanged(object sender, RoutedPropertyChangedEventArgs<double> e)
    {
        if (_heraldLayoutApplying) return;
        var size = HeraldLayoutRange.ClampDetailFontSize(e.NewValue);
        if (HeraldDetailFontValueLabel is not null) HeraldDetailFontValueLabel.Text = $"{size:0}";
        ApplyHeraldDetailFont(size);
        PersistHeraldLayoutSettings();
    }

    private void HeraldLayoutSplitter_DragCompleted(object sender, System.Windows.Controls.Primitives.DragCompletedEventArgs e)
    {
        // After drag, absolute pixel heights may be set on star rows — capture log height.
        if (HeraldLogRowDef is not null && HeraldLayoutRoot is not null)
        {
            var h = HeraldLogRowDef.ActualHeight;
            if (h >= HeraldLayoutRange.MinLogHeight)
            {
                var clamped = HeraldLayoutRange.ClampLogHeight(h);
                HeraldLogRowDef.Height = new GridLength(clamped);
            }
        }
        PersistHeraldLayoutSettings();
    }

    private void HeraldResetLayoutButton_Click(object sender, RoutedEventArgs e)
    {
        _desktopSettings = _desktopSettings with
        {
            HeraldQrSize = HeraldLayoutRange.DefaultQrSize,
            HeraldLogHeight = HeraldLayoutRange.DefaultLogHeight,
            HeraldControlsShare = HeraldLayoutRange.DefaultControlsShare,
            HeraldDetailFontSize = HeraldLayoutRange.DefaultDetailFontSize
        };
        if (_persistTheme)
        {
            try { DesktopSettingsStore.Save(_desktopSettings); } catch { /* ignore */ }
        }
        ApplyHeraldLayoutFromSettings(saveLabel: true);
        if (HeraldLayoutSavedLabel is not null)
            HeraldLayoutSavedLabel.Text = "Herald layout reset to defaults and saved.";
    }

    private HeraldSessionSnapshot? CurrentHeraldSnapshot()
    {
        if (!Dispatcher.CheckAccess())
        {
            return Dispatcher.Invoke(CurrentHeraldSnapshot, DispatcherPriority.Send);
        }

        var session = _sessions.Selected;
        // Same workspace rule as CurrentRemoteControlSessionMetadata — if no
        // registered project folder, fall back to the app base directory so a
        // live Console session still has a stable opaque project id.
        var workspace = !string.IsNullOrWhiteSpace(_registeredWorkspacePath)
            && Directory.Exists(_registeredWorkspacePath)
            ? _registeredWorkspacePath
            : AppContext.BaseDirectory;
        if (session is null || string.IsNullOrWhiteSpace(workspace) || !Directory.Exists(workspace))
        {
            return null;
        }

        var project = ProjectShelf.Describe(workspace);
        var projectName = project?.Name ?? "Helmion Desktop";
        // CRITICAL: phone/Herald control plane uses RemoteControlProjectIdentity
        // (project-{hmac}). Using project.Slug here ("test2") caused every
        // instruction to be refused while Ably transport looked healthy.
        // Measured 2026-08-02 in remote-control-realtime.log:
        //   Phone project=project-e0b839…  Desktop project=test2  session=same
        var projectId = !string.IsNullOrWhiteSpace(_remoteControlInstallationId)
            ? RemoteControlProjectIdentity.FromProjectRoot(workspace, _remoteControlInstallationId)
            : (project?.Slug ?? "helmion-desktop");

        var lines = session.Transcript.ToString()
            .Split(['\r', '\n'], StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
            .TakeLast(8)
            .Select((line, index) => new HeraldOutput(
                $"line-{index + 1}", line.Length <= 280 ? line : line[..280] + "…"))
            .ToList();
        var approvals = string.IsNullOrWhiteSpace(_pendingApprovalId)
            ? Array.Empty<HeraldApproval>()
            : [new HeraldApproval(
                _pendingApprovalId,
                string.IsNullOrWhiteSpace(ConsoleApprovalSummaryText?.Text)
                    ? "A desktop tool request is waiting for review."
                    : ConsoleApprovalSummaryText.Text,
                "waiting")];

        return new HeraldSessionSnapshot(
            new HeraldNamedState(projectId, projectName, "selected"),
            new HeraldNamedState(session.Id, session.Name, session.IsBusy ? "working" : "ready"),
            new HeraldNamedState(
                (session.ProviderKey ?? session.PillLabel).ToLowerInvariant(),
                session.ProviderKey ?? session.PillLabel,
                session.IsBusy ? "working" : "idle"),
            new HeraldGuardState(session.Level.ToString().ToLowerInvariant(), session.Reason),
            lines,
            approvals,
            // The persistent voice host is intentionally not touched. This stays
            // unavailable until a separately tested phone-audio seam exists.
            new HeraldVoiceState(false, "Phone Voice is not connected in this build."),
            DateTimeOffset.UtcNow);
    }

    private Task<HeraldGatewayResult> QueueHeraldInstructionAsync(
        HeraldInstructionRequest request,
        CancellationToken cancellationToken)
    {
        if (!Dispatcher.CheckAccess())
        {
            return Dispatcher.InvokeAsync(
                () => QueueHeraldInstructionOnUi(request, cancellationToken),
                DispatcherPriority.Send,
                cancellationToken).Task;
        }

        return Task.FromResult(QueueHeraldInstructionOnUi(request, cancellationToken));
    }

    private HeraldGatewayResult QueueHeraldInstructionOnUi(
        HeraldInstructionRequest request,
        CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        // Account Remote Control is bound by the server to this Desktop and its
        // selected session.  Do not reuse the older Herald snapshot here: that
        // snapshot additionally requires a registered project folder and was
        // refusing valid mobile instructions in an otherwise live Console.
        // Phone text is ordinary session text only. Local shell escapes and slash
        // controls are deliberately unavailable on the Herald path.
        if (request.Text.StartsWith('!') || request.Text.StartsWith('/'))
        {
            return HeraldGatewayResult.Refused(
                "Herald accepts session instructions, not shell escapes or slash controls.");
        }

        _ = SendConsoleInputAsync(
            request.Text,
            includeStagedAttachments: false,
            allowConsoleControls: false);
        return new HeraldGatewayResult(true, "queued", "Visible in Helmian Desktop.");
    }

    private Task<HeraldGatewayResult> ApplyHeraldApprovalAsync(
        HeraldApprovalDecision decision,
        CancellationToken cancellationToken)
    {
        if (!Dispatcher.CheckAccess())
        {
            return Dispatcher.InvokeAsync(
                () => ApplyHeraldApprovalOnUi(decision, cancellationToken),
                DispatcherPriority.Send,
                cancellationToken).Task;
        }
        return Task.FromResult(ApplyHeraldApprovalOnUi(decision, cancellationToken));
    }

    private HeraldGatewayResult ApplyHeraldApprovalOnUi(
        HeraldApprovalDecision decision,
        CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        var current = CurrentHeraldSnapshot();
        if (current is null
            || !string.Equals(current.Project.Id, decision.ProjectId, StringComparison.Ordinal)
            || !string.Equals(current.Session.Id, decision.SessionId, StringComparison.Ordinal)
            || !string.Equals(_pendingApprovalId, decision.ApprovalId, StringComparison.Ordinal))
        {
            return HeraldGatewayResult.Refused("The pending approval or selected context changed. Review again.");
        }

        CompleteApproval(decision.Decision == "allow-once"
            ? AgentApprovalDecision.AllowOnce
            : AgentApprovalDecision.Deny);
        return new HeraldGatewayResult(true, "recorded", "Decision recorded by Helmian Desktop.");
    }

    private async Task AppendHeraldAuditAsync(
        HeraldAuditRecord record,
        CancellationToken cancellationToken)
    {
        var workspace = Dispatcher.CheckAccess()
            ? _registeredWorkspacePath
            : await Dispatcher.InvokeAsync(() => _registeredWorkspacePath,
                DispatcherPriority.Send, cancellationToken);
        if (string.IsNullOrWhiteSpace(workspace))
        {
            throw new InvalidOperationException("No active project is available for Herald audit.");
        }
        await HeraldAuditStore.AppendAsync(workspace, record, cancellationToken).ConfigureAwait(false);
    }
}
