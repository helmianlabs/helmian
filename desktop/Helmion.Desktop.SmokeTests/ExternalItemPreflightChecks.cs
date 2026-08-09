using System.IO.Compression;
using Helmion.Desktop.Core;

internal static class ExternalItemPreflightChecks
{
    public static void Run()
    {
        var verified = Evidence();
        var ready = ExternalItemReviewPolicy.Evaluate(verified);
        Check(ready.Decision == ExternalItemReviewDecision.ReadyToApprove
              && ready.CanRequestApproval,
            "complete evidence with no findings is ready to approve, not automatically installed");

        var missing = ExternalItemReviewPolicy.Evaluate(verified with
        {
            ProvenanceState = ExternalEvidenceState.Missing,
            Provenance = "Unknown",
            Sha256 = null
        });
        Check(missing.Decision == ExternalItemReviewDecision.NeedsReview
              && !missing.CanRequestApproval
              && missing.Unknowns.Count >= 2,
            "missing provenance and hash remain unknown and cannot be approved");

        var blocked = ExternalItemReviewPolicy.Evaluate(verified with
        {
            Findings =
            [
                new ExternalItemFinding(
                    ExternalItemFindingLevel.Block,
                    "Known risk",
                    "Synthetic blocking finding")
            ]
        });
        Check(blocked.Decision == ExternalItemReviewDecision.Block
              && !blocked.CanRequestApproval,
            "a blocking finding wins even when every evidence field is present");

        Check(ExternalItemReviewCoverage.RequiredKinds.Distinct().Count() == 8
              && Enum.GetValues<ExternalItemKind>()
                  .All(kind => ExternalItemReviewCoverage.RequiredKinds.Contains(kind)),
            "the shared contract covers downloads, GitHub, attachments, MCP, plugins, skills, AI integrations, and sandbox configs");
        Check(ExternalItemReviewCoverage.ForPlusMenu(PlusMenuKind.Upload) == ExternalItemKind.Attachment
              && ExternalItemReviewCoverage.ForPlusMenu(PlusMenuKind.Connector) == ExternalItemKind.McpServer
              && ExternalItemReviewCoverage.ForPlusMenu(PlusMenuKind.Plugin) == ExternalItemKind.PluginOrExtension
              && ExternalItemReviewCoverage.ForPlusMenu(PlusMenuKind.Skill) == ExternalItemKind.SkillOrAddon,
            "all four existing plus-menu entry points map to the shared review kinds");

        var root = Path.Combine(Path.GetTempPath(), $"helmian-preflight-{Guid.NewGuid():N}");
        Directory.CreateDirectory(root);
        try
        {
            var textPath = Path.Combine(root, "notes.txt");
            File.WriteAllText(textPath, "review me as text");
            var attachment = new ExternalItemPreflightInspector().ReviewLocalFile(
                textPath,
                ExternalItemKind.Attachment);
            Check(attachment.Decision == ExternalItemReviewDecision.ReadyToApprove
                  && attachment.Evidence.Sha256 is { Length: 64 }
                  && attachment.Evidence.SignatureState == ExternalEvidenceState.NotApplicable,
                "attachment preflight hashes the exact file and applies install-only evidence as not applicable");

            var misleadingPath = Path.Combine(root, "invoice.pdf.exe");
            File.WriteAllText(misleadingPath, "not really an executable; filename rule fixture only");
            var misleading = new ExternalItemPreflightInspector().ReviewLocalFile(
                misleadingPath,
                ExternalItemKind.WebsiteDownload,
                "https://example.test/invoice.pdf.exe");
            Check(misleading.Decision == ExternalItemReviewDecision.Block
                  && misleading.Evidence.Findings.Any(finding =>
                      finding.Category == "Misleading filename"),
                "document-looking double extension is blocked before approval");

            var archivePath = Path.Combine(root, "candidate.zip");
            using (var archive = ZipFile.Open(archivePath, ZipArchiveMode.Create))
            {
                var unsafeEntry = archive.CreateEntry("../escape.txt");
                using var writer = new StreamWriter(unsafeEntry.Open());
                writer.Write("fixture");
            }

            var archiveReview = new ExternalItemPreflightInspector().ReviewLocalFile(
                archivePath,
                ExternalItemKind.PluginOrExtension,
                "https://github.com/example/candidate");
            Check(archiveReview.Decision == ExternalItemReviewDecision.Block
                  && archiveReview.Evidence.Findings.Any(finding =>
                      finding.Category == "Archive path"),
                "archive path traversal is a blocking preflight finding without extraction");

            var manifestPath = Path.Combine(root, "manifest.json");
            File.WriteAllText(
                manifestPath,
                """{"name":"sample","version":"1.0.0","permissions":[],"host_permissions":[]}""");
            var asserted = new ExternalItemPreflightInspector().ReviewLocalFile(
                manifestPath,
                ExternalItemKind.PluginOrExtension,
                "https://github.com/example/sample");
            Check(asserted.Decision == ExternalItemReviewDecision.NeedsReview
                  && asserted.Unknowns.Any(item =>
                      item.Contains("provenance", StringComparison.OrdinalIgnoreCase)),
                "user-supplied repository URL is recorded but remains unverified, never safe by assertion");
        }
        finally
        {
            try { Directory.Delete(root, recursive: true); } catch { /* temp test fixture */ }
        }

        Console.WriteLine("Helmion external-item preflight checks passed (9 checks; nothing installed or executed).");
    }

    private static ExternalItemEvidence Evidence() =>
        new(
            ExternalItemKind.McpServer,
            "sample MCP",
            "MCP server proposed for terminal approval",
            "https://github.com/example/sample",
            ExternalEvidenceState.Verified,
            "Pinned repository and revision verified by the caller fixture.",
            new string('a', 64),
            "local source folder",
            ExternalEvidenceState.NotApplicable,
            "Source review has no binary publisher signature.",
            ExternalEvidenceState.Verified,
            "helmion-candidate.json parsed",
            ExternalEvidenceState.Verified,
            ["network host: api.example.test"],
            []);

    private static void Check(bool condition, string message)
    {
        if (!condition) throw new InvalidOperationException("FAIL: " + message);
    }
}
