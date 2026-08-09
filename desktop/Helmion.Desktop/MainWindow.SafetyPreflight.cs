using System.Windows;
using System.Windows.Media;
using Helmion.Desktop.Core;
using Microsoft.Win32;

namespace Helmion.Desktop;

public partial class MainWindow
{
    private readonly ExternalItemPreflightInspector _externalItemPreflight = new();
    private readonly WindowsSandboxReadinessScanner _windowsSandboxReadiness = new();
    private readonly WindowsSandboxLaunchCoordinator _windowsSandboxLaunch = new();
    private WindowsSandboxReadiness? _latestWindowsSandboxReadiness;

    private void RefreshSandboxSummaryCard()
    {
        try
        {
            var readiness = _windowsSandboxReadiness.Inspect();
            var identity = readiness.Facts.FirstOrDefault(fact =>
                string.Equals(fact.Category, "Windows identity", StringComparison.Ordinal));
            var osLabel = identity?.Value.Split(" · edition", StringSplitOptions.None)[0]
                          ?? "This Windows edition";

            if (readiness.UsesDisposableLocalVmFallback)
            {
                ConsoleSandboxStatusBadge.Text = "NOT READY";
                ConsoleSandboxStatusTitle.Text = "Disposable local VM setup required";
                ConsoleSandboxStatusDetail.Text = readiness.BlockingReasons.Any(reason =>
                    reason.Contains("virtualization", StringComparison.OrdinalIgnoreCase))
                    ? $"{osLabel} · built-in Windows Sandbox unsupported. Enable hardware virtualization in BIOS/UEFI before provider setup."
                    : $"{osLabel} · built-in Windows Sandbox unsupported. A separately approved provider and clean base image are still required.";
                return;
            }

            switch (readiness.Status)
            {
                case WindowsSandboxReadinessStatus.Available:
                    ConsoleSandboxStatusBadge.Text = "REVIEW FIRST";
                    ConsoleSandboxStatusTitle.Text = "Built-in Windows Sandbox available";
                    ConsoleSandboxStatusDetail.Text =
                        "Disposable launch still requires the detailed isolation review and a separate confirmation.";
                    break;

                case WindowsSandboxReadinessStatus.NeedsWindowsFeature:
                    ConsoleSandboxStatusBadge.Text = "NOT READY";
                    ConsoleSandboxStatusTitle.Text = "Windows Sandbox setup required";
                    ConsoleSandboxStatusDetail.Text =
                        "The Windows feature is unavailable. Helmian will not enable it or change Windows settings.";
                    break;

                default:
                    ConsoleSandboxStatusBadge.Text = "NOT READY";
                    ConsoleSandboxStatusTitle.Text = "Sandbox prerequisites unavailable";
                    ConsoleSandboxStatusDetail.Text =
                        "Review the detailed readiness evidence before any provider or launch decision.";
                    break;
            }
        }
        catch
        {
            ConsoleSandboxStatusBadge.Text = "UNKNOWN";
            ConsoleSandboxStatusTitle.Text = "Sandbox status could not be verified";
            ConsoleSandboxStatusDetail.Text =
                "No readiness claim is made. Open the detailed review to run an explicit check.";
        }
    }

    private void ReviewSandboxOptionsButton_Click(object sender, RoutedEventArgs e)
    {
        // Navigation only. The detailed readiness button remains the sole action
        // that refreshes launch eligibility and the launch confirmation stays gated.
        PilotPagesToggle.IsChecked = true;
        NavigateTo("Integrations");
        SandboxWorkflowCard.BringIntoView();
    }

    private void ReviewExternalItemButton_Click(object sender, RoutedEventArgs e)
    {
        var dialog = new OpenFileDialog
        {
            Title = "Choose one local item for review before install or activation",
            CheckFileExists = true,
            Multiselect = false,
            Filter = "External items and packages|*.exe;*.msi;*.msix;*.appx;*.zip;*.nupkg;*.vsix;*.crx;*.xpi;*.json;*.md;*.ps1;*.js;*.mjs|All files|*.*"
        };

        if (dialog.ShowDialog(this) != true) return;

        var source = ExternalReviewSourceBox.Text?.Trim();
        var kind = source is { Length: > 0 }
                   && Uri.TryCreate(source, UriKind.Absolute, out var uri)
                   && uri.Host.Contains("github.com", StringComparison.OrdinalIgnoreCase)
            ? ExternalItemKind.GitHubContent
            : ExternalItemPreflightInspector.InferKind(dialog.FileName);
        RenderExternalItemReview(
            _externalItemPreflight.ReviewLocalFile(dialog.FileName, kind, source));
    }

