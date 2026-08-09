using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using Microsoft.Win32;

namespace Helmion.Desktop.Core;

public enum WindowsSandboxReadinessStatus
{
    Available,
    NeedsWindowsFeature,
    PrerequisitesUnavailable,
    DisposableLocalVmSetupRequired,
    DisposableLocalVmNeedsReview
}

public enum SandboxProviderRecommendation
{
    None,
    WindowsSandbox,
    DisposableLocalVm
}

public enum LocalVmProviderAvailability
{
    Installed,
    NotInstalled,
    EvidenceUnavailable
}

public enum WindowsSandboxLaunchConfirmation
{
    NotConfirmed,
    Confirmed
}

public sealed record LocalVmProviderInventory(
    string ProviderName,
    LocalVmProviderAvailability Availability,
    string? Version,
    string Evidence);

public sealed record WindowsSandboxSystemFacts(
    bool IsWindows,
    string ProductName,
    string EditionId,
    string DisplayVersion,
    int BuildNumber,
    Architecture Architecture,
    bool IsClientInstallation,
    bool FeatureExecutablePresent,
    string? FeatureExecutablePath,
    bool? FirmwareVirtualizationEnabled,
    bool? SecondLevelAddressTranslationAvailable,
    int LogicalProcessorCount,
    ulong TotalPhysicalMemoryBytes,
    long AvailableSystemDriveBytes,
    IReadOnlyList<LocalVmProviderInventory>? LocalVmProviders = null);

public sealed record WindowsSandboxFactRow(string Category, string Value);

public sealed record WindowsSandboxReadiness(
    WindowsSandboxReadinessStatus Status,
    string Title,
    string Explanation,
    IReadOnlyList<WindowsSandboxFactRow> Facts,
    IReadOnlyList<string> BlockingReasons,
    DateTimeOffset CheckedAtUtc,
    SandboxProviderRecommendation RecommendedProvider,
    string? FeatureExecutablePath)
{
    public bool CanLaunch => Status == WindowsSandboxReadinessStatus.Available
                             && RecommendedProvider == SandboxProviderRecommendation.WindowsSandbox;

    public bool UsesDisposableLocalVmFallback =>
        RecommendedProvider == SandboxProviderRecommendation.DisposableLocalVm;
}

/// <summary>
/// Reads only machine-level Windows facts needed for a sandbox provider decision.
/// It does not enumerate user folders, project files, credentials, browsers, or
/// message history. Local VM inventory is limited to an exact registered provider
/// location and executable name, and the inspection never starts a child process.
/// </summary>
public interface IWindowsSandboxSystemFactsSource
{
    WindowsSandboxSystemFacts Read();
}

public sealed class WindowsSandboxSystemFactsSource : IWindowsSandboxSystemFactsSource
{
    private const uint PfSecondLevelAddressTranslation = 20;
    private const uint PfVirtualizationFirmwareEnabled = 21;

    public WindowsSandboxSystemFacts Read()
    {
        var isWindows = OperatingSystem.IsWindows();
        var productName = "Windows not detected";
        var editionId = "Unknown";
        var displayVersion = "Unknown";
        var buildNumber = Environment.OSVersion.Version.Build;
        var isClientInstallation = false;

        if (isWindows)
        {
            try
            {
                using var key = Registry.LocalMachine.OpenSubKey(
                    @"SOFTWARE\Microsoft\Windows NT\CurrentVersion",
                    writable: false);
                productName = ReadRegistryString(key, "ProductName", "Windows");
                editionId = ReadRegistryString(key, "EditionID", "Unknown");
                displayVersion = ReadRegistryString(
                    key,
                    "DisplayVersion",
                    ReadRegistryString(key, "ReleaseId", "Unknown"));
                buildNumber = ReadRegistryInt(key, "CurrentBuildNumber", buildNumber);
                isClientInstallation = string.Equals(
                    ReadRegistryString(key, "InstallationType", string.Empty),
                    "Client",
                    StringComparison.OrdinalIgnoreCase);
            }
            catch (Exception exception) when (exception is UnauthorizedAccessException
                                               or System.Security.SecurityException
                                               or IOException)
            {
                // A denied machine registry read is reported as Unknown. It must not
                // trigger a fallback process or a broader filesystem inspection.
            }
        }

        var sandboxExecutable = isWindows
            ? Path.Combine(Environment.SystemDirectory, "WindowsSandbox.exe")
            : null;
        var sandboxExecutablePresent = sandboxExecutable is not null
                                       && File.Exists(sandboxExecutable);

        return new WindowsSandboxSystemFacts(
            isWindows,
            productName,
            editionId,
            displayVersion,
            buildNumber,
            RuntimeInformation.OSArchitecture,
            isClientInstallation,
            sandboxExecutablePresent,
            sandboxExecutablePresent ? sandboxExecutable : null,
            ReadProcessorFeature(isWindows, PfVirtualizationFirmwareEnabled),
            ReadProcessorFeature(isWindows, PfSecondLevelAddressTranslation),
            Environment.ProcessorCount,
            ReadTotalPhysicalMemory(isWindows),
            ReadAvailableSystemDriveBytes(isWindows),
            ReadLocalVmProviders(isWindows));
    }

