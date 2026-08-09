using System.Runtime.InteropServices;
using Helmion.Desktop.Core;

internal static class WindowsSandboxOrchestrationChecks
{
    private static readonly DateTimeOffset CheckedAt =
        new(2026, 7, 31, 18, 0, 0, TimeSpan.Zero);

    public static void Run()
    {
        var availableFacts = Facts();
        var available = WindowsSandboxReadinessScanner.Decide(availableFacts, CheckedAt);
        Check(available.Status == WindowsSandboxReadinessStatus.Available && available.CanLaunch,
            "eligible enabled Windows Sandbox is reported available");
        Check(available.Facts.Select(fact => fact.Category).SequenceEqual(
                ["Windows identity", "Windows Sandbox feature", "Virtualization", "Hardware", "Resources", "Local VM providers"]),
            "readiness reports the exact six machine-fact categories it inspected");

        var needsFeature = WindowsSandboxReadinessScanner.Decide(
            Facts(featurePresent: false),
            CheckedAt);
        Check(needsFeature.Status == WindowsSandboxReadinessStatus.NeedsWindowsFeature
              && !needsFeature.CanLaunch,
            "eligible machine without the component needs the Windows feature and cannot launch");

        var homeFallback = WindowsSandboxReadinessScanner.Decide(
            Facts(
                productName: "Windows 10 Home",
                edition: "Core",
                displayVersion: "22H2",
                buildNumber: 19045,
                featurePresent: false,
                providerAvailability: LocalVmProviderAvailability.NotInstalled),
            CheckedAt);
        Check(homeFallback.Status == WindowsSandboxReadinessStatus.DisposableLocalVmSetupRequired
              && homeFallback.RecommendedProvider == SandboxProviderRecommendation.DisposableLocalVm
              && !homeFallback.CanLaunch,
            "Windows 10 Home selects the Disposable local VM fallback without claiming it is ready");
        Check(homeFallback.Title.Contains("setup required", StringComparison.OrdinalIgnoreCase)
              && homeFallback.BlockingReasons.Any(reason =>
                  reason.Contains("No recognized local VM provider", StringComparison.OrdinalIgnoreCase)),
            "Windows 10 Home without a verified provider says setup is required");

        var homeWithProvider = WindowsSandboxReadinessScanner.Decide(
            Facts(
                productName: "Windows 10 Home",
                edition: "Core",
                displayVersion: "22H2",
                buildNumber: 19045,
                featurePresent: false,
                providerAvailability: LocalVmProviderAvailability.Installed,
                providerVersion: "7.1.0"),
            CheckedAt);
        Check(homeWithProvider.Status == WindowsSandboxReadinessStatus.DisposableLocalVmNeedsReview
              && !homeWithProvider.CanLaunch
              && homeWithProvider.BlockingReasons.Any(reason =>
                  reason.Contains("clean base image", StringComparison.OrdinalIgnoreCase)),
            "an installed Home fallback provider still needs an approved clean image and cannot launch");

        var prerequisites = WindowsSandboxReadinessScanner.Decide(
            Facts(virtualization: false),
            CheckedAt);
        Check(prerequisites.Status == WindowsSandboxReadinessStatus.PrerequisitesUnavailable
              && prerequisites.BlockingReasons.Any(reason =>
                  reason.Contains("virtualization", StringComparison.OrdinalIgnoreCase)),
            "disabled firmware virtualization is a named prerequisite blocker");

        var unknownMemory = WindowsSandboxReadinessScanner.Decide(
            Facts(memoryBytes: 0),
            CheckedAt);
        Check(unknownMemory.Status == WindowsSandboxReadinessStatus.PrerequisitesUnavailable
              && unknownMemory.BlockingReasons.Any(reason =>
                  reason.Contains("could not be verified", StringComparison.OrdinalIgnoreCase)),
            "unavailable resource evidence is unknown and never treated as ready");

        var configuration = WindowsSandboxConfiguration.BuildDefaultIsolated();
        Check(configuration.Contains("<Networking>Disable</Networking>", StringComparison.Ordinal)
              && configuration.Contains("<ClipboardRedirection>Disable</ClipboardRedirection>", StringComparison.Ordinal),
            "default sandbox configuration disables networking and clipboard transfer");
        Check(!configuration.Contains("MappedFolder", StringComparison.OrdinalIgnoreCase)
              && !configuration.Contains("HostFolder", StringComparison.OrdinalIgnoreCase)
              && !configuration.Contains("LogonCommand", StringComparison.OrdinalIgnoreCase),
            "default sandbox configuration contains no host mapping or automatic command");

        var configurationReview = WindowsSandboxConfiguration.ReviewDefaultIsolated();
        Check(configurationReview.Decision == ExternalItemReviewDecision.ReadyToApprove
              && configurationReview.Evidence.Sha256 is { Length: 64 },
            "generated sandbox configuration passes the shared review before launch approval");

        var store = new FakeStore();
        var starter = new FakeStarter();
        var cleanup = new FakeCleanupScheduler();
        var coordinator = new WindowsSandboxLaunchCoordinator(store, starter, cleanup);

        var unconfirmed = coordinator.Launch(
            available,
            WindowsSandboxLaunchConfirmation.NotConfirmed);
        Check(!unconfirmed.LaunchRequested
              && store.CreateCount == 0
              && starter.StartCount == 0,
            "unconfirmed request creates no configuration and starts no process");

        var unavailable = coordinator.Launch(
            needsFeature,
            WindowsSandboxLaunchConfirmation.Confirmed);
        Check(!unavailable.LaunchRequested
              && store.CreateCount == 0
              && starter.StartCount == 0,
            "confirmation cannot bypass an unavailable readiness decision");

        var fallbackLaunch = coordinator.Launch(
            homeWithProvider,
            WindowsSandboxLaunchConfirmation.Confirmed);
        Check(!fallbackLaunch.LaunchRequested
              && store.CreateCount == 0
              && starter.StartCount == 0,
            "VM fallback inventory never routes into the Windows Sandbox launcher");

        var launched = coordinator.Launch(
            available,
            WindowsSandboxLaunchConfirmation.Confirmed);
        Check(launched.LaunchRequested
              && store.CreateCount == 1
              && starter.StartCount == 1
              && cleanup.ScheduleCount == 1,
            "confirmed eligible request writes once, starts once, and schedules cleanup");
        Check(store.LastConfiguration == configuration,
            "launch coordinator writes the tested no-host-access configuration exactly");

        var failingStore = new FakeStore();
        var failingStarter = new FakeStarter { ThrowOnStart = true };
        var failed = new WindowsSandboxLaunchCoordinator(
                failingStore,
                failingStarter,
                new FakeCleanupScheduler())
            .Launch(available, WindowsSandboxLaunchConfirmation.Confirmed);
        Check(!failed.LaunchRequested
              && failingStore.DeleteCount == 1,
            "failed process start removes the temporary configuration immediately");

        Console.WriteLine("Helmion Windows Sandbox orchestration checks passed (17 checks; no process launched).");
    }