    private void RenderExternalItemReview(ExternalItemReview review)
    {
        ExternalReviewResultPanel.Visibility = Visibility.Visible;
        ExternalReviewDecisionText.Text = $"{review.DecisionLabel} · {review.Evidence.Name}";
        ExternalReviewDecisionText.Foreground = review.Decision switch
        {
            ExternalItemReviewDecision.Block => (Brush)FindResource("GuardCriticalBrush"),
            ExternalItemReviewDecision.ReadyToApprove => (Brush)FindResource("AccentBrush"),
            _ => (Brush)FindResource("AmberBrush")
        };
        ExternalReviewExplanationText.Text = review.Explanation;
        ExternalReviewScopeText.Text = $"Scope · {review.Evidence.Scope}\nSource · {review.Evidence.Source}";
        ExternalReviewProvenanceText.Text =
            $"Provenance [{review.Evidence.ProvenanceState}] · {review.Evidence.Provenance}";
        ExternalReviewIntegrityText.Text =
            $"Identity · SHA-256 {review.Evidence.Sha256 ?? "UNKNOWN"}\n"
            + $"Type · {review.Evidence.FileType}\n"
            + $"Signature [{review.Evidence.SignatureState}] · {review.Evidence.Signature}";
        ExternalReviewManifestText.Text =
            $"Manifest [{review.Evidence.ManifestState}] · {review.Evidence.Manifest}";
        ExternalReviewCapabilitiesText.Text = review.Evidence.RequestedCapabilities.Count == 0
            ? $"Permissions/capabilities [{review.Evidence.CapabilityState}] · none declared"
            : $"Permissions/capabilities [{review.Evidence.CapabilityState}] · "
              + string.Join("; ", review.Evidence.RequestedCapabilities);

        var findings = review.Evidence.Findings.Count == 0
            ? "no configured rule findings"
            : string.Join("; ", review.Evidence.Findings.Select(finding =>
                $"{finding.Level}: {finding.Category} — {finding.Message}"));
        var unknowns = review.Unknowns.Count == 0
            ? "none"
            : string.Join("; ", review.Unknowns);
        ExternalReviewFindingsText.Text = $"Findings · {findings}\nUnknowns · {unknowns}";
    }

    private void BuildSandboxButton_Click(object sender, RoutedEventArgs e)
    {
        BuildSandboxButton.IsEnabled = false;
        BuildSandboxButton.Content = "Checking readiness…";
        SandboxLaunchConfirmationPanel.Visibility = Visibility.Collapsed;
        SandboxLaunchStatusText.Visibility = Visibility.Collapsed;

        try
        {
            _latestWindowsSandboxReadiness = _windowsSandboxReadiness.Inspect();
            RenderWindowsSandboxReadiness(_latestWindowsSandboxReadiness);
        }
        catch (Exception exception)
        {
            _latestWindowsSandboxReadiness = null;
            SandboxReadinessPanel.Visibility = Visibility.Visible;
            SandboxReadinessTitleText.Text = "Sandbox readiness could not be verified";
            SandboxReadinessTitleText.Foreground = (Brush)FindResource("AmberBrush");
            SandboxReadinessExplanationText.Text =
                "The read-only machine-fact inspection did not complete. Helmian will not guess or offer launch.";
            SandboxReadinessFactsText.Text = string.Empty;
            SandboxReadinessBlockersText.Text = exception.Message;
            SandboxReviewLaunchButton.Visibility = Visibility.Collapsed;
        }
        finally
        {
            BuildSandboxButton.Content = "Run readiness check again";
            BuildSandboxButton.IsEnabled = true;
        }
    }

