using System.Text;
using Helmion.Desktop.Core;

internal static class ProjectArtifactChecks
{
    public static void Run()
    {
        var root = Path.Combine(Path.GetTempPath(), $"helmian-artifacts-{Guid.NewGuid():N}");
        Directory.CreateDirectory(root);

        try
        {
            var empty = ProjectArtifactStore.Discover(root);
            Check(empty.Count == 0, "an untouched project has an honest empty artifact history");
            Check(!Directory.Exists(Path.Combine(root, ".helmion")),
                "reading artifact history creates no project directories");

            var directory = ProjectArtifactStore.ArtifactDirectory(root);
            Directory.CreateDirectory(directory);
            var notePath = Path.Combine(directory, "decision.md");
            var imagePath = Path.Combine(directory, "preview.png");
            var pdfPath = Path.Combine(directory, "brief.pdf");
            var executablePath = Path.Combine(directory, "never-preview.exe");

            File.WriteAllText(notePath, "Approved demo note.", Encoding.UTF8);
            File.WriteAllBytes(imagePath, Convert.FromBase64String(
                "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="));
            File.WriteAllBytes(pdfPath, "%PDF-1.4\nfixture"u8.ToArray());
            File.WriteAllText(executablePath, "not executable in the test", Encoding.UTF8);

            var now = DateTime.UtcNow;
            File.SetLastWriteTimeUtc(notePath, now.AddMinutes(-3));
            File.SetLastWriteTimeUtc(imagePath, now.AddMinutes(-2));
            File.SetLastWriteTimeUtc(pdfPath, now.AddMinutes(-1));

            var artifacts = ProjectArtifactStore.Discover(root);
            Check(artifacts.Count == 3,
                "artifact discovery includes supported outputs and ignores executable content");
            Check(artifacts.Select(item => item.Name)
                    .SequenceEqual(["brief.pdf", "preview.png", "decision.md"]),
                "artifact history is newest-first");

            var note = artifacts.Single(item => item.Name == "decision.md");
            Check(note.PreviewKind == "text" && note.TextPreview == "Approved demo note.",
                "text artifacts receive a read-only text preview");
            Check(note.RelativePath == ".helmion/artifacts/decision.md",
                "artifact paths remain project-relative");

            var image = artifacts.Single(item => item.Name == "preview.png");
            Check(image.Kind == "Image" && image.PreviewKind == "image",
                "supported image artifacts are marked for in-app rendering");
            Check(image.Sha256.Length == 64,
                "every discovered artifact carries a SHA-256 evidence hash");

            var pdf = artifacts.Single(item => item.Name == "brief.pdf");
            Check(pdf.Kind == "PDF" && pdf.PreviewKind == "metadata" && pdf.TextPreview is null,
                "PDF preview is truthfully metadata-only and never executes the file");

            var longPath = Path.Combine(directory, "long.txt");
            File.WriteAllText(longPath, new string('x', ProjectArtifactStore.MaxTextPreviewChars + 10));
            var longArtifact = ProjectArtifactStore.Discover(root)
                .Single(item => item.Name == "long.txt");
            Check(longArtifact.TextPreview?.EndsWith("[Preview truncated]", StringComparison.Ordinal) == true,
                "large text previews are bounded and visibly marked as truncated");

            Check(ProjectArtifactStore.ArtifactDirectory(root).StartsWith(
                    Path.GetFullPath(root) + Path.DirectorySeparatorChar,
                    StringComparison.OrdinalIgnoreCase),
                "the artifact directory is confined beneath the selected project");
        }
        finally
        {
            Directory.Delete(root, recursive: true);
        }

        Console.WriteLine("Helmion project artifact Preview checks passed (11 checks).");
    }

    private static void Check(bool condition, string message)
    {
        if (!condition) throw new InvalidOperationException($"Project artifact check failed: {message}");
        Console.WriteLine($"PASS: {message}");
    }
}