    private static string ReadRegistryString(RegistryKey? key, string name, string fallback) =>
        Convert.ToString(key?.GetValue(name), System.Globalization.CultureInfo.InvariantCulture)
        is { Length: > 0 } value
            ? value
            : fallback;

    private static int ReadRegistryInt(RegistryKey? key, string name, int fallback) =>
        int.TryParse(
            Convert.ToString(key?.GetValue(name), System.Globalization.CultureInfo.InvariantCulture),
            System.Globalization.NumberStyles.Integer,
            System.Globalization.CultureInfo.InvariantCulture,
            out var value)
            ? value
            : fallback;

    private static bool? ReadProcessorFeature(bool isWindows, uint feature)
    {
        if (!isWindows) return null;

        try
        {
            return IsProcessorFeaturePresent(feature);
        }
        catch (Exception exception) when (exception is DllNotFoundException or EntryPointNotFoundException)
        {
            return null;
        }
    }

    private static ulong ReadTotalPhysicalMemory(bool isWindows)
    {
        if (!isWindows) return 0;

        try
        {
            var status = new MemoryStatusEx();
            return GlobalMemoryStatusEx(ref status) ? status.TotalPhysical : 0;
        }
        catch (Exception exception) when (exception is DllNotFoundException or EntryPointNotFoundException)
        {
            return 0;
        }
    }

    private static long ReadAvailableSystemDriveBytes(bool isWindows)
    {
        if (!isWindows) return 0;

        try
        {
            var root = Path.GetPathRoot(Environment.SystemDirectory);
            return string.IsNullOrWhiteSpace(root) ? 0 : new DriveInfo(root).AvailableFreeSpace;
        }
        catch (Exception exception) when (exception is IOException
                                           or UnauthorizedAccessException
                                           or ArgumentException)
        {
            return 0;
        }
    }

    private static IReadOnlyList<LocalVmProviderInventory> ReadLocalVmProviders(bool isWindows)
    {
        const string providerName = "Oracle VirtualBox";
        if (!isWindows)
        {
            return
            [
                new LocalVmProviderInventory(
                    providerName,
                    LocalVmProviderAvailability.EvidenceUnavailable,
                    null,
                    "Windows provider inventory is unavailable because Windows was not detected.")
            ];
        }

        LocalVmProviderInventory? incompleteRegistration = null;
        var registryEvidenceUnavailable = false;

        foreach (var view in new[] { RegistryView.Registry64, RegistryView.Registry32 })
        {
            try
            {
                using var baseKey = RegistryKey.OpenBaseKey(RegistryHive.LocalMachine, view);
                using var key = baseKey.OpenSubKey(@"SOFTWARE\Oracle\VirtualBox", writable: false);
                if (key is null) continue;

                var version = ReadRegistryString(
                    key,
                    "VersionExt",
                    ReadRegistryString(key, "Version", "Unknown"));
                var installDirectory = ReadRegistryString(key, "InstallDir", string.Empty);
                if (string.IsNullOrWhiteSpace(installDirectory))
                {
                    incompleteRegistration = new LocalVmProviderInventory(
                        providerName,
                        LocalVmProviderAvailability.EvidenceUnavailable,
                        version,
                        "The exact provider registration exists, but it does not name an install directory.");
                    continue;
                }

                var executablePath = Path.Combine(installDirectory, "VirtualBox.exe");
                if (File.Exists(executablePath))
                {
                    return
                    [
                        new LocalVmProviderInventory(
                            providerName,
                            LocalVmProviderAvailability.Installed,
                            version,
                            "Installed executable verified at the exact machine-registered provider location.")
                    ];
                }

                incompleteRegistration = new LocalVmProviderInventory(
                    providerName,
                    LocalVmProviderAvailability.EvidenceUnavailable,
                    version,
                    "The provider registration exists, but VirtualBox.exe was not present at its exact registered location.");
            }
            catch (Exception exception) when (exception is UnauthorizedAccessException
                                               or System.Security.SecurityException
                                               or IOException
                                               or ArgumentException
                                               or PlatformNotSupportedException)
            {
                registryEvidenceUnavailable = true;
            }
        }

        if (incompleteRegistration is not null) return [incompleteRegistration];

        return
        [
            new LocalVmProviderInventory(
                providerName,
                registryEvidenceUnavailable
                    ? LocalVmProviderAvailability.EvidenceUnavailable
                    : LocalVmProviderAvailability.NotInstalled,
                null,
                registryEvidenceUnavailable
                    ? "The exact machine-level provider registration could not be read. Availability remains unknown."
                    : "No exact machine-level Oracle VirtualBox registration was detected; Helmian did not search user folders or drives.")
        ];
    }