    private static WindowsSandboxSystemFacts Facts(
        string productName = "Windows 11 Pro",
        string edition = "Professional",
        string displayVersion = "24H2",
        int buildNumber = 26100,
        bool featurePresent = true,
        bool virtualization = true,
        ulong memoryBytes = 16UL * 1024 * 1024 * 1024,
        LocalVmProviderAvailability providerAvailability = LocalVmProviderAvailability.NotInstalled,
        string? providerVersion = null) =>
        new(
            IsWindows: true,
            ProductName: productName,
            EditionId: edition,
            DisplayVersion: displayVersion,
            BuildNumber: buildNumber,
            Architecture: Architecture.X64,
            IsClientInstallation: true,
            FeatureExecutablePresent: featurePresent,
            FeatureExecutablePath: featurePresent
                ? @"C:\Windows\System32\WindowsSandbox.exe"
                : null,
            FirmwareVirtualizationEnabled: virtualization,
            SecondLevelAddressTranslationAvailable: true,
            LogicalProcessorCount: 8,
            TotalPhysicalMemoryBytes: memoryBytes,
            AvailableSystemDriveBytes: 40L * 1024 * 1024 * 1024,
            LocalVmProviders:
            [
                new LocalVmProviderInventory(
                    "Oracle VirtualBox",
                    providerAvailability,
                    providerVersion,
                    providerAvailability == LocalVmProviderAvailability.Installed
                        ? "Verified at the exact registered provider location."
                        : "No exact machine registration detected.")
            ]);

    private static void Check(bool condition, string message)
    {
        if (!condition) throw new InvalidOperationException("FAIL: " + message);
    }

    private sealed class FakeStore : IWindowsSandboxConfigurationStore
    {
        public int CreateCount { get; private set; }
        public int DeleteCount { get; private set; }
        public string? LastConfiguration { get; private set; }

        public string Create(string configuration)
        {
            CreateCount++;
            LastConfiguration = configuration;
            return @"C:\Temp\helmian-test.wsb";
        }

        public void DeleteBestEffort(string path)
        {
            DeleteCount++;
        }
    }

    private sealed class FakeStarter : IWindowsSandboxProcessStarter
    {
        public int StartCount { get; private set; }
        public bool ThrowOnStart { get; init; }

        public int? Start(string executablePath, string configurationPath)
        {
            StartCount++;
            if (ThrowOnStart) throw new InvalidOperationException("synthetic start failure");
            return 4242;
        }
    }

    private sealed class FakeCleanupScheduler : IWindowsSandboxCleanupScheduler
    {
        public int ScheduleCount { get; private set; }

        public void Schedule(string path, Action<string> cleanup)
        {
            ScheduleCount++;
        }
    }
}
