using Helmion.Desktop.Core;
using Helmion.LocalService.Protocol;
using Helmion.LocalService.Security;

var snapshot = PilotSnapshot.CreateDemo(
    new DateTimeOffset(2026, 7, 27, 12, 0, 0, TimeSpan.Zero));
var settingsRoot = Path.Combine(
    Path.GetTempPath(),
    $"helmion-desktop-settings-smoke-{Guid.NewGuid():N}");

Check(snapshot.ModeLabel == "Personal Pilot", "personal pilot mode is explicit");
Check(snapshot.DataSource == PilotDataSource.Demo, "data source is demo");
Check(snapshot.DataSourceLabel.Contains("Demo data", StringComparison.Ordinal), "demo label is visible");
Check(!snapshot.LocalServiceConnected, "local service defaults disconnected");
Check(!snapshot.AdvancedOwnerSigningConfigured, "owner signing defaults unconfigured");
Check(!snapshot.ExternalAuthorityGranted, "demo grants no external authority");
Check(snapshot.LowRiskLocalWorkEnabled, "bounded local work remains enabled");
Check(snapshot.NavigationItems.SequenceEqual(
    ["Overview", "Workspace", "Console", "Activity", "Evidence", "Approvals", "Integrations", "Release", "Settings"]),
    "all required navigation destinations exist");
Check(snapshot.RecentActivity.All(item => item.IsDemo), "activity evidence is marked demo");
Check(snapshot.Handoffs.All(item => item.IsDemo), "handoffs are marked demo");
Check(snapshot.ApprovalQueue.All(item => item.IsDemo && !item.IsActionable),
    "approval previews are demo-only and non-actionable");
Check(
    snapshot.OrchestrationEvents.Count == 6
    && snapshot.OrchestrationEvents.All(item => item.IsDemo && !item.IsEvidenceBacked),
    "orchestration timeline examples are explicitly demo and make no evidence claims");
Check(snapshot.Integrations.All(item => !item.AcceptsSecrets && !item.IsLive),
    "integration cards accept no secrets and claim no live connection");
var providerProfiles = ProviderProfileCatalog.CreateUnconfigured();
Check(providerProfiles.Count == 8, "provider registry covers all eight pilot profiles");
Check(
    providerProfiles.Single(profile => profile.Id == "codex-cli").AuthenticationClass
        == "CLI account sign-in"
    && providerProfiles.Single(profile => profile.Id == "openai-api").AuthenticationClass
        == "API key / bearer credential"
    && providerProfiles.Single(profile => profile.Id == "gemini-cli").AuthenticationClass
        == "CLI Google account sign-in"
    && providerProfiles.Single(profile => profile.Id == "gemini-api").AuthenticationClass
        == "Gemini authorization API key",
    "Codex/OpenAI and Gemini CLI/API profiles keep authentication modes separate");
Check(
    providerProfiles.All(profile => !profile.AcceptsSecrets && !profile.IsActivated),
    "provider setup models accept no renderer secrets and activate nothing");
Check(snapshot.ReleaseCapabilities.Count == 9, "release roadmap covers nine product capability areas");
Check(snapshot.ReleasePhases.Count == 5
    && snapshot.ReleasePhases.Count(phase => phase.Status == "IN PROGRESS") == 1,
    "release phases distinguish current work from planned work");
Check(snapshot.ReleaseCapabilities.All(capability =>
        capability.CurrentState.Contains("demo", StringComparison.OrdinalIgnoreCase)
        || capability.CurrentState.Contains("local", StringComparison.OrdinalIgnoreCase)
        || capability.CurrentState.Contains("not implemented", StringComparison.OrdinalIgnoreCase)
        || capability.CurrentState.Contains("architecture", StringComparison.OrdinalIgnoreCase)
        || capability.CurrentState.Contains("guidance", StringComparison.OrdinalIgnoreCase)
        || capability.CurrentState.Contains("unsigned", StringComparison.OrdinalIgnoreCase)),
    "release capabilities state current limitations honestly");

var forbiddenPropertyFragments = new[] { "password", "secret", "token", "connectionstring" };
var propertyNames = typeof(PilotSnapshot)
    .GetProperties()
    .Select(property => property.Name.ToLowerInvariant())
    .ToArray();
Check(!propertyNames.Any(name => forbiddenPropertyFragments.Any(name.Contains)),
    "desktop state model has no credential-bearing properties");

