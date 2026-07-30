using System.Security.Cryptography;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace Helmion.LocalService.Protocol;

public static partial class WorkspaceInspector
{
    public static WorkspaceInspection Inspect(string workspacePath)
    {
        if (string.IsNullOrWhiteSpace(workspacePath)
            || !Path.IsPathFullyQualified(workspacePath))
        {
            throw new ArgumentException(
                "Workspace path must be an absolute local directory",
                nameof(workspacePath));
        }

        var projectPath = Path.GetFullPath(workspacePath);
        if (projectPath.StartsWith(@"\\", StringComparison.Ordinal))
        {
            throw new ArgumentException(
                "Network workspace paths are not supported by the local pilot",
                nameof(workspacePath));
        }

        var directory = new DirectoryInfo(projectPath);
        if (!directory.Exists)
        {
            throw new DirectoryNotFoundException($"Workspace does not exist: {projectPath}");
        }

        var driveRoot = Path.GetPathRoot(projectPath);
        if (string.IsNullOrWhiteSpace(driveRoot)
            || new DriveInfo(driveRoot).DriveType == DriveType.Network)
        {
            throw new ArgumentException(
                "Workspace must be on a local Windows drive",
                nameof(workspacePath));
        }

        var helmionConfigPath = Path.Combine(projectPath, ".helmion", "config.json");
        var helmionConfigPresent = File.Exists(helmionConfigPath);
        var migrations = InspectMigrations(projectPath);
        var evidence = InspectEvidence(projectPath, helmionConfigPresent);
        var looksLikeHelmion = helmionConfigPresent
            || migrations.Count > 0
            || PackageNamesHelmion(projectPath);

        return new WorkspaceInspection(
            ProjectName: directory.Name,
            ProjectPath: projectPath,
            Branch: InspectBranch(projectPath),
            HelmionConfigPresent: helmionConfigPresent,
            LooksLikeHelmionWorkspace: looksLikeHelmion,
            // 2026-07-29: this used to be four hardcoded literals — Status:
            // "UNAVAILABLE", "Durable lease not connected", "found no local lease
            // authority" — returned regardless of what was on disk. src/core/lease.mjs
            // now owns a real file lease at <workspace>\.helmion\lease.json and
            // reports four honest states through inspectLease; LeaseInspector reads
            // that same file with the same rules. UNREADABLE is never laundered
            // into NONE (LeaseInspector.cs:21-27).
            Lease: LeaseInspector.Inspect(projectPath),
            Migrations: migrations,
            Evidence: evidence,
            MigrationStateLabel: migrations.Count == 0
                ? "No local SQL migrations found"
                : $"{migrations.Count} local source migration{(migrations.Count == 1 ? string.Empty : "s")} · applied state not queried",
            EvidenceStateLabel: evidence.Count == 0
                ? "No local evidence inventory found"
                : $"{evidence.Count} local evidence source{(evidence.Count == 1 ? string.Empty : "s")}",
            InspectedAt: DateTimeOffset.Now,
            ProjectWasModified: false);
    }

    private static List<MigrationSourceItem> InspectMigrations(string projectPath)
    {
        var sqlDirectory = Path.Combine(projectPath, "sql");
        if (!Directory.Exists(sqlDirectory)
            || IsReparsePoint(sqlDirectory))
        {
            return [];
        }

        return Directory
            .EnumerateFiles(sqlDirectory, "*.sql", SearchOption.TopDirectoryOnly)
            .Where(path => MigrationName().IsMatch(Path.GetFileName(path)))
            .OrderBy(path => Path.GetFileName(path), StringComparer.Ordinal)
            .Select(path =>
            {
                var file = new FileInfo(path);
                using var stream = file.OpenRead();
                var checksum = Convert.ToHexString(SHA256.HashData(stream)).ToLowerInvariant();
                var name = file.Name;
                return new MigrationSourceItem(
                    Version: name[..name.IndexOf('_')],
                    Name: name,
                    Sha256: checksum,
                    SizeBytes: file.Length);
            })
            .ToList();
    }

