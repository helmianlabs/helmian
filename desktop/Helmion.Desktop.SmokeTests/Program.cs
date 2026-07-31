using System.Net;
using System.Net.Sockets;
using System.Text;
using Helmion.Desktop.Core;
using Helmion.LocalService.Protocol;
using Helmion.LocalService.Security;

var snapshot = PilotSnapshot.CreateLive(false, null, "", "", "", "Codex");
var settingsRoot = Path.Combine(
    Path.GetTempPath(),
    $"helmion-desktop-settings-smoke-{Guid.NewGuid():N}");

Check(snapshot.ModeLabel == "Personal Pilot", "personal pilot mode is explicit");
Check(snapshot.DataSource == PilotDataSource.Unconfigured, "data source is unconfigured");
Check(snapshot.DataSourceLabel.Contains("disconnected", StringComparison.Ordinal), "disconnected label is visible");
Check(!snapshot.LocalServiceConnected, "local service defaults disconnected");
Check(!snapshot.AdvancedOwnerSigningConfigured, "owner signing defaults unconfigured");
Check(!snapshot.ExternalAuthorityGranted, "unconfigured grants no external authority");
Check(!snapshot.LowRiskLocalWorkEnabled, "bounded local work is disabled when service is disconnected");
Check(snapshot.NavigationItems.SequenceEqual(
    ["Overview", "Workspace", "Console", "Activity", "Evidence", "Approvals", "Integrations", "Release", "Settings"]),
    "all required navigation destinations exist");
Check(snapshot.RecentActivity.Count == 0, "no live activity when unconfigured");
Check(snapshot.Handoffs.Count == 0, "no live handoffs when unconfigured");
Check(snapshot.ApprovalQueue.Count == 0, "no live approvals when unconfigured");
Check(snapshot.OrchestrationEvents.Count == 0, "no live orchestration events when unconfigured");
Check(snapshot.Integrations.All(item => !item.IsLive), "integrations are offline when unconfigured");
var providerProfiles = ProviderProfileCatalog.CreateUnconfigured();
Check(providerProfiles.Count == 11, "provider registry covers all eleven pilot profiles");
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
            ["helmion-green", "ocean-blue", "clean-light", "warm-earth", "solar-yellow", "crimson-red"]),
        "six supported color themes have stable IDs");
    File.WriteAllText(settingsPath, """{"Version":1,"ColorTheme":"unknown"}""");
    Check(
        DesktopSettingsStore.Load(settingsPath).ColorTheme == ColorThemeCatalog.DefaultThemeId,
        "unknown persisted themes fail safely to the Helmion default");

    // --- TEXT SIZE ---------------------------------------------------------
    // Troy could not read the app at all, so the scale is the fix; these pin the
    // two ways the fix could itself become unreadable.

    DesktopSettingsStore.Save(
        DesktopSettings.Default with { TextScale = 1.6 }, settingsPath);
    Check(
        Math.Abs(DesktopSettingsStore.Load(settingsPath).ResolvedTextScale - 1.6) < 0.001,
        "a chosen text size survives a restart");

    // THE ONE THAT MATTERS MOST. A settings file written by a build that predates
    // this feature has no TextScale property at all. If that deserialized to 0.0
    // the shell would scale to nothing and the window would render blank — and a
    // user who cannot see the screen cannot reach the control that would undo it.
    File.WriteAllText(settingsPath, """{"Version":1,"ColorTheme":"ocean-blue"}""");
    Check(
        DesktopSettingsStore.Load(settingsPath).ResolvedTextScale == TextScaleRange.Default,
        "a settings file with no TextScale loads at 100%, never at zero");

    // A hand-edited or corrupt value is clamped rather than obeyed.
    foreach (var absurd in new[] { 0.0, -4.0, 99.0, double.NaN, double.PositiveInfinity, double.NegativeInfinity })
    {
        var resolved = (DesktopSettings.Default with { TextScale = absurd }).ResolvedTextScale;
        Check(
            resolved >= TextScaleRange.Min && resolved <= TextScaleRange.Max,
            $"a text scale of {absurd} is clamped into the readable range, not applied");
    }

    // The ladder terminates at both ends instead of walking off.
    Check(
        TextScaleRange.Larger(TextScaleRange.Max) == TextScaleRange.Max
        && TextScaleRange.Smaller(TextScaleRange.Min) == TextScaleRange.Min,
        "Ctrl+= at the largest size and Ctrl+- at the smallest stay put rather than overshooting");
    Check(
        TextScaleRange.Larger(1.0) > 1.0 && TextScaleRange.Smaller(1.0) < 1.0,
        "each keypress actually changes the size");
    Check(
        TextScaleRange.Describe(1.25) == "125%",
        "the readout states the size as a percentage the user can act on");
}
finally
{
    if (Directory.Exists(settingsRoot))
    {
        Directory.Delete(settingsRoot, recursive: true);
    }
}