    [DllImport("kernel32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool IsProcessorFeaturePresent(uint processorFeature);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GlobalMemoryStatusEx(ref MemoryStatusEx buffer);

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Auto)]
    private struct MemoryStatusEx
    {
        public uint Length;
        public uint MemoryLoad;
        public ulong TotalPhysical;
        public ulong AvailablePhysical;
        public ulong TotalPageFile;
        public ulong AvailablePageFile;
        public ulong TotalVirtual;
        public ulong AvailableVirtual;
        public ulong AvailableExtendedVirtual;

        public MemoryStatusEx()
        {
            Length = (uint)Marshal.SizeOf<MemoryStatusEx>();
        }
    }
}

public sealed class WindowsSandboxReadinessScanner
{
    public const ulong MinimumMemoryBytes = 4UL * 1024 * 1024 * 1024;
    public const long MinimumFreeDiskBytes = 1L * 1024 * 1024 * 1024;
    public const long MinimumDisposableVmFreeDiskBytes = 20L * 1024 * 1024 * 1024;
    public const int MinimumLogicalProcessors = 2;

    private readonly IWindowsSandboxSystemFactsSource _factsSource;
    private readonly Func<DateTimeOffset> _clock;

    public WindowsSandboxReadinessScanner(
        IWindowsSandboxSystemFactsSource? factsSource = null,
        Func<DateTimeOffset>? clock = null)
    {
        _factsSource = factsSource ?? new WindowsSandboxSystemFactsSource();
        _clock = clock ?? (() => DateTimeOffset.UtcNow);
    }

    public WindowsSandboxReadiness Inspect() => Decide(_factsSource.Read(), _clock());