    private static List<EvidenceInventoryItem> InspectEvidence(
        string projectPath,
        bool helmionConfigPresent)
    {
        var evidence = new List<EvidenceInventoryItem>();
        AddEvidenceFiles(projectPath, Path.Combine(".helmion", "evidence"), evidence);
        AddEvidenceFiles(projectPath, Path.Combine(".helmion", "checkpoints"), evidence);

        var testsDirectory = Path.Combine(projectPath, "test");
        if (Directory.Exists(testsDirectory) && !IsReparsePoint(testsDirectory))
        {
            var testCount = Directory
                .EnumerateFiles(testsDirectory, "*.test.mjs", SearchOption.TopDirectoryOnly)
                .Count();
            if (testCount > 0)
            {
                evidence.Add(new EvidenceInventoryItem(
                    "TEST SOURCE",
                    "Automated verification sources",
                    $"{testCount} local test file{(testCount == 1 ? string.Empty : "s")}; execution results were not inferred",
                    "test"));
            }
        }

        var docsDirectory = Path.Combine(projectPath, "docs");
        if (Directory.Exists(docsDirectory) && !IsReparsePoint(docsDirectory))
        {
            var runbookCount = Directory
                .EnumerateFiles(docsDirectory, "*.md", SearchOption.TopDirectoryOnly)
                .Count(path => EvidenceDocumentName().IsMatch(Path.GetFileName(path)));
            if (runbookCount > 0)
            {
                evidence.Add(new EvidenceInventoryItem(
                    "RUNBOOK",
                    "Governance and phase runbooks",
                    $"{runbookCount} local runbook{(runbookCount == 1 ? string.Empty : "s")}; documentation is not durable execution proof",
                    "docs"));
            }
        }

        if (helmionConfigPresent)
        {
            evidence.Add(new EvidenceInventoryItem(
                "CONFIG",
                "Helmion workspace configuration",
                "Local .helmion/config.json is present; contents were not treated as approval authority",
                @".helmion\config.json"));
        }

        return evidence;
    }

    private static void AddEvidenceFiles(
        string projectPath,
        string relativeDirectory,
        ICollection<EvidenceInventoryItem> evidence)
    {
        var directory = Path.Combine(projectPath, relativeDirectory);
        if (!Directory.Exists(directory) || IsReparsePoint(directory))
        {
            return;
        }

        foreach (var path in Directory
                     .EnumerateFiles(directory, "*", SearchOption.TopDirectoryOnly)
                     .Where(path => path.EndsWith(".json", StringComparison.OrdinalIgnoreCase)
                         || path.EndsWith(".md", StringComparison.OrdinalIgnoreCase))
                     .OrderBy(path => Path.GetFileName(path), StringComparer.Ordinal)
                     .Take(100))
        {
            var file = new FileInfo(path);
            evidence.Add(new EvidenceInventoryItem(
                "LOCAL EVIDENCE",
                file.Name,
                $"{file.Length:N0} bytes · local file inventory only",
                Path.GetRelativePath(projectPath, file.FullName)));
        }
    }

    private static string InspectBranch(string projectPath)
    {
        var gitDirectory = Path.Combine(projectPath, ".git");
        var headPath = Path.Combine(gitDirectory, "HEAD");
        if (!Directory.Exists(gitDirectory)
            || IsReparsePoint(gitDirectory)
            || !File.Exists(headPath))
        {
            return File.Exists(gitDirectory)
                ? "Git worktree metadata detected"
                : "No local Git branch detected";
        }

        var head = File.ReadAllText(headPath).Trim();
        const string prefix = "ref: refs/heads/";
        if (head.StartsWith(prefix, StringComparison.Ordinal))
        {
            return head[prefix.Length..];
        }

        return head.Length >= 12
            ? $"detached · {head[..12]}"
            : "Detached Git state";
    }

    private static bool PackageNamesHelmion(string projectPath)
    {
        var packagePath = Path.Combine(projectPath, "package.json");
        if (!File.Exists(packagePath))
        {
            return false;
        }

        try
        {
            using var package = JsonDocument.Parse(File.ReadAllText(packagePath));
            return package.RootElement.TryGetProperty("name", out var name)
                && name.GetString()?.Contains("helmion", StringComparison.OrdinalIgnoreCase) == true;
        }
        catch (JsonException)
        {
            return false;
        }
        catch (IOException)
        {
            return false;
        }
    }

    private static bool IsReparsePoint(string path)
    {
        return (File.GetAttributes(path) & FileAttributes.ReparsePoint) != 0;
    }

    [GeneratedRegex(@"^\d+_[a-z0-9_-]+\.sql$", RegexOptions.IgnoreCase)]
    private static partial Regex MigrationName();

    [GeneratedRegex(
        @"(phase|maestro|handoff|human_confirmation|desktop|release)",
        RegexOptions.IgnoreCase)]
    private static partial Regex EvidenceDocumentName();
}
