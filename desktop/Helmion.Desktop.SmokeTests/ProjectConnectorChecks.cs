using System.Reflection;
using System.Text;
using Helmion.Desktop.Core;

internal static class ProjectConnectorChecks
{
    public static void Run()
    {
        var checks = 0;
        void Check(bool condition, string description)
        {
            checks++;
            if (!condition)
            {
                throw new InvalidOperationException(
                    $"Project connector check failed: {description}");
            }
        }

        Check(ProjectConnectorCatalog.All.Select(item => item.Id).SequenceEqual(["slack", "github"]),
            "the project connector catalog is limited to Slack and GitHub");
        Check(ProjectConnectorCatalog.All.SelectMany(item => item.Capabilities)
                .Where(item => item.Access == ConnectorCapabilityAccess.ExternalWrite)
                .All(item => item.RequiresApproval),
            "every declared external-write capability requires approval");
        Check(ConnectorOperationCatalog.All.All(item => item.IsExternalWrite && item.RequiresApproval),
            "every outbound draft operation is classified as an approval-gated external write");

        var publicConnectorTypes = new[]
        {
            typeof(ProjectConnectorState),
            typeof(ConnectorAuthorizationIntent),
            typeof(ConnectorDispatchIntent),
            typeof(ConnectorAuditEntry),
            typeof(ConnectorActionDraft)
        };
        var forbiddenPropertyNames = new[]
        {
            "token", "secret", "password", "credential", "oauthcode", "refreshtoken", "accesstoken"
        };
        Check(publicConnectorTypes
                .SelectMany(type => type.GetProperties(BindingFlags.Instance | BindingFlags.Public))
                .All(property => !forbiddenPropertyNames.Any(fragment =>
                    property.Name.Contains(fragment, StringComparison.OrdinalIgnoreCase))),
            "connector state and protocol records expose no credential-bearing property");

        var gatewayImplementations = typeof(IProjectConnectorGateway).Assembly.GetTypes()
            .Where(type => type.IsClass
                           && !type.IsAbstract
                           && typeof(IProjectConnectorGateway).IsAssignableFrom(type))
            .ToArray();
        Check(gatewayImplementations.Length == 0,
            "the desktop Core assembly contains no Slack/GitHub gateway implementation");

        var repositoryRoot = FindRepositoryRoot();
        Check(repositoryRoot is not null,
            "connector UI source is available for wiring verification");
        var panelXaml = File.ReadAllText(Path.Combine(
            repositoryRoot!,
            "desktop",
            "Helmion.Desktop",
            "ProjectConnectorsPanel.xaml"));
        var panelCode = File.ReadAllText(Path.Combine(
            repositoryRoot!,
            "desktop",
            "Helmion.Desktop",
            "ProjectConnectorsPanel.xaml.cs"));
        var mainXaml = File.ReadAllText(Path.Combine(
            repositoryRoot!,
            "desktop",
            "Helmion.Desktop",
            "MainWindow.xaml"));
        Check(panelXaml.Contains("LOCAL ONLY", StringComparison.Ordinal)
              && panelXaml.Contains("NOT READY TO SEND", StringComparison.Ordinal) == false
              && panelXaml.Contains("BlockerSummary", StringComparison.Ordinal),
            "connector UI labels the surface local-only and binds explicit readiness blockers");
        Check(panelXaml.Contains("Prepare authorization request", StringComparison.Ordinal) == false
              && !panelXaml.Contains("Content=\"Send", StringComparison.OrdinalIgnoreCase)
              && !panelXaml.Contains("PasswordBox", StringComparison.Ordinal),
            "connector UI has no static connect/send control or credential input");
        Check(!panelCode.Contains("HttpClient", StringComparison.Ordinal)
              && !panelCode.Contains("Process.Start", StringComparison.Ordinal)
              && !panelCode.Contains("ShellExecute", StringComparison.Ordinal),
            "connector UI code has no HTTP, process-launch, or shell path");
        Check(mainXaml.Contains("<local:ProjectConnectorsPanel", StringComparison.Ordinal),
            "the project connector control is reachable from Integrations");

        var rootA = Path.Combine(Path.GetTempPath(), $"helmian-connectors-a-{Guid.NewGuid():N}");
        var rootB = Path.Combine(Path.GetTempPath(), $"helmian-connectors-b-{Guid.NewGuid():N}");
        var damagedRoot = Path.Combine(Path.GetTempPath(), $"helmian-connectors-damaged-{Guid.NewGuid():N}");
        Directory.CreateDirectory(rootA);
        Directory.CreateDirectory(rootB);
        Directory.CreateDirectory(damagedRoot);

        try
        {
            var untouchedViews = ProjectConnectorStore.GetViews(rootA);
            Check(untouchedViews.Count == 2
                  && untouchedViews.All(item => item.ConnectionLabel == "NOT CONNECTED")
                  && untouchedViews.All(item => item.AuthorizationLabel == "NO AUTHORIZATION"),
                "an untouched project reports both connectors honestly disconnected");
            Check(!Directory.Exists(Path.Combine(rootA, ".helmion")),
                "reading connector posture creates no project files");

            var at = new DateTimeOffset(2026, 8, 1, 10, 0, 0, TimeSpan.Zero);
            var slackPrepared = ProjectConnectorStore.PrepareAuthorization(
                rootA,
                ProjectConnectorCatalog.SlackId,
                at);
            Check(slackPrepared.State.Stage == ProjectConnectorStage.AuthorizationPrepared
                  && slackPrepared.State.AuthorizationRequestId?.StartsWith("local-auth-", StringComparison.Ordinal) == true,
                "preparing Slack creates a typed local authorization request");
            Check(slackPrepared.State.ConnectionId is null
                  && slackPrepared.State.ExternalAccountLabel is null,
                "local preparation does not manufacture a connection or account identity");
            Check(slackPrepared.State.RequestedCapabilityIds.Contains("slack.messages.post", StringComparer.Ordinal),
                "the prepared intent explicitly names its future write capability");
            Check(slackPrepared.Audit.EventType == "authorization_prepared"
                  && slackPrepared.Audit.Outcome == "local_only"
                  && slackPrepared.Audit.ProjectActivityId == slackPrepared.Activity.Id,
                "authorization preparation creates linked typed audit and project activity");
            Check(slackPrepared.Activity.Kind == "connector"
                  && slackPrepared.Activity.Status == "prepared"
                  && slackPrepared.Activity.EvidenceHash == slackPrepared.Audit.EvidenceHash,
                "project activity retains connector type, status and evidence hash");

            var statePath = Path.Combine(rootA, ".helmion", "connectors", "state.json");
            var stateJson = File.ReadAllText(statePath, Encoding.UTF8);
            Check(!forbiddenPropertyNames.Any(fragment =>
                    stateJson.Contains(fragment, StringComparison.OrdinalIgnoreCase)),
                "persisted project connector state contains no credential field");
            Check(!stateJson.Contains(rootA, StringComparison.OrdinalIgnoreCase),
                "project connector state does not duplicate the absolute project path");

            var preparedView = ProjectConnectorStore.GetViews(rootA)
                .Single(item => item.Id == ProjectConnectorCatalog.SlackId);
            Check(preparedView.ConnectionLabel == "NOT CONNECTED"
                  && preparedView.AuthorizationLabel == "LOCAL REQUEST PREPARED"
                  && preparedView.PrimaryActionLabel == "Cancel local request",
                "the UI view never calls local intent a connection or authorization");

            var authorizationIntent = ConnectorProtocolPolicy.CreateAuthorizationIntent(
                rootA,
                slackPrepared.State);
            Check(authorizationIntent.RequestId == slackPrepared.State.AuthorizationRequestId
                  && authorizationIntent.ProjectEvidenceHash.Length == 64
                  && !authorizationIntent.ProjectEvidenceHash.Contains(rootA, StringComparison.OrdinalIgnoreCase),
                "the future gateway intent uses a project hash rather than exposing its path");

            var githubPrepared = ProjectConnectorStore.PrepareAuthorization(
                rootA,
                ProjectConnectorCatalog.GitHubId,
                at.AddMinutes(1));
            Check(githubPrepared.State.RequestedCapabilityIds.Contains("github.issues.write", StringComparer.Ordinal),
                "GitHub intent explicitly names its approval-gated issue capability");
            Check(ProjectConnectorStore.LoadStates(rootB)
                    .All(item => item.Stage == ProjectConnectorStage.NotConfigured),
                "connector state is isolated from a different project");
            Check(!Directory.Exists(Path.Combine(rootB, ".helmion")),
                "reading the second project still creates nothing");

            var slackDraft = ConnectorActionDraftStore.Create(
                rootA,
                ProjectConnectorCatalog.SlackId,
                "slack.post_message",
                "workspace-name / #release",
                "Draft release note. Do not send.",
                at.AddMinutes(2));
            Check(slackDraft.Draft.Status == ConnectorActionDraftStatus.Draft
                  && slackDraft.Draft.PayloadSha256.Length == 64,
                "a Slack message becomes a hashed local draft");
            Check(slackDraft.Audit.EventType == "draft_created"
                  && slackDraft.Activity.Status == "draft",
                "draft creation creates typed connector audit and project activity");
            Check(ConnectorActionDraftStore.Read(rootA).Single().Id == slackDraft.Draft.Id,
                "active local drafts round-trip project storage");
            var localReview = ConnectorProtocolPolicy.ReviewLocalDraft(
                slackDraft.Draft,
                slackPrepared.State);
            Check(!localReview.CanDispatch
                  && localReview.ReadinessLabel == "NOT READY TO SEND"
                  && localReview.BlockerSummary.Contains("No real approval", StringComparison.Ordinal),
                "a saved draft visibly reports its missing approval and remains unsendable");
            Check(typeof(ConnectorActionDraftStore).GetMethods(BindingFlags.Public | BindingFlags.Static)
                    .All(method => !new[] { "send", "dispatch", "execute", "approve" }.Any(fragment =>
                        method.Name.Contains(fragment, StringComparison.OrdinalIgnoreCase))),
                "the local draft store exposes no send, dispatch, execute, or approve method");
            Check(ConnectorActionDraftStore.Read(rootB).Count == 0,
                "Slack draft content does not leak into another project");

            var draftPath = Path.Combine(rootA, ".helmion", "connectors", "action-drafts.jsonl");
            var draftJson = File.ReadAllText(draftPath, Encoding.UTF8);
            Check(draftJson.Contains("Draft release note. Do not send.", StringComparison.Ordinal)
                  && !draftJson.Contains("approvalId", StringComparison.OrdinalIgnoreCase)
                  && !draftJson.Contains("connectionId", StringComparison.OrdinalIgnoreCase),
                "a local draft stores review content but no fake approval or connection");

            var disconnectedDispatch = ConnectorProtocolPolicy.ValidateDispatch(
                slackDraft.Draft,
                verifiedSession: null,
                projectEvidenceHash: ConnectorProtocolPolicy.CreateProjectEvidenceHash(rootA),
                approvalId: null,
                idempotencyKey: null,
                at.AddMinutes(2));
            Check(!disconnectedDispatch.Allowed
                  && disconnectedDispatch.Message.Contains("attestation", StringComparison.OrdinalIgnoreCase),
                "a prepared local authorization request cannot dispatch a draft");

            Check(typeof(ConnectorProtocolPolicy).GetMethods(BindingFlags.Public | BindingFlags.Static)
                    .Where(method => method.Name is nameof(ConnectorProtocolPolicy.ValidateDispatch)
                        or nameof(ConnectorProtocolPolicy.CreateDispatchIntent))
                    .SelectMany(method => method.GetParameters())
                    .All(parameter => parameter.ParameterType != typeof(ProjectConnectorState)),
                "editable project connector state is not accepted as dispatch authority");

            var projectEvidenceHash = ConnectorProtocolPolicy.CreateProjectEvidenceHash(rootA);
            var verifiedSession = new VerifiedConnectorSession(
                ProjectConnectorCatalog.SlackId,
                "verified-connection-fixture",
                projectEvidenceHash,
                slackPrepared.State.RequestedCapabilityIds,
                at.AddMinutes(2),
                new string('A', 64));
            Check(!ConnectorProtocolPolicy.ValidateDispatch(
                    slackDraft.Draft,
                    verifiedSession,
                    projectEvidenceHash,
                    approvalId: null,
                    idempotencyKey: "idem-fixture",
                    at.AddMinutes(2)).Allowed,
                "even a verified-connection fixture cannot dispatch an external write without approval");
            Check(!ConnectorProtocolPolicy.ValidateDispatch(
                    slackDraft.Draft,
                    verifiedSession,
                    projectEvidenceHash,
                    approvalId: "approval-fixture",
                    idempotencyKey: null,
                    at.AddMinutes(2)).Allowed,
                "even an approved fixture cannot dispatch without idempotency protection");
            Check(!ConnectorProtocolPolicy.ValidateDispatch(
                    slackDraft.Draft,
                    verifiedSession with { VerifiedAtUtc = at.AddHours(-1) },
                    projectEvidenceHash,
                    approvalId: "approval-fixture",
                    idempotencyKey: "idem-fixture",
                    at.AddMinutes(2)).Allowed,
                "a stale service attestation cannot authorize dispatch");
            var completeFixture = ConnectorProtocolPolicy.ValidateDispatch(
                slackDraft.Draft,
                verifiedSession,
                projectEvidenceHash,
                "approval-fixture",
                "idem-fixture",
                at.AddMinutes(2));
            Check(completeFixture.Allowed,
                "the future boundary accepts only the complete verified and approved contract");
            var dispatchIntent = ConnectorProtocolPolicy.CreateDispatchIntent(
                slackDraft.Draft,
                verifiedSession,
                projectEvidenceHash,
                "approval-fixture",
                "idem-fixture",
                at.AddMinutes(2));
            Check(dispatchIntent.PayloadSha256 == slackDraft.Draft.PayloadSha256
                  && dispatchIntent.ConnectionAttestationHash == verifiedSession.AttestationEvidenceHash
                  && typeof(ConnectorDispatchIntent).GetProperty("Body") is null,
                "dispatch intent carries payload and connection evidence rather than raw draft content");

            Check(!ConnectorProtocolPolicy.ValidateDraftFields(
                    ProjectConnectorCatalog.SlackId,
                    "github.create_issue",
                    "owner/repo",
                    "body").Allowed,
                "a GitHub operation cannot be smuggled through the Slack connector");
            Check(!ConnectorProtocolPolicy.ValidateDraftFields(
                    ProjectConnectorCatalog.GitHubId,
                    "github.create_issue",
                    " ",
                    "body").Allowed,
                "a blank destination is refused");
            Check(!ConnectorProtocolPolicy.ValidateDraftFields(
                    ProjectConnectorCatalog.GitHubId,
                    "github.create_issue",
                    "owner/repo",
                    new string('x', ConnectorProtocolPolicy.MaxDraftBodyCharacters + 1)).Allowed,
                "an oversized outbound draft is refused");

            var githubDraft = ConnectorActionDraftStore.Create(
                rootA,
                ProjectConnectorCatalog.GitHubId,
                "github.create_issue",
                "owner/repository",
                "Issue title\n\nIssue body for later review.",
                at.AddMinutes(3));
            Check(ConnectorActionDraftStore.Read(rootA).Count == 2
                  && githubDraft.Draft.ConnectorLabel == "GitHub",
                "Slack and GitHub drafts coexist in the selected project");

            var withdrawn = ConnectorActionDraftStore.Withdraw(
                rootA,
                slackDraft.Draft.Id,
                at.AddMinutes(4));
            Check(withdrawn.Draft.Status == ConnectorActionDraftStatus.Withdrawn
                  && withdrawn.Draft.Revision == 2,
                "withdrawing appends a new typed revision instead of erasing history");
            Check(ConnectorActionDraftStore.Read(rootA).Count == 1
                  && ConnectorActionDraftStore.Read(rootA, includeWithdrawn: true).Count == 2,
                "active draft view hides withdrawn drafts while history retains them");

            var slackCancelled = ProjectConnectorStore.CancelPreparedAuthorization(
                rootA,
                ProjectConnectorCatalog.SlackId,
                at.AddMinutes(5));
            Check(slackCancelled.State.Stage == ProjectConnectorStage.NotConfigured
                  && slackCancelled.State.ConnectionId is null,
                "cancelling local Slack intent returns to an honest disconnected state");
            Check(ProjectConnectorStore.ReadAudit(rootA).Count == 6,
                "authorization and draft mutations produce six typed audit records");
            Check(ProjectWorkbenchStore.ReadActivity(rootA).Count == 6,
                "the same six mutations are visible in project activity");

            var auditPath = Path.Combine(rootA, ".helmion", "audit", "connectors.jsonl");
            File.AppendAllText(auditPath, "{partial", Encoding.UTF8);
            Check(ProjectConnectorStore.ReadAudit(rootA).Count == 6,
                "one partial audit append does not hide valid connector evidence");
            Check(ProjectConnectorStore.ReadAudit(rootA, limit: 2).Count == 2,
                "connector audit reads honor their explicit limit");

            var damagedDirectory = Path.Combine(damagedRoot, ".helmion", "connectors");
            Directory.CreateDirectory(damagedDirectory);
            File.WriteAllText(Path.Combine(damagedDirectory, "state.json"), "{damaged", Encoding.UTF8);
            var damagedFailedLoud = false;
            try
            {
                ProjectConnectorStore.LoadStates(damagedRoot);
            }
            catch (InvalidDataException)
            {
                damagedFailedLoud = true;
            }
            Check(damagedFailedLoud,
                "damaged connector state fails loud instead of becoming a false disconnected all-clear");
        }
        finally
        {
            Directory.Delete(rootA, recursive: true);
            Directory.Delete(rootB, recursive: true);
            Directory.Delete(damagedRoot, recursive: true);
        }

        Console.WriteLine($"Helmion project connector checks passed ({checks} checks).");
    }

    private static string? FindRepositoryRoot()
    {
        var candidates = new[]
        {
            Environment.CurrentDirectory,
            AppContext.BaseDirectory
        };
        foreach (var candidate in candidates)
        {
            var directory = new DirectoryInfo(candidate);
            while (directory is not null)
            {
                if (File.Exists(Path.Combine(directory.FullName, "package.json"))
                    && Directory.Exists(Path.Combine(directory.FullName, "desktop", "Helmion.Desktop")))
                {
                    return directory.FullName;
                }

                directory = directory.Parent;
            }
        }

        return null;
    }
}