    public static WindowsSandboxReadiness Decide(
        WindowsSandboxSystemFacts facts,
        DateTimeOffset checkedAtUtc)
    {
        var localVmProviders = facts.LocalVmProviders ?? [];
        var factRows = new List<WindowsSandboxFactRow>
        {
            new(
                "Windows identity",
                $"{facts.ProductName} · edition {facts.EditionId} · version {facts.DisplayVersion} · build {facts.BuildNumber}"),
            new(
                "Windows Sandbox feature",
                facts.FeatureExecutablePresent
                    ? "Enabled component detected at the known Windows system location"
                    : "Enabled component not detected at the known Windows system location"),
            new(
                "Virtualization",
                $"Firmware virtualization {FormatBoolean(facts.FirmwareVirtualizationEnabled)} · second-level address translation {FormatBoolean(facts.SecondLevelAddressTranslationAvailable)}"),
            new(
                "Hardware",
                $"{facts.Architecture} architecture · {facts.LogicalProcessorCount} logical processors"),
            new(
                "Resources",
                $"{FormatGiB(facts.TotalPhysicalMemoryBytes)} total memory · {FormatGiB(facts.AvailableSystemDriveBytes)} free on the Windows system drive"),
            new(
                "Local VM providers",
                FormatLocalVmProviders(localVmProviders))
        };

        if (!facts.IsWindows || !facts.IsClientInstallation)
        {
            return new WindowsSandboxReadiness(
                WindowsSandboxReadinessStatus.PrerequisitesUnavailable,
                "Sandbox provider could not be selected",
                "A supported Windows client installation could not be verified. Helmian will not guess, install a provider, search for images, or offer launch.",
                factRows,
                ["A Windows client installation must be verified before selecting a sandbox provider."],
                checkedAtUtc,
                SandboxProviderRecommendation.None,
                null);
        }

        if (!IsSupportedEdition(facts.EditionId))
        {
            return DecideDisposableLocalVmFallback(
                facts,
                localVmProviders,
                factRows,
                checkedAtUtc);
        }

        var blockers = FindWindowsSandboxPrerequisiteBlockers(facts);
        if (blockers.Count > 0)
        {
            return new WindowsSandboxReadiness(
                WindowsSandboxReadinessStatus.PrerequisitesUnavailable,
                "Windows Sandbox prerequisites unavailable",
                "The machine does not currently report all minimum prerequisites. Helmian will explain the result, but will not alter firmware, Windows features, security settings, or system configuration.",
                factRows,
                blockers,
                checkedAtUtc,
                SandboxProviderRecommendation.WindowsSandbox,
                null);
        }

        if (!facts.FeatureExecutablePresent || string.IsNullOrWhiteSpace(facts.FeatureExecutablePath))
        {
            return new WindowsSandboxReadiness(
                WindowsSandboxReadinessStatus.NeedsWindowsFeature,
                "Windows Sandbox needs the Windows feature",
                "This edition and the reported prerequisites are eligible, but the enabled Windows Sandbox component was not detected. Helmian will not enable it or make privileged changes.",
                factRows,
                ["The Windows Sandbox feature is not enabled or its system component is unavailable."],
                checkedAtUtc,
                SandboxProviderRecommendation.WindowsSandbox,
                null);
        }

        return new WindowsSandboxReadiness(
            WindowsSandboxReadinessStatus.Available,
            "Windows Sandbox available",
            "Windows Sandbox is a disposable operating-system boundary. Everything inside it is discarded when it closes. Launch still requires a separate explicit confirmation.",
            factRows,
            [],
            checkedAtUtc,
            SandboxProviderRecommendation.WindowsSandbox,
            facts.FeatureExecutablePath);
    }

    private static WindowsSandboxReadiness DecideDisposableLocalVmFallback(
        WindowsSandboxSystemFacts facts,
        IReadOnlyList<LocalVmProviderInventory> providers,
        IReadOnlyList<WindowsSandboxFactRow> factRows,
        DateTimeOffset checkedAtUtc)
    {
        var prerequisiteBlockers = FindDisposableLocalVmPrerequisiteBlockers(facts);
        var builtInReason =
            $"Built-in Windows Sandbox is unavailable on edition {facts.EditionId}; it is not being presented as ready.";

        if (prerequisiteBlockers.Count > 0)
        {
            return new WindowsSandboxReadiness(
                WindowsSandboxReadinessStatus.DisposableLocalVmSetupRequired,
                "Disposable local VM prerequisites unavailable",
                "Built-in Windows Sandbox is not supported on this edition. The cross-version fallback is a separately approved disposable local VM, but the machine does not currently report all prerequisite facts. Helmian will not change firmware, install a provider, or configure an image.",
                factRows,
                [builtInReason, .. prerequisiteBlockers],
                checkedAtUtc,
                SandboxProviderRecommendation.DisposableLocalVm,
                null);
        }

        var installedProvider = providers.FirstOrDefault(provider =>
            provider.Availability == LocalVmProviderAvailability.Installed);
        if (installedProvider is null)
        {
            var providerReason = providers.Any(provider =>
                provider.Availability == LocalVmProviderAvailability.EvidenceUnavailable)
                ? "A recognized local VM provider could not be verified. Unknown availability is not treated as ready."
                : "No recognized local VM provider is installed. Provider installation requires separate explicit approval.";
            return new WindowsSandboxReadiness(
                WindowsSandboxReadinessStatus.DisposableLocalVmSetupRequired,
                "Disposable local VM setup required",
                "Built-in Windows Sandbox is not supported on this edition. Helmian recommends a Disposable local VM boundary, but it is only a setup plan until a provider and a clean base image are separately approved. Helmian will not install or configure either one.",
                factRows,
                [builtInReason, providerReason, "No approved clean base image or template is configured."],
                checkedAtUtc,
                SandboxProviderRecommendation.DisposableLocalVm,
                null);
        }

        var version = string.IsNullOrWhiteSpace(installedProvider.Version)
            ? string.Empty
            : $" {installedProvider.Version}";
        return new WindowsSandboxReadiness(
            WindowsSandboxReadinessStatus.DisposableLocalVmNeedsReview,
            "Disposable local VM needs approved image",
            $"Built-in Windows Sandbox is not supported on this edition. {installedProvider.ProviderName}{version} is installed, but Helmian has not approved a clean base image/template or enabled a VM launch adapter. Setup and any later create/launch action require separate explicit consent.",
            factRows,
            [builtInReason, "A clean base image/template and provider configuration still require review and explicit approval."],
            checkedAtUtc,
            SandboxProviderRecommendation.DisposableLocalVm,
            null);
    }