Console.WriteLine("Helmion desktop smoke tests passed (34 checks).");

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
    // 2026-07-29: this check used to assert Status == "UNAVAILABLE", which was one of
    // four hardcoded literals WorkspaceInspector returned no matter what was on disk.
    // The literals are gone (WorkspaceInspector.cs:56-63), so the old assertion was
    // pinning a lie in place. The honest posture for a workspace with no lease file is
    // NONE, and asserting that the detail names the path proves the inspector actually
    // looked rather than returning a fresh constant.
    Check(
        inspected.Evidence.Count == 3
        && inspected.Lease.Status == LeaseInspector.StatusNone
        && !inspected.Lease.IsLive
        && inspected.Lease.Detail.Contains(
            LeaseInspector.LeaseFilePath(inspected.ProjectPath),
            StringComparison.Ordinal),
        "service inventories local evidence and reads the real lease state off disk");
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
    // The Pilot may copy LocalService.Security.dll beside the hosted service
    // process, but the WPF renderer must not take a ProjectReference to it.
    var hasSecurityProjectReference =
        desktopProjectText.Contains(
            "Helmion.LocalService.Security.csproj",
            StringComparison.Ordinal)
        || System.Text.RegularExpressions.Regex.IsMatch(
            desktopProjectText,
            @"ProjectReference[^>]*Helmion\.LocalService\.Security",
            System.Text.RegularExpressions.RegexOptions.IgnoreCase);
    Check(
        !hasSecurityProjectReference,
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

// ProfileSyncEngine smoke test.
//
// This runs the REAL sync — every write path, the installer, and the Neon step —
// but against a throwaway user profile and AppData root. Until 2026-07-28 it ran
// against Troy's live machine on every `dotnet run`: it rewrote ~/.claude
// markdown, ~/.claude.json (restoring plaintext API keys that had been moved to
// environment variables), and ~/.gemini/GEMINI.md. A test suite must never be
// able to reach a user's real configuration, so the targets are injected here.
var syncSandbox = Path.Combine(
    Path.GetTempPath(),
    $"helmion-profile-sync-smoke-{Guid.NewGuid():N}");
var sandboxUserProfile = Path.Combine(syncSandbox, "user");
var sandboxAppData = Path.Combine(syncSandbox, "appdata");
Directory.CreateDirectory(sandboxUserProfile);
Directory.CreateDirectory(sandboxAppData);

// Fingerprinted before the sync and re-checked after: if any of these change,
// the sync escaped its sandbox and reached the real user.
var liveUserProfile = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
var liveAppData = Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData);
string[] liveWitnesses =
[
    Path.Combine(liveUserProfile, ".claude.json"),
    Path.Combine(liveUserProfile, ".claude", "BASE_RULES.md"),
    Path.Combine(liveUserProfile, ".claude", "LEARNINGS.md"),
    Path.Combine(liveUserProfile, ".claude", "LESSONS.md"),
    Path.Combine(liveUserProfile, ".claude", "HELMION_CLAUDE.md"),
    Path.Combine(liveUserProfile, ".gemini", "GEMINI.md"),
    Path.Combine(liveAppData, "Claude", "claude_desktop_config.json"),
];
var liveBefore = SnapshotWitnesses(liveWitnesses);

