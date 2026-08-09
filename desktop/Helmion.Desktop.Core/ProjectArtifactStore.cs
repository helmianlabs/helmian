using System.Security.Cryptography;
using System.Text;

namespace Helmion.Desktop.Core;

public sealed record ProjectArtifact(
    string Name,
    string FullPath,
    string RelativePath,
    string Kind,
    string PreviewKind,
    long Bytes,
    DateTimeOffset ModifiedAtUtc,
    string Sha256,
    string? TextPreview)
{
    public string SizeLabel => Bytes switch
    {
        < 1024 => $"{Bytes} B",
        < 1024 * 1024 => $"{Bytes / 1024d:F1} KB",
        _ => $"{Bytes / (1024d * 1024d):F1} MB"
    };

    public string ModifiedLabel => ModifiedAtUtc.ToLocalTime().ToString("g");
}

/// <summary>
/// Discovers only outputs already placed in the active project's fixed Helmian
/// artifact directory. Discovery never creates a directory, opens an external
/// application, runs embedded content, or follows links outside the project.
/// </summary>
public static class ProjectArtifactStore
{
    public const string ArtifactRelativeDirectory = ".helmion/artifacts";
    public const int MaxArtifacts = 250;
    public const int MaxTextPreviewChars = 32_000;

    private static readonly HashSet<string> ImageExtensions =
        new(StringComparer.OrdinalIgnoreCase) { ".png", ".jpg", ".jpeg", ".gif", ".bmp" };

    private static readonly HashSet<string> TextExtensions =
        new(StringComparer.OrdinalIgnoreCase)
        {
            ".txt", ".md", ".json", ".csv", ".tsv", ".xml", ".html", ".css", ".svg"
        };

    private static readonly IReadOnlyDictionary<string, string> MetadataKinds =
        new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase)
        {
            [".pdf"] = "PDF",
            [".docx"] = "Document",
            [".xlsx"] = "Spreadsheet",
            [".pptx"] = "Slides"
        };

    public static string ArtifactDirectory(string projectRoot)
    {
        var root = RequireProjectRoot(projectRoot);
        return ResolveInside(root, ArtifactRelativeDirectory);
    }

    public static IReadOnlyList<ProjectArtifact> Discover(string projectRoot)
    {
        var root = RequireProjectRoot(projectRoot);
        var directory = ResolveInside(root, ArtifactRelativeDirectory);
        if (!Directory.Exists(directory)) return [];

        var artifacts = new List<ProjectArtifact>();
        foreach (var path in EnumerateFilesWithoutFollowingLinks(directory))
        {
            if (artifacts.Count >= MaxArtifacts) break;

            var extension = Path.GetExtension(path);
            var previewKind = PreviewKind(extension);
            if (previewKind is null) continue;

            var info = new FileInfo(path);
            if ((info.Attributes & FileAttributes.ReparsePoint) != 0) continue;

            var fullPath = ResolveInside(root, Path.GetRelativePath(root, info.FullName));
            var textPreview = previewKind == "text" ? ReadTextPreview(fullPath) : null;
            artifacts.Add(new ProjectArtifact(
                info.Name,
                fullPath,
                Path.GetRelativePath(root, fullPath).Replace('\\', '/'),
                ArtifactKind(extension),
                previewKind,
                info.Length,
                new DateTimeOffset(info.LastWriteTimeUtc, TimeSpan.Zero),
                HashFile(fullPath),
                textPreview));
        }

        return artifacts
            .OrderByDescending(item => item.ModifiedAtUtc)
            .ThenBy(item => item.RelativePath, StringComparer.OrdinalIgnoreCase)
            .ToArray();
    }

    private static IEnumerable<string> EnumerateFilesWithoutFollowingLinks(string root)
    {
        var pending = new Stack<string>();
        pending.Push(root);

        while (pending.Count > 0)
        {
            var directory = pending.Pop();
            foreach (var file in Directory.EnumerateFiles(directory)) yield return file;

            foreach (var child in Directory.EnumerateDirectories(directory))
            {
                var attributes = File.GetAttributes(child);
                if ((attributes & FileAttributes.ReparsePoint) == 0) pending.Push(child);
            }
        }
    }

    private static string? PreviewKind(string extension)
    {
        if (ImageExtensions.Contains(extension)) return "image";
        if (TextExtensions.Contains(extension)) return "text";
        return MetadataKinds.ContainsKey(extension) ? "metadata" : null;
    }

    private static string ArtifactKind(string extension)
    {
        if (ImageExtensions.Contains(extension)) return "Image";
        if (TextExtensions.Contains(extension)) return extension.Equals(".svg", StringComparison.OrdinalIgnoreCase)
            ? "Design asset"
            : "Text";
        return MetadataKinds.TryGetValue(extension, out var kind) ? kind : "Artifact";
    }

    private static string ReadTextPreview(string path)
    {
        using var stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite);
        using var reader = new StreamReader(
            stream,
            Encoding.UTF8,
            detectEncodingFromByteOrderMarks: true,
            bufferSize: 4096,
            leaveOpen: false);
        var buffer = new char[MaxTextPreviewChars];
        var read = reader.ReadBlock(buffer, 0, buffer.Length);
        var text = new string(buffer, 0, read);
        return reader.Peek() >= 0 ? text + "\n\n[Preview truncated]" : text;
    }

    private static string HashFile(string path)
    {
        using var stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite);
        return Convert.ToHexString(SHA256.HashData(stream));
    }

    private static string RequireProjectRoot(string projectRoot)
    {
        if (string.IsNullOrWhiteSpace(projectRoot))
            throw new ArgumentException("A selected project is required.", nameof(projectRoot));

        var root = Path.GetFullPath(projectRoot.Trim());
        if (!Directory.Exists(root))
            throw new DirectoryNotFoundException($"Project folder does not exist: {root}");
        return root;
    }

    private static string ResolveInside(string root, string relativePath)
    {
        var full = Path.GetFullPath(Path.Combine(root, relativePath));
        var prefix = root.EndsWith(Path.DirectorySeparatorChar)
            ? root
            : root + Path.DirectorySeparatorChar;
        if (!full.StartsWith(prefix, StringComparison.OrdinalIgnoreCase))
            throw new InvalidOperationException("Artifact path escaped the selected project.");
        return full;
    }
}