try
{
    var settingsPath = Path.Combine(settingsRoot, "desktop-settings.json");
    DesktopSettingsStore.Save(new DesktopSettings(1, "ocean-blue"), settingsPath);
    Check(
        DesktopSettingsStore.Load(settingsPath).ColorTheme == "ocean-blue",
        "color theme persists without other user state");
    Check(
        ColorThemeCatalog.All.Select(theme => theme.Id).SequenceEqual(
            ["helmion-green", "ocean-blue", "clean-light", "warm-earth"]),
        "four supported color themes have stable IDs");
    File.WriteAllText(settingsPath, """{"Version":1,"ColorTheme":"unknown"}""");
    Check(
        DesktopSettingsStore.Load(settingsPath).ColorTheme == ColorThemeCatalog.DefaultThemeId,
        "unknown persisted themes fail safely to the Helmion default");
}
finally
{
    if (Directory.Exists(settingsRoot))
    {
        Directory.Delete(settingsRoot, recursive: true);
    }
}

Console.WriteLine("Helmion desktop smoke tests passed (23 checks).");

var workspaceRoot = Path.Combine(
    Path.GetTempPath(),
    $"helmion-workspace-inspection-smoke-{Guid.NewGuid():N}");
var pipeName = $"helmion-readonly-smoke-{Guid.NewGuid():N}";
using var pipeCancellation = new CancellationTokenSource();
var server = new ReadOnlyPipeServer(pipeName);
var serverTask = Task.Run(async () =>
{
    try
    {
        await server.RunAsync(pipeCancellation.Token);
    }
    catch (OperationCanceledException) when (pipeCancellation.IsCancellationRequested)
    {
    }
});

try
{
    Directory.CreateDirectory(Path.Combine(workspaceRoot, ".git"));
    Directory.CreateDirectory(Path.Combine(workspaceRoot, ".helmion", "evidence"));
    Directory.CreateDirectory(Path.Combine(workspaceRoot, "sql"));
    Directory.CreateDirectory(Path.Combine(workspaceRoot, "test"));
    Directory.CreateDirectory(Path.Combine(workspaceRoot, "docs"));
    File.WriteAllText(Path.Combine(workspaceRoot, ".git", "HEAD"), "ref: refs/heads/pilot-live\n");
    File.WriteAllText(
        Path.Combine(workspaceRoot, ".helmion", "evidence", "checkpoint.json"),
        """{"kind":"fixture"}""");
    File.WriteAllText(Path.Combine(workspaceRoot, "sql", "001_fixture.sql"), "select 1;\n");
    File.WriteAllText(Path.Combine(workspaceRoot, "test", "pilot.test.mjs"), "// fixture\n");
    File.WriteAllText(Path.Combine(workspaceRoot, "docs", "PHASE_FIVE.md"), "# Fixture\n");

    var before = SnapshotFiles(workspaceRoot);
    await using var client = await ReadOnlyPipeClient.ConnectAsync(
        Environment.ProcessPath
            ?? throw new InvalidOperationException("Smoke process path is unavailable"),
        TimeSpan.FromSeconds(5),
        pipeName: pipeName);
    var hello = await client.HelloAsync();
    Check(
        hello.ProtocolVersion == 1
        && hello.Mode == "read-only"
        && !hello.WritesEnabled,
        "named-pipe hello proves the versioned read-only service contract");
    Check(
        hello.Capabilities.SequenceEqual(
        [
            ReadOnlyServiceContract.HelloCommand,
            ReadOnlyServiceContract.InspectWorkspaceCommand,
            ReadOnlyServiceContract.DetectCapabilitiesCommand,
            ReadOnlyServiceContract.ProvisionSchemaCommand
        ]),
        "named-pipe surface exposes no credential enrollment or connection-test command");
    var inspected = await client.InspectWorkspaceAsync(workspaceRoot);
    Check(
        inspected.ProjectPath == Path.GetFullPath(workspaceRoot)
        && inspected.Branch == "pilot-live",
        "service reports the selected local workspace and actual Git branch");
    Check(
        inspected.Migrations.Count == 1
        && inspected.Migrations[0].Name == "001_fixture.sql"
        && inspected.Migrations[0].Sha256.Length == 64,
        "service inventories and checksums local migration sources");
    Check(
        inspected.Evidence.Count == 3
        && inspected.Lease.Status == "UNAVAILABLE"
        && !inspected.Lease.IsLive,
        "service inventories local evidence without inventing durable lease state");
    Check(
        !inspected.ProjectWasModified
        && before.SequenceEqual(SnapshotFiles(workspaceRoot)),
        "workspace inspection performs no project writes");
    var capabilities = await client.DetectCapabilitiesAsync();
    Check(
        capabilities.Count == 6
        && capabilities.All(capability =>
            capability.DetectionMethod.Contains("not executed", StringComparison.Ordinal)),
        "service capability detection is filename-only and launches no provider tool");
    try
    {
        await client.SendForTestAsync("workspace.write", workspaceRoot);
        throw new InvalidOperationException("Write command was unexpectedly accepted");
    }

    catch (LocalServiceResponseException error)
    {
        Check(
            error.ErrorCode == "read_only_command_rejected",
            "unknown/write commands fail closed at the service boundary");
    }

    var syntheticPathRoot = Path.Combine(workspaceRoot, "synthetic-path");
    Directory.CreateDirectory(syntheticPathRoot);
    File.WriteAllText(Path.Combine(syntheticPathRoot, "codex.CMD"), "@exit /b 99\r\n");
    var syntheticCapabilities = CapabilityDetector.Detect(syntheticPathRoot, ".CMD");
    Check(
        syntheticCapabilities.Single(capability => capability.Id == "codex-cli").Available
        && syntheticCapabilities
            .Where(capability => capability.Id != "codex-cli")
            .All(capability => !capability.Available),
        "capability detection reports filename presence without executing the fixture");
}
finally
{
    pipeCancellation.Cancel();
    await serverTask;
    if (Directory.Exists(workspaceRoot))
    {
        Directory.Delete(workspaceRoot, recursive: true);
    }
}