try
{
    var syncResult = ProfileSyncEngine
        .SyncProfileAsync(targets: new ProfileSyncTargets(sandboxUserProfile, sandboxAppData))
        .GetAwaiter().GetResult();
    Check(syncResult.Success, "ProfileSyncEngine succeeds");
    Check(syncResult.SyncedItems.Count > 0, "ProfileSyncEngine synced items is non-empty");

    Check(File.Exists(Path.Combine(sandboxAppData, "Claude", "claude_desktop_config.json")), "Claude desktop config is created");
    Check(File.Exists(Path.Combine(sandboxUserProfile, ".claude.json")), "Claude code config is created");
    Check(File.Exists(Path.Combine(sandboxUserProfile, ".gemini", "GEMINI.md")), "Gemini rules file is created");
    Check(File.Exists(Path.Combine(sandboxUserProfile, ".claude", "HELMION_CLAUDE.md")), "Claude rules file is created");

    // THESE TWO ASSERT AGAINST FILES GIT CAN NEVER HAVE, AND USED TO ABORT THE
    // WHOLE SUITE ON ANY CLEAN CLONE.
    //
    // They resolve the project root through FindEnvPath(), which anchors on
    // `.env` — and .gitignore ignores both `.env` and `.helmion/`. So on a fresh
    // clone or a detached worktree the root resolves elsewhere, the first Check
    // throws, and EVERY suite registered after this line runs ZERO times. It
    // aborted at roughly check 53 of ~900. Measured: `dotnet run` on this
    // project in a detached worktree at HEAD exits 127 here.
    //
    // The damage was not the missing coverage, it was the CLAIM. "Desktop smoke
    // suite green" was written into four separate reports tonight as though it
    // described the committed code; it only ever described one developer's
    // working tree. Two sessions independently conflated "the registration line
    // is committed" with "the check executed".
    //
    // SKIP, NOT WEAKEN. Where the sync's own inputs are present the assertions
    // are unchanged and still fail loudly. Where `.env` was never checked out
    // there is nothing for the sync to have copied, so asserting it copied
    // something is a statement about the machine rather than the code. The skip
    // PRINTS, because a silently-skipped check is how a suite starts lying
    // politely.
    var envPathLoc = EnvironmentSettingsStore.FindEnvPath();
    var projectRootLoc = Path.GetDirectoryName(envPathLoc)!;
    var codexInputsPresent = File.Exists(envPathLoc)
        && Directory.Exists(Path.Combine(projectRootLoc, "hooks"));
    if (codexInputsPresent)
    {
        Check(File.Exists(Path.Combine(projectRootLoc, ".helmion", "autonomy_rules.json")), "Codex rules file is created/updated");
        Check(File.Exists(Path.Combine(projectRootLoc, ".helmion", "hooks", "pretooluse.ps1")), "Codex pretooluse hook script is copied");
    }
    else
    {
        Console.WriteLine(
            "  SKIPPED (2 checks): Codex rules + pretooluse hook — no .env in this checkout, "
            + "so the sync had no project root to copy into. Not a pass.");
    }

    var neonLine = syncResult.SyncedItems.FirstOrDefault(item =>
        item.Contains("Neon autonomy rules", StringComparison.OrdinalIgnoreCase));
    Check(neonLine is not null, "Profile sync reports Neon autonomy rules step (success or skip/warning)");

    Check(
        liveBefore.SequenceEqual(SnapshotWitnesses(liveWitnesses), StringComparer.Ordinal),
        "a sandboxed profile sync leaves every real user config file byte-identical");
}
finally
{
    // The sandbox .claude.json holds the same live API keys the real one would
    // have; it does not outlive the test run.
    try { Directory.Delete(syncSandbox, recursive: true); } catch { /* temp dir */ }
}

Console.WriteLine("Helmion profile sync engine smoke tests passed (8 checks).");