    private static bool IsSupportedEdition(string editionId) =>
        editionId.Contains("Professional", StringComparison.OrdinalIgnoreCase)
        || editionId.Contains("Enterprise", StringComparison.OrdinalIgnoreCase)
        || editionId.Contains("Education", StringComparison.OrdinalIgnoreCase);

    private static List<string> FindWindowsSandboxPrerequisiteBlockers(WindowsSandboxSystemFacts facts)
    {
        var blockers = new List<string>();
        var buildFloor = facts.Architecture == Architecture.Arm64 ? 22621 : 18362;

        if (facts.Architecture is not Architecture.X64 and not Architecture.Arm64)
        {
            blockers.Add("Windows Sandbox requires an AMD64 or supported ARM64 Windows installation.");
        }

        if (facts.BuildNumber < buildFloor)
        {
            blockers.Add($"Windows build {facts.BuildNumber} is below the required build {buildFloor} for this architecture.");
        }

        if (facts.FirmwareVirtualizationEnabled != true)
        {
            blockers.Add(facts.FirmwareVirtualizationEnabled is false
                ? "Windows reports that firmware virtualization is disabled."
                : "Firmware virtualization status could not be verified.");
        }

        if (facts.SecondLevelAddressTranslationAvailable != true)
        {
            blockers.Add(facts.SecondLevelAddressTranslationAvailable is false
                ? "Windows reports that second-level address translation is unavailable."
                : "Second-level address translation status could not be verified.");
        }

        if (facts.LogicalProcessorCount < MinimumLogicalProcessors)
        {
            blockers.Add($"At least {MinimumLogicalProcessors} logical processors are required.");
        }

        if (facts.TotalPhysicalMemoryBytes < MinimumMemoryBytes)
        {
            blockers.Add(facts.TotalPhysicalMemoryBytes == 0
                ? "Total physical memory could not be verified."
                : "At least 4 GB of physical memory is required.");
        }

        if (facts.AvailableSystemDriveBytes < MinimumFreeDiskBytes)
        {
            blockers.Add(facts.AvailableSystemDriveBytes == 0
                ? "Free space on the Windows system drive could not be verified."
                : "At least 1 GB of free space on the Windows system drive is required.");
        }

        return blockers;
    }

    private static List<string> FindDisposableLocalVmPrerequisiteBlockers(
        WindowsSandboxSystemFacts facts)
    {
        var blockers = new List<string>();

        if (facts.Architecture != Architecture.X64)
        {
            blockers.Add("The current recognized Disposable local VM provider inventory supports only AMD64 Windows hosts.");
        }

        if (facts.FirmwareVirtualizationEnabled != true)
        {
            blockers.Add(facts.FirmwareVirtualizationEnabled is false
                ? "Windows reports that firmware virtualization is disabled."
                : "Firmware virtualization status could not be verified.");
        }

        if (facts.LogicalProcessorCount < MinimumLogicalProcessors)
        {
            blockers.Add($"At least {MinimumLogicalProcessors} logical processors are required.");
        }

        if (facts.TotalPhysicalMemoryBytes < MinimumMemoryBytes)
        {
            blockers.Add(facts.TotalPhysicalMemoryBytes == 0
                ? "Total physical memory could not be verified."
                : "At least 4 GB of physical memory is required.");
        }

        if (facts.AvailableSystemDriveBytes < MinimumDisposableVmFreeDiskBytes)
        {
            blockers.Add(facts.AvailableSystemDriveBytes == 0
                ? "Free space on the Windows system drive could not be verified."
                : "At least 20 GB of free space is required before a disposable local VM setup can be reviewed.");
        }

        return blockers;
    }