Console.WriteLine("Helmion local-service smoke tests passed (9 checks).");

var protectedStoreRoot = Path.Combine(
    Path.GetTempPath(),
    $"helmion-provider-profile-smoke-{Guid.NewGuid():N}");
try
{
    var plan = NeonDevelopmentTarget.CreateReadOnlyPlan();
    ConnectionTestContract.ValidatePlan(plan);
    var neonTarget = plan.Target
        ?? throw new InvalidOperationException("Neon plan omitted its exact target");
    Check(
        neonTarget == NeonDevelopmentTarget.CreateBinding()
        && neonTarget.EndpointId == "ep-divine-leaf-ay38p1af"
        && neonTarget.ResourceName == "neondb"
        && neonTarget.Transport == "postgresql-direct"
        && plan.Probes.All(probe => !probe.MutatesExternalState),
        "Neon connection-test plan is exact-target-bound and non-mutating");

    var safeResult = new ConnectionTestResult(
        Version: 1,
        ProfileId: plan.ProfileId,
        AdapterId: plan.AdapterId,
        Status: "not-run",
        Identity: null,
        Target: plan.Target,
        ObservedCapabilities: [],
        Findings:
        [
            new(
                "credential-unavailable",
                "info",
                "No protected material enrolled; no connection attempted")
        ],
        ObservedAt: DateTimeOffset.UnixEpoch,
        MutatedExternalState: false,
        SecretMaterialReturned: false);
    ConnectionTestContract.ValidateResult(plan, safeResult);
    Check(
        safeResult.Status == "not-run"
        && !safeResult.MutatedExternalState
        && !safeResult.SecretMaterialReturned,
        "typed connection-test result exposes only redacted non-mutating state");

    try
    {
        ConnectionTestContract.ValidateResult(
            plan,
            safeResult with { MutatedExternalState = true });
        throw new InvalidOperationException("Mutating connection test was accepted");
    }
    catch (InvalidDataException)
    {
        Check(true, "connection-test contract rejects mutation claims");
    }

    try
    {
        ConnectionTestContract.ValidateResult(
            plan,
            safeResult with
            {
                Target = neonTarget with { EndpointId = "ep-wrong-target" }
            });
        throw new InvalidOperationException("Mismatched target was accepted");
    }
    catch (InvalidDataException)
    {
        Check(true, "connection-test contract rejects target mismatch");
    }

    var store = new ProtectedProviderProfileStore(
        protectedStoreRoot,
        allowTestRoot: true);
    var manifest = BuiltInProviderProfiles.NeonDevelopment(DateTimeOffset.UnixEpoch);
    var fixturePayload = System.Text.Encoding.UTF8.GetBytes(
        "fixture-provider-material-not-a-real-credential");
    try
    {
        var descriptor = await store.SaveAsync(manifest, fixturePayload);
        Check(
            descriptor.Manifest.Target == NeonDevelopmentTarget.CreateBinding()
            && descriptor.Protection == "Windows CurrentUser DPAPI"
            && !descriptor.SecretMaterialReturned,
            "protected store returns only a redacted exact-target descriptor");

        var storedBytes = Directory
            .EnumerateFiles(protectedStoreRoot, "*", SearchOption.AllDirectories)
            .SelectMany(File.ReadAllBytes)
            .ToArray();
        Check(
            !System.Text.Encoding.UTF8.GetString(storedBytes)
                .Contains(
                    "fixture-provider-material-not-a-real-credential",
                    StringComparison.Ordinal),
            "provider material is not persisted as plaintext");

        var unprotected = await store.LoadProtectedMaterialForServiceAsync(
            manifest.Id);
        try
        {
            Check(
                unprotected.SequenceEqual(fixturePayload),
                "current-user DPAPI material round-trips only through the service store");
        }
        finally
        {
            System.Security.Cryptography.CryptographicOperations.ZeroMemory(
                unprotected);
        }

        var loadedDescriptor = await store.ReadDescriptorAsync(manifest.Id);
        Check(
            !loadedDescriptor.SecretMaterialReturned
            && loadedDescriptor.StorageBoundary.Contains(
                "never renderer",
                StringComparison.Ordinal),
            "profile descriptor cannot return protected material to the renderer");
    }
    finally
    {
        System.Security.Cryptography.CryptographicOperations.ZeroMemory(
            fixturePayload);
    }

    try
    {
        await store.SaveAsync(
            manifest with
            {
                Target = manifest.Target! with { EndpointId = "ep-wrong-target" }
            },
            new byte[] { 1, 2, 3 });
        throw new InvalidOperationException("Mismatched Neon manifest was accepted");
    }
    catch (InvalidDataException)
    {
        Check(true, "protected store rejects a retargeted Neon Development profile");
    }

    var desktopProjectText = File.ReadAllText(
        Path.Combine(
            Environment.CurrentDirectory,
            "desktop",
            "Helmion.Desktop",
            "Helmion.Desktop.csproj"));
    Check(
        !desktopProjectText.Contains(
            "Helmion.LocalService.Security",
            StringComparison.Ordinal),
        "desktop renderer has no reference to service-only profile protection");
}
finally
{
    if (Directory.Exists(protectedStoreRoot))
    {
        Directory.Delete(protectedStoreRoot, recursive: true);
    }
}