// Dynamic Maestro router + ToolDispatcher + execution toggle
using (var console = new ConsoleSession())
{
    Check(!console.IsExecutionEnabled, "execution defaults OFF (read-only chat)");

    var fixtureSettings = new EnvironmentSettings(
        GeminiApiKey: "gemini-fixture-key",
        DatabaseUrl: "",
        ExpectedEndpointId: "",
        CodexMode: "read-only",
        CodexInstanceId: "smoke",
        GrokApiKey: "xai-fixture-key",
        MaestroCoordinator: "Grok",
        OpenAiApiKey: "openai-fixture-key",
        AnthropicApiKey: "anthropic-fixture-key");

    console.ConfigureMaestro("Grok", fixtureSettings);
    Check(
        ConsoleSession.IsXaiGrokCoordinator(console.ActiveCoordinator)
        && console.ActiveEndpoint == ConsoleSession.XaiGrokChatCompletionsEndpoint
        && console.ActiveEndpoint!.Contains("api.x.ai", StringComparison.Ordinal)
        && !console.ActiveEndpoint.Contains("groq", StringComparison.OrdinalIgnoreCase)
        && console.HasActiveApiKey,
        "Grok Maestro selection points console chat at xAI (not Groq) endpoint + key");

    console.ConfigureMaestro("OpenAI", fixtureSettings);
    Check(
        console.ActiveEndpoint == ConsoleSession.OpenAiChatCompletionsEndpoint
        && console.HasActiveApiKey,
        "OpenAI Maestro selection points console chat at OpenAI endpoint + key");

    console.ConfigureMaestro("Claude", fixtureSettings);
    Check(
        console.ActiveEndpoint == ConsoleSession.AnthropicMessagesEndpoint
        && console.HasActiveApiKey,
        "Claude Maestro selection points console chat at Anthropic endpoint + key");

    console.ConfigureMaestro("Gemini", fixtureSettings);
    Check(
        string.Equals(console.ActiveCoordinator, "Gemini", StringComparison.OrdinalIgnoreCase)
        && console.ActiveEndpoint == ConsoleSession.GeminiStreamEndpointBase
        && console.HasActiveApiKey,
        "Gemini Maestro selection points console chat at Gemini endpoint + key");

    console.ConfigureMaestro("Codex", fixtureSettings);
    Check(
        console.ActiveEndpoint is null && !console.HasActiveApiKey,
        "Codex coordinator has no primary REST chat client");

    // ---- Custom OpenAI-compatible endpoint: resolution + a real streamed round trip ----
    Check(
        CustomChatSession.ResolveChatCompletionsUrl("http://localhost:11434")
            == "http://localhost:11434/v1/chat/completions"
        && CustomChatSession.ResolveChatCompletionsUrl("http://localhost:11434/v1")
            == "http://localhost:11434/v1/chat/completions"
        && CustomChatSession.ResolveChatCompletionsUrl("http://localhost:11434/v1/chat/completions")
            == "http://localhost:11434/v1/chat/completions",
        "custom base URL normalizes to /v1/chat/completions from every shape users paste");

    var stub = StartOpenAiCompatibleStub();
    try
    {
        var stubBase = $"http://127.0.0.1:{stub.Port}/v1";
        var customProfiles = new List<CustomProviderProfile>
        {
            new("stub-llm", stubBase, "stub-secret-key", "stub-model-7b")
        };

        console.ConfigureMaestro("stub-llm", fixtureSettings, customProfiles);
        Check(
            string.Equals(console.ActiveCustomProviderName, "stub-llm", StringComparison.Ordinal)
            && console.ActiveEndpoint == $"{stubBase}/chat/completions"
            && console.HasActiveApiKey,
            "custom coordinator resolves to its own endpoint URL and key");

        // The real console send path — not a mock — against the stub server.
        var streamed = new StringBuilder();
        var enumerator = console.SendChatAsync("hello custom").GetAsyncEnumerator();
        try
        {
            while (enumerator.MoveNextAsync().AsTask().GetAwaiter().GetResult())
            {
                streamed.Append(enumerator.Current);
            }
        }
        finally
        {
            enumerator.DisposeAsync().AsTask().GetAwaiter().GetResult();
        }

        Check(
            streamed.ToString().Contains("Hello from the Helmion stub endpoint", StringComparison.Ordinal),
            "SendChatAsync streams a real completion back from the custom endpoint");
        Check(
            stub.LastRequestBody.Contains("\"model\":\"stub-model-7b\"", StringComparison.Ordinal),
            "custom session sends the configured model id on the wire");
        Check(
            stub.LastRequestHeaders.Contains("Authorization: Bearer stub-secret-key", StringComparison.Ordinal),
            "custom session sends the configured API key as a bearer token");

        var probe = CustomChatSession.ProbeAsync(customProfiles[0]).GetAwaiter().GetResult();
        Check(probe.Ok, "verification probe succeeds against a live OpenAI-compatible endpoint");

        var deadProbe = CustomChatSession
            .ProbeAsync(new CustomProviderProfile("dead", "http://127.0.0.1:1/v1", ""))
            .GetAwaiter()
            .GetResult();
        Check(!deadProbe.Ok, "verification probe fails against an unreachable endpoint");

        // A custom name must never shadow a built-in coordinator.
        console.ConfigureMaestro(
            "OpenAI",
            fixtureSettings,
            [new CustomProviderProfile("OpenAI", stubBase, "x")]);
        Check(
            console.ActiveEndpoint == ConsoleSession.OpenAiChatCompletionsEndpoint
            && console.ActiveCustomProviderName is null,
            "built-in coordinators are never shadowed by a same-named custom provider");

        console.ConfigureMaestro("not-a-provider", fixtureSettings, customProfiles);
        Check(
            console.ActiveEndpoint is null && console.ActiveCustomProviderName is null,
            "an unknown coordinator still resolves to no endpoint");

        // ---- Status honesty: existing in config never means active ----
        var unverifiedRows = ProviderProfileCatalog.CreateUnconfigured(customProfiles);
        var unverified = unverifiedRows.Single(r => r.Name == "stub-llm");
        Check(
            !unverified.IsActivated
            && unverified.SetupState == "Saved · unverified"
            && !unverified.Availability.Contains("active", StringComparison.OrdinalIgnoreCase)
            && !unverified.SetupState.Contains("active", StringComparison.OrdinalIgnoreCase),
            "a saved-but-unprobed custom provider is never labelled active");

        var verifiedRows = ProviderProfileCatalog.CreateUnconfigured(
            customProfiles,
            new HashSet<string>(StringComparer.OrdinalIgnoreCase) { "stub-llm" });
        var verified = verifiedRows.Single(r => r.Name == "stub-llm");
        Check(
            verified.IsActivated && verified.SetupState.Contains("verified", StringComparison.Ordinal),
            "only a verified custom provider is labelled verified");
    }
    finally
    {
        stub.Dispose();
    }

    // Config existence must not be reported as a live connection anywhere on the board.
    var savedOnly = PilotSnapshot.CreateLive(
        serviceConnected: false,
        inspection: null,
        databaseUrl: "postgresql://user:pw@ep-fake.example.com/neondb",
        apiKeys: "gemini-fixture-key",
        grokApiKey: "xai-fixture-key",
        maestroCoordinator: "Gemini");
    foreach (var integration in savedOnly.Integrations)
    {
        Check(
            !integration.IsLive,
            $"integration '{integration.Name}' is not live from saved config alone");
        Check(
            !integration.StatusLabel.Contains("CONNECTED", StringComparison.OrdinalIgnoreCase),
            $"integration '{integration.Name}' does not claim CONNECTED from saved config alone");
    }

    var toolWorkspaceRoot = Path.Combine(
        Path.GetTempPath(),
        $"helmion-tool-dispatcher-smoke-{Guid.NewGuid():N}");
    Directory.CreateDirectory(toolWorkspaceRoot);
    try
    {
        var dispatcher = new ToolDispatcher(console, toolWorkspaceRoot);
        var refused = dispatcher.DispatchCommandLineAsync("LaunchProcess notepad.exe")
            .GetAwaiter()
            .GetResult();
        Check(
            refused.Contains("Execution is OFF", StringComparison.OrdinalIgnoreCase),
            "ToolDispatcher refuses tools when execution is OFF");

        console.IsExecutionEnabled = true;
        Check(console.IsExecutionEnabled, "execution toggle turns ON");

        var writePath = "agent-note.txt";
        var writeResult = dispatcher.WriteWorkspaceFile(writePath, "helmion-smoke");
        Check(
            writeResult.StartsWith("Success:", StringComparison.Ordinal)
            && File.Exists(Path.Combine(toolWorkspaceRoot, writePath)),
            "WriteWorkspaceFile writes inside registered workspace when execution ON");

        var readResult = dispatcher.ReadWorkspaceFile(writePath);
        Check(readResult == "helmion-smoke", "ReadWorkspaceFile returns written content");

        var outside = dispatcher.WriteWorkspaceFile(
            Path.Combine(Path.GetTempPath(), $"helmion-escape-{Guid.NewGuid():N}.txt"),
            "nope");
        Check(
            outside.Contains("outside the registered workspace", StringComparison.OrdinalIgnoreCase),
            "WriteWorkspaceFile rejects paths outside workspace");

        // This used to be LaunchProcess("cmd.exe"), which spawned a REAL, VISIBLE
        // command prompt on Troy's desktop on every single test run and never
        // killed it — they piled up in his face. A test suite is not allowed to
        // put windows on his screen.
        //
        // The contract under test is "returns a structured result", and a path
        // that cannot launch exercises it just as well as one that can, with no
        // process and no window. The launching-succeeds direction is covered
        // below with an explicitly hidden window that is killed immediately.
        var launchMissing = dispatcher.LaunchProcess(
            Path.Combine(toolWorkspaceRoot, "helmion-no-such-binary.exe"));
        Check(
            launchMissing.StartsWith("Error launching", StringComparison.Ordinal),
            "LaunchProcess returns a structured error for a path that cannot start");

        var launched = dispatcher.LaunchProcess("cmd.exe", hidden: true);
        Check(
            launched.StartsWith("Success:", StringComparison.Ordinal),
            "LaunchProcess returns a structured success result when execution ON");

        // Leave nothing running. The old version leaked a cmd.exe per run.
        var launchedPid = ExtractProcessId(launched);
        Check(launchedPid > 0, "LaunchProcess reports the process id it started");
        try
        {
            using var spawned = System.Diagnostics.Process.GetProcessById(launchedPid);
            spawned.Kill(entireProcessTree: true);
            spawned.WaitForExit(5000);
            Check(spawned.HasExited, "the process the test launched is not left running");
        }
        catch (ArgumentException)
        {
            // Already gone on its own. Also acceptable — nothing is left behind.
            Check(true, "the process the test launched is not left running");
        }
    }
    finally
    {
        if (Directory.Exists(toolWorkspaceRoot))
        {
            Directory.Delete(toolWorkspaceRoot, recursive: true);
        }
    }
}

