using System.Text;
using System.Text.Json;
using Helmion.Desktop.Core;
using Helmion.LocalService.Protocol;

internal static class ArtifactStudioWorkflowChecks
{
    public static void Run()
    {
        var root = Path.Combine(Path.GetTempPath(), $"helmian-artifact-studio-{Guid.NewGuid():N}");
        Directory.CreateDirectory(root);
        try
        {
            Check(ArtifactStudioWorkflow.ReadHistory(root).Count == 0,
                "an untouched project has no Artifact Studio requests");
            Check(!Directory.Exists(Path.Combine(root, ".helmion")),
                "reading Artifact Studio history creates no project state");

            var planned = ArtifactStudioIntentPlanner.Plan(
                "Create a restrained Midnight logo for the launch page.",
                ArtifactStudioIntentPlanner.AutoKind,
                new DateTimeOffset(2026, 8, 1, 7, 30, 0, TimeSpan.Zero));
            Check(planned.Kind == ArtifactStudioKinds.DesignAsset
                  && planned.ProviderId == "openai-images"
                  && planned.ProviderSupportsKind,
                "one plain description selects the typed provider route and output kind behind the scenes");
            Check(planned.Title == "Create a restrained Midnight logo for the launch"
                  && planned.DestinationFileName.StartsWith("20260801-073000-", StringComparison.Ordinal)
                  && planned.DestinationFileName.EndsWith(".png", StringComparison.Ordinal),
                "title and collision-resistant project destination are generated automatically");
            Check(planned.DataScope == ArtifactStudioIntentPlanner.PromptOnlyDataScope
                  && planned.DataScope.Contains("no project files", StringComparison.OrdinalIgnoreCase),
                "the hidden data policy remains prompt-only and excludes project content");

            var explicitPdf = ArtifactStudioIntentPlanner.Plan(
                "Create the board update.",
                ArtifactStudioKinds.Pdf,
                new DateTimeOffset(2026, 8, 1, 7, 31, 0, TimeSpan.Zero));
            Check(explicitPdf.Kind == ArtifactStudioKinds.Pdf
                  && explicitPdf.DestinationFileName.EndsWith(".pdf", StringComparison.Ordinal)
                  && !explicitPdf.ProviderSupportsKind,
                "an optional output choice is honored while unsupported delivery remains honest");

            var simpleRoot = Path.Combine(root, "simple-request");
            Directory.CreateDirectory(simpleRoot);
            var simpleRequest = ArtifactStudioIntentPlanner.CreateRequest(
                simpleRoot,
                "Create a clean product screenshot illustration.",
                ArtifactStudioKinds.Image,
                new DateTimeOffset(2026, 8, 1, 7, 32, 0, TimeSpan.Zero));
            Check(simpleRequest.ApprovalState == ArtifactStudioStates.WaitingApproval
                  && simpleRequest.Instructions == "Create a clean product screenshot illustration."
                  && simpleRequest.DataScope == ArtifactStudioIntentPlanner.PromptOnlyDataScope,
                "the one-prompt workflow creates the same governed approval record without exposing paperwork fields");
            Check(!Directory.Exists(ProjectArtifactStore.ArtifactDirectory(simpleRoot)),
                "the simplified request still creates no output before approval and dispatch");

            var request = ArtifactStudioWorkflow.CreateRequest(
                root,
                "openai-images",
                ArtifactStudioKinds.Image,
                "Launch image",
                "Create a restrained Midnight product image.",
                "Prompt text only; no project files or credentials.",
                "launch.png",
                new DateTimeOffset(2026, 8, 1, 8, 0, 0, TimeSpan.Zero));

            Check(request.ApprovalState == ArtifactStudioStates.WaitingApproval
                  && request.DeliveryState == ArtifactStudioStates.NotSent,
                "a prepared request waits for explicit approval and sends nothing");
            Check(request.Destination == ".helmion/artifacts/launch.png",
                "the destination is pinned to the selected project's artifact directory");
            Check(!Directory.Exists(ProjectArtifactStore.ArtifactDirectory(root)),
                "preparing a request does not create an artifact directory or output");

            var blocked = ArtifactStudioWorkflow.Decide(
                root,
                request.Id,
                approve: true,
                new ArtifactStudioProviderReadiness(
                    CredentialConfigured: false,
                    AdapterInstalled: false),
                new DateTimeOffset(2026, 8, 1, 8, 1, 0, TimeSpan.Zero));
            Check(blocked.ApprovalState == ArtifactStudioStates.Approved
                  && blocked.DeliveryState == ArtifactStudioStates.ConfigurationRequired,
                "approval is recorded but missing credentials keep delivery blocked and honest");
            Check(!Directory.Exists(ProjectArtifactStore.ArtifactDirectory(root)),
                "approval alone never sends or creates an artifact");

            var deniedRequest = ArtifactStudioWorkflow.CreateRequest(
                root,
                "openai-images",
                ArtifactStudioKinds.DesignAsset,
                "Badge",
                "Create a small badge.",
                "Prompt text only.",
                "badge.svg");
            var denied = ArtifactStudioWorkflow.Decide(
                root,
                deniedRequest.Id,
                approve: false,
                new ArtifactStudioProviderReadiness(true, true));
            Check(denied.ApprovalState == ArtifactStudioStates.Denied
                  && denied.DeliveryState == ArtifactStudioStates.NotSent,
                "denial is terminal and sends nothing");

            var unsupported = ArtifactStudioWorkflow.CreateRequest(
                root,
                "openai-images",
                ArtifactStudioKinds.Pdf,
                "Brief",
                "Create the approved brief.",
                "Prompt text only.",
                "brief.pdf");
            unsupported = ArtifactStudioWorkflow.Decide(
                root,
                unsupported.Id,
                approve: true,
                new ArtifactStudioProviderReadiness(true, true));
            Check(unsupported.DeliveryState == ArtifactStudioStates.AdapterRequired,
                "an artifact kind without an approved provider adapter cannot become ready");

            var deliverable = ArtifactStudioWorkflow.CreateRequest(
                root,
                "openai-images",
                ArtifactStudioKinds.Image,
                "Approved preview",
                "Create the approved test pixel.",
                "Prompt text only.",
                "approved-preview.png");
            deliverable = ArtifactStudioWorkflow.Decide(
                root,
                deliverable.Id,
                approve: true,
                new ArtifactStudioProviderReadiness(true, true));
            Check(deliverable.DeliveryState == ArtifactStudioStates.Ready,
                "configured adapter readiness is distinct from approval");

            var png = Convert.FromBase64String(
                "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=");
            var adapter = new FixtureAdapter(png);
            var delivered = ArtifactStudioWorkflow.DispatchApprovedAsync(
                    root,
                    deliverable.Id,
                    adapter)
                .GetAwaiter().GetResult();
            Check(adapter.Calls == 1 && delivered.DeliveryState == ArtifactStudioStates.Delivered,
                "an approved request crosses the named provider seam exactly once");
            Check(delivered.ArtifactSha256?.Length == 64,
                "delivered output records a SHA-256 evidence hash");

            var artifacts = ProjectArtifactStore.Discover(root);
            Check(artifacts.Any(item => item.Name == "approved-preview.png"
                                        && item.Sha256 == delivered.ArtifactSha256),
                "provider output is integrated into the selected project's Preview history");

            var idempotent = ArtifactStudioWorkflow.DispatchApprovedAsync(root, deliverable.Id, adapter)
                .GetAwaiter().GetResult();
            Check(idempotent.DeliveryState == ArtifactStudioStates.Delivered && adapter.Calls == 1,
                "a delivered request returns its durable receipt without calling the provider twice");

            var mismatched = ArtifactStudioWorkflow.CreateRequest(
                root,
                "openai-images",
                ArtifactStudioKinds.Image,
                "Mismatched receipt",
                "Reject a provider receipt with the wrong media type.",
                "Prompt text only.",
                "mismatched.png");
            mismatched = ArtifactStudioWorkflow.Decide(
                root,
                mismatched.Id,
                approve: true,
                new ArtifactStudioProviderReadiness(true, true));
            var mismatchedAdapter = new FixtureAdapter(png, "application/octet-stream");
            mismatched = ArtifactStudioWorkflow.DispatchApprovedAsync(root, mismatched.Id, mismatchedAdapter)
                .GetAwaiter().GetResult();
            Check(mismatched.DeliveryState == ArtifactStudioStates.Failed
                  && !File.Exists(Path.Combine(ProjectArtifactStore.ArtifactDirectory(root), "mismatched.png")),
                "a provider receipt with the wrong media type never enters artifact history");

            var history = ArtifactStudioWorkflow.ReadHistory(root, 20);
            Check(history.Count == 5
                  && history.Single(item => item.Id == deliverable.Id).DeliveryState
                    == ArtifactStudioStates.Delivered,
                "append-only transitions collapse into a current project-scoped request history");

            var activity = ProjectWorkbenchStore.ReadActivity(root, 100);
            Check(activity.Any(item => item.Title == "Artifact delivered"
                                       && item.Status == ArtifactStudioStates.Delivered),
                "Artifact Studio lifecycle appears in the project activity feed");
            Check(!activity.Any(item => item.Detail.Contains("Create the approved test pixel", StringComparison.Ordinal)),
                "general activity metadata does not copy generation instructions");

            var unapproved = ArtifactStudioWorkflow.CreateRequest(
                root,
                "openai-images",
                ArtifactStudioKinds.Image,
                "Unapproved",
                "This must never cross the provider seam.",
                "Prompt text only.",
                "unapproved.png");
            var refused = false;
            try
            {
                ArtifactStudioWorkflow.DispatchApprovedAsync(root, unapproved.Id, adapter)
                    .GetAwaiter().GetResult();
            }
            catch (InvalidOperationException)
            {
                refused = true;
            }
            Check(refused && adapter.Calls == 1 && !File.Exists(Path.Combine(
                    ProjectArtifactStore.ArtifactDirectory(root), "unapproved.png")),
                "an unapproved request is denied before provider or disk delivery");

            var tampered = ArtifactStudioWorkflow.CreateRequest(
                root,
                "openai-images",
                ArtifactStudioKinds.Image,
                "Tamper check",
                "Original approved prompt.",
                "Prompt text only.",
                "tamper-check.png");
            tampered = ArtifactStudioWorkflow.Decide(
                root,
                tampered.Id,
                approve: true,
                new ArtifactStudioProviderReadiness(true, true));
            var forged = tampered with { Instructions = "Changed after approval." };
            File.AppendAllText(
                Path.Combine(root, ArtifactStudioWorkflow.RequestHistoryRelativePath),
                JsonSerializer.Serialize(forged, new JsonSerializerOptions
                {
                    PropertyNamingPolicy = JsonNamingPolicy.CamelCase
                }) + Environment.NewLine,
                Encoding.UTF8);
            var tamperRefused = false;
            try
            {
                ArtifactStudioWorkflow.DispatchApprovedAsync(root, tampered.Id, adapter)
                    .GetAwaiter().GetResult();
            }
            catch (InvalidOperationException)
            {
                tamperRefused = true;
            }
            Check(tamperRefused && adapter.Calls == 1,
                "service-side evidence recomputation rejects request edits made after approval");

            Console.WriteLine("Helmion Artifact Studio workflow checks passed (26 checks; no external provider call).");
        }
        finally
        {
            Directory.Delete(root, recursive: true);
        }
    }

    private sealed class FixtureAdapter : IArtifactStudioProviderAdapter
    {
        private readonly byte[] _bytes;
        private readonly string _contentType;

        public FixtureAdapter(byte[] bytes, string contentType = "image/png")
        {
            _bytes = bytes;
            _contentType = contentType;
        }

        public string ProviderId => "openai-images";
        public bool IsConfigured => true;
        public int Calls { get; private set; }
        public bool Supports(string kind) => kind == ArtifactStudioKinds.Image;

        public Task<ArtifactStudioDelivery> GenerateAsync(
            ApprovedArtifactGenerationRequest request,
            CancellationToken cancellationToken)
        {
            cancellationToken.ThrowIfCancellationRequested();
            Calls++;
            return Task.FromResult(new ArtifactStudioDelivery(
                Path.GetFileName(request.Destination),
                _contentType,
                _bytes.ToArray()));
        }
    }

    private static void Check(bool condition, string description)
    {
        if (!condition)
        {
            throw new InvalidOperationException($"Artifact Studio smoke check failed: {description}");
        }
    }
}