Console.WriteLine("Helmion protected-profile smoke tests passed (10 checks).");

// ProfileSyncEngine smoke test
var syncResult = ProfileSyncEngine.SyncProfileAsync().GetAwaiter().GetResult();
Check(syncResult.Success, "ProfileSyncEngine succeeds");
Check(syncResult.SyncedItems.Count > 0, "ProfileSyncEngine synced items is non-empty");

var userProfileDir = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
var appDataDir = Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData);

Check(File.Exists(Path.Combine(appDataDir, "Claude", "claude_desktop_config.json")), "Claude desktop config is created");
Check(File.Exists(Path.Combine(userProfileDir, ".claude.json")), "Claude code config is created");
Check(File.Exists(Path.Combine(userProfileDir, ".gemini", "GEMINI.md")), "Gemini rules file is created");
Check(File.Exists(Path.Combine(userProfileDir, ".claude", "HELMION_CLAUDE.md")), "Claude rules file is created");

var envPathLoc = EnvironmentSettingsStore.FindEnvPath();
var projectRootLoc = Path.GetDirectoryName(envPathLoc)!;
Check(File.Exists(Path.Combine(projectRootLoc, ".helmion", "autonomy_rules.json")), "Codex rules file is created/updated");
Check(File.Exists(Path.Combine(projectRootLoc, ".helmion", "hooks", "pretooluse.ps1")), "Codex pretooluse hook script is copied");

Console.WriteLine("Helmion profile sync engine smoke tests passed (6 checks).");
return;

static void Check(bool condition, string description)
{
    if (!condition)
    {
        throw new InvalidOperationException($"Desktop smoke check failed: {description}");
    }
}

static IReadOnlyList<string> SnapshotFiles(string root)
{
    return Directory
        .EnumerateFiles(root, "*", SearchOption.AllDirectories)
        .OrderBy(path => path, StringComparer.Ordinal)
        .Select(path =>
        {
            var file = new FileInfo(path);
            return $"{Path.GetRelativePath(root, path)}|{file.Length}|{file.LastWriteTimeUtc.Ticks}";
        })
        .ToArray();
}