Console.WriteLine("Helmion Maestro router + ToolDispatcher smoke tests passed.");

// WORKSPACE_PATH .env write does not require the loopback service
var workspaceEnvRoot = Path.Combine(
    Path.GetTempPath(),
    $"helmion-workspace-env-smoke-{Guid.NewGuid():N}");
Directory.CreateDirectory(workspaceEnvRoot);
var workspaceEnvFile = Path.Combine(workspaceEnvRoot, ".env");
File.WriteAllText(workspaceEnvFile, "HELMION_CODEX_MODE=read-only\n");
try
{
    var targetWorkspace = Path.Combine(workspaceEnvRoot, "project");
    Directory.CreateDirectory(targetWorkspace);
    EnvironmentSettingsStore.SaveWorkspacePath(targetWorkspace, workspaceEnvFile);
    var loaded = EnvironmentSettingsStore.LoadWorkspacePath(workspaceEnvFile);
    Check(
        string.Equals(
            Path.GetFullPath(loaded ?? string.Empty),
            Path.GetFullPath(targetWorkspace),
            StringComparison.OrdinalIgnoreCase),
        "WORKSPACE_PATH round-trips through .env without local service");
    var envText = File.ReadAllText(workspaceEnvFile);
    Check(
        envText.Contains("WORKSPACE_PATH=", StringComparison.Ordinal)
        && !envText.Contains("password", StringComparison.OrdinalIgnoreCase),
        "WORKSPACE_PATH write only updates workspace keys");
}
finally
{
    if (Directory.Exists(workspaceEnvRoot))
    {
        Directory.Delete(workspaceEnvRoot, recursive: true);
    }
}