    private void RenderWindowsSandboxReadiness(WindowsSandboxReadiness readiness)
    {
        SandboxReadinessPanel.Visibility = Visibility.Visible;
        SandboxReadinessTitleText.Text = readiness.Title;
        SandboxReadinessTitleText.Foreground = readiness.Status switch
        {
            WindowsSandboxReadinessStatus.Available => (Brush)FindResource("AccentBrush"),
            _ => (Brush)FindResource("AmberBrush")
        };
        SandboxReadinessExplanationText.Text = readiness.Explanation;
        SandboxReadinessFactsText.Text = string.Join(
            Environment.NewLine,
            readiness.Facts.Select(fact => $"{fact.Category} · {fact.Value}"));
        var recommendation = readiness.RecommendedProvider switch
        {
            SandboxProviderRecommendation.WindowsSandbox => "Preferred boundary · built-in Windows Sandbox",
            SandboxProviderRecommendation.DisposableLocalVm => "Fallback boundary · Disposable local VM",
            _ => "Boundary recommendation · unavailable"
        };
        SandboxReadinessBlockersText.Text = readiness.BlockingReasons.Count == 0
            ? $"{recommendation}\nChecked {readiness.CheckedAtUtc.ToLocalTime():g} · no prerequisite blocker reported"
            : $"{recommendation}\nWhy launch is unavailable · "
              + string.Join(" ", readiness.BlockingReasons);
        SandboxReviewLaunchButton.Visibility = readiness.CanLaunch
            ? Visibility.Visible
            : Visibility.Collapsed;
    }

    private void SandboxReviewLaunchButton_Click(object sender, RoutedEventArgs e)
    {
        if (!HasFreshLaunchableSandboxReadiness()) return;

        var configurationReview = WindowsSandboxConfiguration.ReviewDefaultIsolated();
        if (!configurationReview.CanRequestApproval)
        {
            SandboxLaunchStatusText.Text =
                $"Launch confirmation unavailable: configuration preflight returned {configurationReview.DecisionLabel}.";
            SandboxLaunchStatusText.Visibility = Visibility.Visible;
            return;
        }

        SandboxLaunchConfirmationPanel.Visibility = Visibility.Visible;
        SandboxLaunchStatusText.Text =
            $"Configuration preflight · {configurationReview.DecisionLabel} · SHA-256 {configurationReview.Evidence.Sha256}";
        SandboxLaunchStatusText.Visibility = Visibility.Visible;
    }

    private void ConfirmSandboxLaunchButton_Click(object sender, RoutedEventArgs e)
    {
        if (!HasFreshLaunchableSandboxReadiness()) return;

        var configurationReview = WindowsSandboxConfiguration.ReviewDefaultIsolated();
        if (!configurationReview.CanRequestApproval)
        {
            SandboxLaunchStatusText.Text =
                "Launch refused because the generated configuration did not pass Review before install.";
            SandboxLaunchStatusText.Visibility = Visibility.Visible;
            return;
        }

        ConfirmSandboxLaunchButton.IsEnabled = false;
        try
        {
            var result = _windowsSandboxLaunch.Launch(
                _latestWindowsSandboxReadiness!,
                WindowsSandboxLaunchConfirmation.Confirmed);
            SandboxLaunchStatusText.Text = result.Message;
            SandboxLaunchStatusText.Visibility = Visibility.Visible;
            if (result.LaunchRequested)
            {
                SandboxLaunchConfirmationPanel.Visibility = Visibility.Collapsed;
            }
        }
        finally
        {
            ConfirmSandboxLaunchButton.IsEnabled = true;
        }
    }

    private void CancelSandboxLaunchButton_Click(object sender, RoutedEventArgs e)
    {
        SandboxLaunchConfirmationPanel.Visibility = Visibility.Collapsed;
        SandboxLaunchStatusText.Text = "Launch cancelled · no configuration was created and no process was started.";
        SandboxLaunchStatusText.Visibility = Visibility.Visible;
    }

    private bool HasFreshLaunchableSandboxReadiness()
    {
        if (_latestWindowsSandboxReadiness is not { CanLaunch: true } readiness)
        {
            SandboxLaunchStatusText.Text = "Run the readiness check before reviewing or confirming launch.";
            SandboxLaunchStatusText.Visibility = Visibility.Visible;
            return false;
        }

        if (DateTimeOffset.UtcNow - readiness.CheckedAtUtc <= TimeSpan.FromMinutes(5))
        {
            return true;
        }

        SandboxLaunchConfirmationPanel.Visibility = Visibility.Collapsed;
        SandboxLaunchStatusText.Text = "Readiness is older than five minutes. Run the check again before launch.";
        SandboxLaunchStatusText.Visibility = Visibility.Visible;
        return false;
    }
}