    private static string FormatLocalVmProviders(
        IReadOnlyList<LocalVmProviderInventory> providers)
    {
        if (providers.Count == 0)
        {
            return "No provider evidence supplied · availability unknown and not ready";
        }

        return string.Join("; ", providers.Select(provider =>
        {
            var version = string.IsNullOrWhiteSpace(provider.Version)
                ? string.Empty
                : $" {provider.Version}";
            return $"{provider.ProviderName}{version} · {provider.Availability} · {provider.Evidence}";
        }));
    }

    private static string FormatBoolean(bool? value) => value switch
    {
        true => "available",
        false => "unavailable",
        null => "unknown"
    };

    private static string FormatGiB(ulong bytes) => bytes == 0
        ? "unknown"
        : $"{bytes / 1024d / 1024d / 1024d:0.0} GB";

    private static string FormatGiB(long bytes) => bytes <= 0
        ? "unknown"
        : $"{bytes / 1024d / 1024d / 1024d:0.0} GB";
}

public static class WindowsSandboxConfiguration
{
    /// <summary>
    /// Produces the first-launch profile: no mapped folders, no logon command,
    /// no network, no clipboard, and no host device redirection.
    /// </summary>
    public static string BuildDefaultIsolated()
    {
        var xml = new StringBuilder();
        xml.AppendLine("<Configuration>");
        xml.AppendLine("  <VGpu>Disable</VGpu>");
        xml.AppendLine("  <Networking>Disable</Networking>");
        xml.AppendLine("  <AudioInput>Disable</AudioInput>");
        xml.AppendLine("  <VideoInput>Disable</VideoInput>");
        xml.AppendLine("  <PrinterRedirection>Disable</PrinterRedirection>");
        xml.AppendLine("  <ClipboardRedirection>Disable</ClipboardRedirection>");
        xml.AppendLine("</Configuration>");
        return xml.ToString();
    }

    /// <summary>
    /// Routes Helmian's own generated configuration through the same pre-install
    /// evidence contract as downloads, plugins, skills, MCP servers and other
    /// outside items before a launch confirmation is offered.
    /// </summary>
    public static ExternalItemReview ReviewDefaultIsolated()
    {
        var configuration = BuildDefaultIsolated();
        var hash = Convert.ToHexString(
            System.Security.Cryptography.SHA256.HashData(
                Encoding.UTF8.GetBytes(configuration))).ToLowerInvariant();
        var evidence = new ExternalItemEvidence(
            ExternalItemKind.WindowsSandboxConfiguration,
            "Helmian disposable Windows Sandbox configuration",
            "Locally generated Windows Sandbox launch configuration",
            "Compiled Helmian configuration template",
            ExternalEvidenceState.Verified,
            "Generated in memory by this Helmian build; no website, repository, or download is involved.",
            hash,
            ".wsb XML configuration",
            ExternalEvidenceState.NotApplicable,
            "Publisher signature is not applicable to an in-memory configuration template.",
            ExternalEvidenceState.Verified,
            "Explicit Windows Sandbox configuration: no mapped folders or logon command.",
            ExternalEvidenceState.Verified,
            [
                "networking: disabled",
                "host folders: none",
                "clipboard: disabled",
                "audio/video input: disabled",
                "printer redirection: disabled",
                "vGPU: disabled"
            ],
            []);
        return ExternalItemReviewPolicy.Evaluate(evidence);
    }
}

public interface IWindowsSandboxConfigurationStore
{
    string Create(string configuration);
    void DeleteBestEffort(string path);
}

public interface IWindowsSandboxProcessStarter
{
    int? Start(string executablePath, string configurationPath);
}

public interface IWindowsSandboxCleanupScheduler
{
    void Schedule(string path, Action<string> cleanup);
}

public sealed record WindowsSandboxLaunchResult(
    bool LaunchRequested,
    string Message,
    string? TemporaryConfigurationPath,
    int? ProcessId);

public sealed class WindowsSandboxLaunchCoordinator
{
    private readonly IWindowsSandboxConfigurationStore _configurationStore;
    private readonly IWindowsSandboxProcessStarter _processStarter;
    private readonly IWindowsSandboxCleanupScheduler _cleanupScheduler;