Console.WriteLine("Helmion WORKSPACE_PATH env smoke tests passed.");

// Agent tool workspace is the registered workspace, never a provider CLI home.
// Pins the live defect: a turn ran as "[Agent · Grok · full · workspace C:\Users\troyh\.grok]"
// because a CLI config home had been persisted as WORKSPACE_PATH and nothing rejected it.
var workspaceGuardRoot = Path.Combine(
    Path.GetTempPath(),
    $"helmion-workspace-guard-smoke-{Guid.NewGuid():N}");
var registeredProject = Path.Combine(workspaceGuardRoot, "registered-project");
var fallbackRepoRoot = Path.Combine(workspaceGuardRoot, "helmion-repo");
Directory.CreateDirectory(registeredProject);
Directory.CreateDirectory(fallbackRepoRoot);
try
{
    var userProfileRoot = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
    var grokHome = Path.Combine(userProfileRoot, ".grok");
    var claudeHome = Path.Combine(userProfileRoot, ".claude");

    Check(
        EnvironmentSettingsStore.IsProviderHomeDirectory(grokHome)
        && EnvironmentSettingsStore.IsProviderHomeDirectory(claudeHome)
        && EnvironmentSettingsStore.IsProviderHomeDirectory(Path.Combine(userProfileRoot, ".gemini"))
        && EnvironmentSettingsStore.IsProviderHomeDirectory(Path.Combine(userProfileRoot, ".codex"))
        && EnvironmentSettingsStore.IsProviderHomeDirectory(Path.Combine(grokHome, "sessions"))
        && EnvironmentSettingsStore.IsProviderHomeDirectory(userProfileRoot),
        "provider CLI homes and the user profile are recognised as non-workspaces");

    Check(
        !EnvironmentSettingsStore.IsProviderHomeDirectory(registeredProject)
        && !EnvironmentSettingsStore.IsProviderHomeDirectory(@"E:\Helmion")
        && !EnvironmentSettingsStore.IsProviderHomeDirectory(
            Path.Combine(userProfileRoot, "aimforge-main", "artifacts", "dairyforge")),
        "ordinary project folders under the profile are still valid workspaces");

    Check(
        EnvironmentSettingsStore.IsUnsafeWorkspaceRoot(grokHome)
        && EnvironmentSettingsStore.IsUnsafeWorkspaceRoot(@"C:\")
        && !EnvironmentSettingsStore.IsUnsafeWorkspaceRoot(registeredProject),
        "unsafe-workspace check covers CLI homes as well as drive roots");

    // The reported failure, with Grok actually selected as the Maestro coordinator.
    using (var grokConsole = new ConsoleSession())
    {
        var grokSettings = new EnvironmentSettings(
            GeminiApiKey: "gemini-fixture-key",
            DatabaseUrl: "",
            ExpectedEndpointId: "",
            CodexMode: "read-only",
            CodexInstanceId: "smoke",
            GrokApiKey: "xai-fixture-key",
            MaestroCoordinator: "Grok",
            OpenAiApiKey: "openai-fixture-key",
            AnthropicApiKey: "anthropic-fixture-key");
        grokConsole.ConfigureMaestro("Grok", grokSettings);
        Check(
            ConsoleSession.IsXaiGrokCoordinator(grokConsole.ActiveCoordinator),
            "workspace guard runs with Grok genuinely selected as coordinator");

        var withGrokSelected = AgentWorkspaceResolver.Resolve(
            registeredWorkspacePath: registeredProject,
            envWorkspacePath: grokHome,
            lastWorkspacePath: grokHome,
            helmionRoot: fallbackRepoRoot);
        Check(
            string.Equals(withGrokSelected, registeredProject, StringComparison.OrdinalIgnoreCase),
            "turn workspace is the registered workspace while Grok is the coordinator");
        Check(
            !withGrokSelected.Contains(".grok", StringComparison.OrdinalIgnoreCase),
            "turn workspace is never the Grok CLI home");
    }

    // Every stored candidate poisoned: fall back to the repo root, never the CLI home.
    var allPoisoned = AgentWorkspaceResolver.Resolve(
        registeredWorkspacePath: grokHome,
        envWorkspacePath: grokHome,
        lastWorkspacePath: claudeHome,
        helmionRoot: fallbackRepoRoot);
    Check(
        string.Equals(allPoisoned, fallbackRepoRoot, StringComparison.OrdinalIgnoreCase),
        "a poisoned .env and settings fall back to the repo root, not a CLI home");

    // Provider choice must not move the workspace at all.
    var perProvider = new[] { "OpenAI", "Claude", "Gemini", "Grok" }
        .Select(_ => AgentWorkspaceResolver.Resolve(
            registeredProject,
            grokHome,
            claudeHome,
            fallbackRepoRoot))
        .Distinct(StringComparer.OrdinalIgnoreCase)
        .ToArray();
    Check(
        perProvider.Length == 1
        && string.Equals(perProvider[0], registeredProject, StringComparison.OrdinalIgnoreCase),
        "workspace is identical for OpenAI, Claude, Gemini and Grok");

    // A CLI home written into .env is refused on read, so the app can overwrite it.
    var guardEnvFile = Path.Combine(workspaceGuardRoot, ".env");
    File.WriteAllLines(
        guardEnvFile,
        [
            "HELMION_MAESTRO_COORDINATOR=Grok",
            $"WORKSPACE_PATH={grokHome}",
            $"HELMION_WORKSPACE_PATH={grokHome}",
        ]);
    Check(
        EnvironmentSettingsStore.LoadWorkspacePath(guardEnvFile) is null,
        "a CLI home stored in .env WORKSPACE_PATH is rejected on load");

    var refusedHomeWrite = false;
    try
    {
        EnvironmentSettingsStore.SaveWorkspacePath(grokHome, guardEnvFile);
    }
    catch (ArgumentException)
    {
        refusedHomeWrite = true;
    }
    Check(refusedHomeWrite, "a CLI home can never be persisted as WORKSPACE_PATH");

    EnvironmentSettingsStore.SaveWorkspacePath(registeredProject, guardEnvFile);
    Check(
        string.Equals(
            Path.GetFullPath(EnvironmentSettingsStore.LoadWorkspacePath(guardEnvFile) ?? ""),
            Path.GetFullPath(registeredProject),
            StringComparison.OrdinalIgnoreCase),
        "a real project folder still round-trips through .env");
}
finally
{
    if (Directory.Exists(workspaceGuardRoot))
    {
        Directory.Delete(workspaceGuardRoot, recursive: true);
    }
}

Console.WriteLine("Helmion agent workspace guard smoke tests passed (10 checks).");

AskPermissionSmokeChecks.Run();

VoiceSmokeChecks.Run();

VoiceBackendSmokeChecks.Run();

VoiceHostSmokeChecks.Run();

ConversationModeChecks.Run();

ProfileInstallerGuardChecks.Run();

GuardEscalationChecks.Run();

GuardFeedChecks.Run();

LeaseInspectorChecks.Run();

PlusMenuChecks.Run();

ProjectShelfChecks.Run();

ProjectOpenScaffoldChecks.Run();

SessionShelfChecks.Run();

GuardLivenessChecks.Run();

LivingDocumentVaultChecks.Run();

FreshWorkspaceChecks.Run();

OffscreenWindowChecks.Run();

ModelProvenanceLabelChecks.Run();

TopBarChecks.Run();
return;

/// <summary>
/// Minimal OpenAI-compatible endpoint on a loopback TCP port. Raw sockets rather than
/// HttpListener so no URL ACL reservation is needed to run the suite as a normal user.
/// </summary>
static StubEndpoint StartOpenAiCompatibleStub()
{
    var listener = new TcpListener(IPAddress.Loopback, 0);
    listener.Start();
    var stub = new StubEndpoint(listener);
    stub.Run();
    return stub;
}

static void Check(bool condition, string description)
{
    if (!condition)
    {
        throw new InvalidOperationException($"Desktop smoke check failed: {description}");
    }
}

// Pulls the pid out of LaunchProcess's "Success: Launched 'x' (Process ID: 123)"
// so the test can kill what it started. Returns 0 when there is no id to find.
static int ExtractProcessId(string result)
{
    var match = System.Text.RegularExpressions.Regex.Match(result, @"Process ID:\s*(\d+)");
    return match.Success && int.TryParse(match.Groups[1].Value, out var pid) ? pid : 0;
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

/// <summary>
/// Fingerprints an exact list of files by content hash, so a test can prove it left
/// the user's real configuration untouched. Absent files are recorded as absent, so
/// a file appearing where there was none also fails the comparison.
/// </summary>
static IReadOnlyList<string> SnapshotWitnesses(IReadOnlyList<string> paths)
{
    return paths
        .Select(path =>
        {
            if (!File.Exists(path))
            {
                return $"{path}|absent";
            }

            var hash = Convert.ToHexString(
                System.Security.Cryptography.SHA256.HashData(File.ReadAllBytes(path)));
            return $"{path}|{hash}";
        })
        .ToArray();
}

sealed class StubEndpoint : IDisposable
{
    public const string ReplyText = "Hello from the Helmion stub endpoint.";

    private readonly TcpListener _listener;
    private readonly CancellationTokenSource _cts = new();

    public StubEndpoint(TcpListener listener) => _listener = listener;

    public int Port => ((IPEndPoint)_listener.LocalEndpoint).Port;

    /// <summary>Raw request head of the most recent call (headers only).</summary>
    public string LastRequestHeaders { get; private set; } = "";

    /// <summary>Raw request body of the most recent call.</summary>
    public string LastRequestBody { get; private set; } = "";

    public void Run() => _ = Task.Run(AcceptLoopAsync);

    private async Task AcceptLoopAsync()
    {
        while (!_cts.IsCancellationRequested)
        {
            TcpClient client;
            try
            {
                client = await _listener.AcceptTcpClientAsync(_cts.Token);
            }
            catch
            {
                return;
            }

            try
            {
                await HandleAsync(client);
            }
            catch
            {
                // A dropped connection must not take the suite down.
            }
            finally
            {
                client.Dispose();
            }
        }
    }

    private async Task HandleAsync(TcpClient client)
    {
        var stream = client.GetStream();
        var buffer = new byte[16384];
        var total = 0;
        string head = "";
        var headerEnd = -1;
        var contentLength = 0;

        // Read the head, then the body. HttpClient sends JsonContent chunked (no
        // Content-Length), so both framings have to terminate this loop.
        while (total < buffer.Length)
        {
            var read = await stream.ReadAsync(buffer.AsMemory(total), _cts.Token);
            if (read == 0) break;
            total += read;
            var text = Encoding.UTF8.GetString(buffer, 0, total);
            headerEnd = text.IndexOf("\r\n\r\n", StringComparison.Ordinal);
            if (headerEnd < 0) continue;

            head = text[..headerEnd];
            contentLength = ParseContentLength(head);
            var bodySoFar = text[(headerEnd + 4)..];
            if (contentLength > 0)
            {
                if (bodySoFar.Length >= contentLength) break;
            }
            else if (bodySoFar.EndsWith("0\r\n\r\n", StringComparison.Ordinal))
            {
                break;
            }
        }

        if (headerEnd < 0) return;

        var full = Encoding.UTF8.GetString(buffer, 0, total);
        LastRequestHeaders = head;
        LastRequestBody = contentLength > 0
            ? full[(headerEnd + 4)..]
            : Dechunk(full[(headerEnd + 4)..]);

        var streaming = LastRequestBody.Contains("\"stream\":true", StringComparison.Ordinal);
        var body = streaming ? BuildSseBody() : BuildJsonBody();
        var payload = Encoding.UTF8.GetBytes(body);
        var header = Encoding.UTF8.GetBytes(
            "HTTP/1.1 200 OK\r\n"
            + $"Content-Type: {(streaming ? "text/event-stream" : "application/json")}\r\n"
            + $"Content-Length: {payload.Length}\r\n"
            + "Connection: close\r\n\r\n");

        await stream.WriteAsync(header, _cts.Token);
        await stream.WriteAsync(payload, _cts.Token);
        await stream.FlushAsync(_cts.Token);
    }

    private static int ParseContentLength(string head)
    {
        foreach (var line in head.Split("\r\n"))
        {
            if (!line.StartsWith("Content-Length:", StringComparison.OrdinalIgnoreCase)) continue;
            return int.TryParse(line["Content-Length:".Length..].Trim(), out var value) ? value : 0;
        }

        return 0;
    }

    /// <summary>Strip HTTP chunked-transfer framing so assertions see the raw JSON.</summary>
    private static string Dechunk(string raw)
    {
        var result = new StringBuilder();
        var index = 0;
        while (index < raw.Length)
        {
            var lineEnd = raw.IndexOf("\r\n", index, StringComparison.Ordinal);
            if (lineEnd < 0) break;

            var sizeToken = raw[index..lineEnd].Split(';')[0].Trim();
            if (!int.TryParse(
                    sizeToken,
                    System.Globalization.NumberStyles.HexNumber,
                    System.Globalization.CultureInfo.InvariantCulture,
                    out var size)
                || size == 0)
            {
                break;
            }

            var start = lineEnd + 2;
            if (start + size > raw.Length) break;
            result.Append(raw, start, size);
            index = start + size + 2;
        }

        return result.Length > 0 ? result.ToString() : raw;
    }

    private static string BuildSseBody()
    {
        var sse = new StringBuilder();
        foreach (var word in ReplyText.Split(' '))
        {
            sse.Append("data: {\"choices\":[{\"delta\":{\"content\":\"")
                .Append(word)
                .Append(" \"}}]}\n\n");
        }

        return sse.Append("data: [DONE]\n\n").ToString();
    }

    private static string BuildJsonBody() =>
        "{\"id\":\"chatcmpl-stub\",\"object\":\"chat.completion\",\"choices\":"
        + "[{\"index\":0,\"message\":{\"role\":\"assistant\",\"content\":\""
        + ReplyText
        + "\"},\"finish_reason\":\"stop\"}]}";

    public void Dispose()
    {
        _cts.Cancel();
        try { _listener.Stop(); } catch { /* already stopped */ }
        _cts.Dispose();
    }
}
