using System.Reflection;
using System.Text;
using Helmion.Desktop.Core;

internal static class ProjectActivityReviewChecks
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
                    $"Project activity/review check failed: {description}");
            }
        }

        var rootA = Path.Combine(Path.GetTempPath(), $"helmian-review-a-{Guid.NewGuid():N}");
        var rootB = Path.Combine(Path.GetTempPath(), $"helmian-review-b-{Guid.NewGuid():N}");
        var legacyRoot = Path.Combine(Path.GetTempPath(), $"helmian-review-legacy-{Guid.NewGuid():N}");
        Directory.CreateDirectory(rootA);
        Directory.CreateDirectory(rootB);
        Directory.CreateDirectory(legacyRoot);
        try
        {
            Check(ProjectActivityCenter.Load(rootA).TotalCount == 0
                  && ProjectReviewQueue.Load(rootA).TotalCount == 0,
                "untouched projects have no manufactured activity or review rows");
            Check(!Directory.Exists(Path.Combine(rootA, ".helmion")),
                "reading activity and review projections creates no project state");

            var at = new DateTimeOffset(2026, 8, 1, 12, 0, 0, TimeSpan.Zero);
            ProjectWorkbenchStore.SaveCanvas(rootA, "Local planning note.", at);
            ProjectWorkbenchStore.RecordDecision(
                rootA,
                "Needle decision: keep provider delivery disabled.",
                at.AddMinutes(1));
            ProjectWorkbenchStore.RecordBrowserReference(
                rootA,
                "https://example.com/reference",
                "Reference",
                42,
                new string('A', 64),
                at.AddMinutes(2));
            var draft = ConnectorActionDraftStore.Create(
                rootA,
                ProjectConnectorCatalog.SlackId,
                "slack.post_message",
                "workspace / #review",
                "Review this locally. Do not send.",
                at.AddMinutes(3));
            var pendingArtifact = ArtifactStudioWorkflow.CreateRequest(
                rootA,
                "openai-images",
                ArtifactStudioKinds.Image,
                "Pending illustration",
                "Prepare an illustration request.",
                "Prompt text only.",
                "pending.png",
                at.AddMinutes(4));
            var decidedArtifact = ArtifactStudioWorkflow.CreateRequest(
                rootA,
                "openai-images",
                ArtifactStudioKinds.Image,
                "Denied illustration",
                "Prepare a second illustration request.",
                "Prompt text only.",
                "denied.png",
                at.AddMinutes(5));
            var denied = ProjectReviewQueue.DecideArtifact(
                rootA,
                decidedArtifact.Id,
                approve: false,
                at.AddMinutes(6));
            ProjectWorkbenchStore.RecordApproval(
                rootA,
                "external-local-fixture",
                "expired",
                "Existing typed approval history fixture.",
                "Fixture approval ledger",
                at.AddMinutes(7));

            Check(denied.ApprovalState == ArtifactStudioStates.Denied
                  && denied.DeliveryState == ArtifactStudioStates.NotSent,
                "the unified queue records an artifact denial locally without delivery");
            Check(!Directory.Exists(ProjectArtifactStore.ArtifactDirectory(rootA)),
                "local approval decisions create no artifact output or provider delivery");

            var allActivity = ProjectActivityCenter.Load(rootA);
            Check(allActivity.TotalCount == 9 && allActivity.VisibleCount == 9,
                "the activity projection consumes all recorded project activity kinds");
            Check(ProjectActivityCenter.Load(rootA, "decision").VisibleCount == 1
                  && ProjectActivityCenter.Load(rootA, "connector").VisibleCount == 1
                  && ProjectActivityCenter.Load(rootA, "artifact").VisibleCount == 3
                  && ProjectActivityCenter.Load(rootA, "approval").VisibleCount == 2,
                "activity type filters report exact ledger-derived counts");
            var search = ProjectActivityCenter.Load(rootA, "all", "needle");
            Check(search.VisibleCount == 1
                  && search.Items.Single().KindLabel == "DECISION",
                "activity search matches recorded text without inventing results");
            Check(allActivity.Items.Any(item => item.EvidenceLabel.StartsWith(
                      "SHA-256 · ", StringComparison.Ordinal))
                  && allActivity.Items.Any(item => item.EvidenceLabel == "NO CONTENT HASH RECORDED"),
                "each activity row states whether content-hash evidence exists");

            var review = ProjectReviewQueue.Load(rootA);
            Check(review.ActionableCount == 2
                  && review.ArtifactApprovals.Single().Id == pendingArtifact.Id
                  && review.ConnectorReviews.Single().Id == draft.Draft.Id,
                "the review queue combines the real pending artifact and connector records");
            Check(review.CompletedHistory.Count == 3
                  && review.CompletedHistory.Any(item => item.TypeLabel == "ARTIFACT APPROVAL")
                  && review.CompletedHistory.Count(item => item.TypeLabel == "PROJECT APPROVAL RECORD") == 2,
                "completed artifact and typed approval records remain inspectable");
            Check(ProjectReviewQueue.Load(rootA, "needs-action").TotalCount == 2
                  && ProjectReviewQueue.Load(rootA, "history").ActionableCount == 0
                  && ProjectReviewQueue.Load(rootA, "artifact").TotalCount == 2
                  && ProjectReviewQueue.Load(rootA, "connector").TotalCount == 1,
                "review filters separate actionable, provider-specific, and completed records honestly");

            var reviewed = ProjectReviewQueue.MarkConnectorReviewed(
                rootA,
                draft.Draft.Id,
                at.AddMinutes(8));
            Check(reviewed.Draft.ReviewState == ConnectorActionDraftReviewState.Reviewed
                  && reviewed.Draft.Status == ConnectorActionDraftStatus.Draft
                  && reviewed.Draft.Revision == 2,
                "connector local review is a durable typed revision but keeps the draft active");
            Check(reviewed.Audit.EventType == "draft_reviewed"
                  && reviewed.Audit.Outcome == "local_only_not_approved"
                  && reviewed.Activity.Status == "reviewed-local-only",
                "connector review audit explicitly refuses approval semantics");
            review = ProjectReviewQueue.Load(rootA, "needs-action");
            Check(review.ActionableCount == 1
                  && review.ConnectorReviews.Count == 0
                  && review.ArtifactApprovals.Single().Id == pendingArtifact.Id,
                "marking a connector draft reviewed removes only that local review action");

            var approved = ProjectReviewQueue.DecideArtifact(
                rootA,
                pendingArtifact.Id,
                approve: true,
                at.AddMinutes(9));
            Check(approved.ApprovalState == ArtifactStudioStates.Approved
                  && approved.DeliveryState == ArtifactStudioStates.ConfigurationRequired,
                "local artifact approval stays visibly blocked with no credential or adapter");
            Check(ProjectReviewQueue.Load(rootA, "needs-action").ActionableCount == 0
                  && !Directory.Exists(ProjectArtifactStore.ArtifactDirectory(rootA)),
                "all local actions can complete without crossing the provider boundary");

            var withdrawn = ProjectReviewQueue.WithdrawConnectorDraft(
                rootA,
                draft.Draft.Id,
                at.AddMinutes(10));
            Check(withdrawn.Draft.Status == ConnectorActionDraftStatus.Withdrawn
                  && withdrawn.Draft.ReviewState == ConnectorActionDraftReviewState.Reviewed
                  && withdrawn.Draft.Revision == 3,
                "reviewed connector drafts can still be explicitly withdrawn without erasing history");
            Check(ProjectConnectorStore.ReadAudit(rootA).Any(item => item.EventType == "draft_reviewed")
                  && ProjectConnectorStore.ReadAudit(rootA).Any(item => item.EventType == "draft_withdrawn"),
                "connector review and withdrawal both appear in typed connector audit");

            Check(ProjectActivityCenter.Load(rootB).TotalCount == 0
                  && ProjectReviewQueue.Load(rootB).TotalCount == 0,
                "activity and review state remain isolated from a second project");

            var legacyDirectory = Path.Combine(legacyRoot, ".helmion", "connectors");
            Directory.CreateDirectory(legacyDirectory);
            File.WriteAllText(
                Path.Combine(legacyDirectory, "action-drafts.jsonl"),
                "{\"id\":\"legacy-draft\",\"revision\":1,"
                + "\"createdAtUtc\":\"2026-08-01T12:00:00+00:00\","
                + "\"updatedAtUtc\":\"2026-08-01T12:00:00+00:00\","
                + "\"connectorId\":\"slack\",\"operationId\":\"slack.post_message\","
                + "\"destination\":\"workspace / #legacy\",\"body\":\"Legacy local draft.\","
                + $"\"payloadSha256\":\"{new string('B', 64)}\",\"status\":\"draft\"}}"
                + Environment.NewLine,
                Encoding.UTF8);
            var legacyDraft = ConnectorActionDraftStore.Read(legacyRoot).Single();
            Check(legacyDraft.ReviewState == ConnectorActionDraftReviewState.NeedsReview
                  && ProjectReviewQueue.Load(legacyRoot, "needs-action").ActionableCount == 1,
                "connector ledgers written before reviewState upgrade safely enter local review");

            var activityPath = Path.Combine(rootA, ProjectWorkbenchStore.ActivityRelativePath);
            File.AppendAllText(activityPath, "{partial", Encoding.UTF8);
            Check(ProjectActivityCenter.Load(rootA).TotalCount == 13,
                "a partial activity append does not hide thirteen intact records");

            var repositoryRoot = FindRepositoryRoot();
            Check(repositoryRoot is not null, "desktop UI source is available for wiring checks");
            var mainXaml = File.ReadAllText(Path.Combine(
                repositoryRoot!, "desktop", "Helmion.Desktop", "MainWindow.xaml"));
            var approvalXaml = File.ReadAllText(Path.Combine(
                repositoryRoot!, "desktop", "Helmion.Desktop", "ProjectApprovalsPanel.xaml"));
            var approvalCode = File.ReadAllText(Path.Combine(
                repositoryRoot!, "desktop", "Helmion.Desktop", "ProjectApprovalsPanel.xaml.cs"));
            Check(mainXaml.Contains("<local:ProjectActivityPanel", StringComparison.Ordinal)
                  && mainXaml.Contains("<local:ProjectApprovalsPanel", StringComparison.Ordinal)
                  && !mainXaml.Contains("ItemsSource=\"{Binding OrchestrationEvents}\"", StringComparison.Ordinal)
                  && !mainXaml.Contains("ItemsSource=\"{Binding ApprovalQueue}\"", StringComparison.Ordinal),
                "main navigation mounts real project panels instead of empty snapshot demo lists");
            Check(approvalXaml.Contains("Approve locally", StringComparison.Ordinal)
                  && approvalXaml.Contains("Mark reviewed locally", StringComparison.Ordinal)
                  && approvalXaml.Contains("Local review is not approval", StringComparison.Ordinal),
                "approval UI distinguishes artifact decisions from connector review actions");
            Check(!approvalCode.Contains("DispatchApprovedAsync", StringComparison.Ordinal)
                  && !approvalCode.Contains("HttpClient", StringComparison.Ordinal)
                  && !approvalCode.Contains("IProjectConnectorGateway", StringComparison.Ordinal)
                  && !approvalCode.Contains("CredentialSetting", StringComparison.Ordinal),
                "approval UI has no dispatch, network, gateway, or credential path");
            Check(typeof(ProjectReviewQueue).GetMethods(BindingFlags.Public | BindingFlags.Static)
                    .All(method => !new[] { "dispatch", "send", "generate", "beginAuthorization" }
                        .Any(fragment => method.Name.Contains(fragment, StringComparison.OrdinalIgnoreCase))),
                "the unified project review boundary exposes no provider-operation method");

            Console.WriteLine($"Helmion project activity/review checks passed ({checks} checks; local records only). ");
        }
        finally
        {
            Directory.Delete(rootA, recursive: true);
            Directory.Delete(rootB, recursive: true);
            Directory.Delete(legacyRoot, recursive: true);
        }
    }

    private static string? FindRepositoryRoot()
    {
        foreach (var candidate in new[] { Environment.CurrentDirectory, AppContext.BaseDirectory })
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