    public WindowsSandboxLaunchCoordinator(
        IWindowsSandboxConfigurationStore? configurationStore = null,
        IWindowsSandboxProcessStarter? processStarter = null,
        IWindowsSandboxCleanupScheduler? cleanupScheduler = null)
    {
        _configurationStore = configurationStore ?? new WindowsSandboxConfigurationStore();
        _processStarter = processStarter ?? new WindowsSandboxProcessStarter();
        _cleanupScheduler = cleanupScheduler ?? new WindowsSandboxCleanupScheduler();
    }

    public WindowsSandboxLaunchResult Launch(
        WindowsSandboxReadiness readiness,
        WindowsSandboxLaunchConfirmation confirmation)
    {
        if (confirmation != WindowsSandboxLaunchConfirmation.Confirmed)
        {
            return new WindowsSandboxLaunchResult(
                false,
                "Launch not requested: explicit confirmation is still required.",
                null,
                null);
        }

        if (!readiness.CanLaunch || string.IsNullOrWhiteSpace(readiness.FeatureExecutablePath))
        {
            return new WindowsSandboxLaunchResult(
                false,
                "Launch not requested: the latest readiness result does not permit Windows Sandbox launch.",
                null,
                null);
        }

        var configurationPath = _configurationStore.Create(
            WindowsSandboxConfiguration.BuildDefaultIsolated());

        try
        {
            var processId = _processStarter.Start(
                readiness.FeatureExecutablePath,
                configurationPath);
            _cleanupScheduler.Schedule(configurationPath, _configurationStore.DeleteBestEffort);
            return new WindowsSandboxLaunchResult(
                true,
                "Disposable Windows Sandbox launch requested with networking, clipboard, device redirection, and host-folder mapping disabled.",
                configurationPath,
                processId);
        }
        catch (Exception exception) when (exception is InvalidOperationException
                                           or System.ComponentModel.Win32Exception
                                           or IOException
                                           or UnauthorizedAccessException)
        {
            _configurationStore.DeleteBestEffort(configurationPath);
            return new WindowsSandboxLaunchResult(
                false,
                $"Windows Sandbox did not launch: {exception.Message}",
                null,
                null);
        }
    }
}

public sealed class WindowsSandboxConfigurationStore : IWindowsSandboxConfigurationStore
{
    public string Create(string configuration)
    {
        var directory = Path.Combine(Path.GetTempPath(), "Helmian", "WindowsSandbox");
        Directory.CreateDirectory(directory);
        var path = Path.Combine(directory, $"helmian-disposable-{Guid.NewGuid():N}.wsb");
        File.WriteAllText(path, configuration, new UTF8Encoding(encoderShouldEmitUTF8Identifier: false));
        return path;
    }

    public void DeleteBestEffort(string path)
    {
        try
        {
            if (File.Exists(path)) File.Delete(path);
        }
        catch (Exception exception) when (exception is IOException or UnauthorizedAccessException)
        {
            // Temporary configuration contains no host paths or secrets. Cleanup is
            // retried on process exit by the scheduler and is intentionally best effort.
        }
    }
}

public sealed class WindowsSandboxProcessStarter : IWindowsSandboxProcessStarter
{
    public int? Start(string executablePath, string configurationPath)
    {
        var startInfo = new ProcessStartInfo
        {
            FileName = executablePath,
            UseShellExecute = false,
            WorkingDirectory = Path.GetDirectoryName(executablePath) ?? Environment.SystemDirectory
        };
        startInfo.ArgumentList.Add(configurationPath);

        using var process = Process.Start(startInfo)
            ?? throw new InvalidOperationException("Windows did not return a Sandbox process.");
        return process.Id;
    }
}

public sealed class WindowsSandboxCleanupScheduler : IWindowsSandboxCleanupScheduler
{
    private static readonly TimeSpan CleanupDelay = TimeSpan.FromMinutes(2);

    public void Schedule(string path, Action<string> cleanup)
    {
        AppDomain.CurrentDomain.ProcessExit += (_, _) => cleanup(path);
        _ = CleanupLaterAsync(path, cleanup);
    }

    private static async Task CleanupLaterAsync(string path, Action<string> cleanup)
    {
        try
        {
            await Task.Delay(CleanupDelay).ConfigureAwait(false);
            cleanup(path);
        }
        catch
        {
            // Best-effort cleanup must never destabilize the desktop process.
        }
    }
}
