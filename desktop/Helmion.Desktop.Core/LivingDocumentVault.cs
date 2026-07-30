using System.Security.Cryptography;

namespace Helmion.Desktop.Core;

/// <summary>One snapshot that was taken, or the reason one was not.</summary>
public sealed record VaultSnapshot(
    string RelativePath,
    string? SnapshotPath,
    long Bytes,
    bool Taken,
    string Reason);

/// <summary>
/// A rolling, content-addressed history of the operator's living documents.
///
/// WHY THIS EXISTS AFTER EVERYTHING ELSE WAS ALREADY FIXED.
///
/// BASE_RULES.md, LEARNINGS.md and LESSONS.md have been destroyed three times:
/// 2026-07-28 (5,512 bytes of his own writing, no backup), and twice more on
/// 2026-07-29 at 16:28 and 17:58. Each time a session happened to notice and put
/// them back. On 2026-07-30 a fourth loss was found that nobody had noticed at
/// all — 33 of 41 LESSONS.md entries, gone for days.
///
/// The installer now refuses to overwrite them (ClaudeProfileInstaller
/// LivingDocuments) and recovers a missing one from backup rather than seeding a
/// blank. Both of those are guards on ONE code path.
///
/// This is not a guard. It is a net under the guards. It takes a dated copy
/// BEFORE anything runs, so the next regression — in this installer, in a script,
/// in something nobody has written yet — costs a restore instead of the work.
/// Three losses were survived by luck; the fourth was not noticed for days. Luck
/// is not a backup strategy.
///
/// CONTENT-ADDRESSED, so it does not fill the disk. A snapshot is only written
/// when the file's SHA-256 differs from the newest snapshot of that file. Opening
/// the Pilot fifty times produces one snapshot, not fifty.
///
/// IT NEVER WRITES INTO THE LIVE FILES. Every method here either reads a living
/// document or writes into the vault folder. Restoring is a separate, explicit
/// call, and it too takes a snapshot of what it is about to replace.
/// </summary>
public static class LivingDocumentVault
{
    /// <summary>Where snapshots live, under the profile directory being protected.</summary>
    public const string VaultFolder = "_helmion_vault";

    /// <summary>
    /// How many dated snapshots to keep. Thirty is roughly a month of daily
    /// edits, and three files at a few tens of KB each — trivially small next to
    /// what one loss costs.
    /// </summary>
    public const int KeepSnapshots = 30;

    /// <summary>The files this protects. Same set the installer refuses to overwrite.</summary>
    public static IReadOnlyList<string> Protected { get; } =
        ["BASE_RULES.md", "LEARNINGS.md", "LESSONS.md"];

    public static string VaultDirectory(string claudeDirectory) =>
        Path.Combine(claudeDirectory, VaultFolder);

    /// <summary>
    /// Snapshot every protected document whose content has changed since its last
    /// snapshot. Safe to call on every launch and before every sync.
    ///
    /// Never throws. A backup that takes the app down with it is worse than no
    /// backup, so every failure is reported in the result and the caller decides.
    /// </summary>
    public static IReadOnlyList<VaultSnapshot> Snapshot(
        string claudeDirectory,
        DateTimeOffset? now = null)
    {
        var results = new List<VaultSnapshot>();
        if (string.IsNullOrWhiteSpace(claudeDirectory) || !Directory.Exists(claudeDirectory))
        {
            foreach (var name in Protected)
            {
                results.Add(new VaultSnapshot(name, null, 0, false,
                    $"the profile directory {claudeDirectory} does not exist"));
            }
            return results;
        }

        var stamp = (now ?? DateTimeOffset.Now).ToString("yyyyMMdd-HHmmss");
        var vault = VaultDirectory(claudeDirectory);

        foreach (var name in Protected)
        {
            var source = Path.Combine(claudeDirectory, name);
            try
            {
                if (!File.Exists(source))
                {
                    results.Add(new VaultSnapshot(name, null, 0, false, "not present in this profile"));
                    continue;
                }

                var bytes = File.ReadAllBytes(source);

                // An EMPTY file is never snapshotted. Snapshotting a zero-byte
                // file would let a wipe quietly become the newest "backup", and
                // the vault would then be helping the loss along.
                if (bytes.Length == 0)
                {
                    results.Add(new VaultSnapshot(name, null, 0, false,
                        "the live file is EMPTY — refusing to snapshot a wipe as if it were content"));
                    continue;
                }

                var digest = Sha256(bytes);
                var newest = NewestSnapshot(vault, name);
                if (newest is not null && Sha256(File.ReadAllBytes(newest)) == digest)
                {
                    results.Add(new VaultSnapshot(name, newest, bytes.Length, false,
                        "unchanged since the last snapshot"));
                    continue;
                }

                var folder = Path.Combine(vault, stamp);
                Directory.CreateDirectory(folder);
                var destination = Path.Combine(folder, name);
                File.WriteAllBytes(destination, bytes);
                results.Add(new VaultSnapshot(name, destination, bytes.Length, true, "snapshotted"));
            }
            catch (Exception ex)
            {
                results.Add(new VaultSnapshot(name, null, 0, false, $"could not snapshot: {ex.Message}"));
            }
        }

        Prune(vault);
        return results;
    }

    /// <summary>
    /// The newest snapshot of one document, or null when there is none.
    /// Newest by folder name, which is a sortable timestamp by construction.
    /// </summary>
    public static string? NewestSnapshot(string vaultDirectory, string relativePath)
    {
        try
        {
            if (!Directory.Exists(vaultDirectory)) return null;
            return Directory.EnumerateDirectories(vaultDirectory)
                .OrderByDescending(Path.GetFileName, StringComparer.Ordinal)
                .Select(folder => Path.Combine(folder, relativePath))
                .FirstOrDefault(File.Exists);
        }
        catch (Exception)
        {
            return null;
        }
    }

    /// <summary>
    /// The RICHEST snapshot of one document — the largest that is not the shipped
    /// starter template.
    ///
    /// Largest rather than newest, deliberately, and this is the one place size
    /// is the right measure: after a wipe the NEWEST copy is the stub. Recovering
    /// from newest would launder the loss into something that reads like a fix,
    /// which is exactly what happened on 2026-07-29.
    /// </summary>
    public static string? RichestRealSnapshot(string vaultDirectory, string relativePath)
    {
        try
        {
            if (!Directory.Exists(vaultDirectory)) return null;
            var template = ClaudeProfileInstaller.TemplateFor(relativePath);

            return Directory.EnumerateDirectories(vaultDirectory)
                .Select(folder => Path.Combine(folder, relativePath))
                .Where(File.Exists)
                .Where(path =>
                {
                    try
                    {
                        var text = File.ReadAllText(path);
                        if (string.IsNullOrWhiteSpace(text)) return false;
                        if (template is null) return true;
                        return Normalize(text) != Normalize(template);
                    }
                    catch (Exception) { return false; }
                })
                .OrderByDescending(path => new FileInfo(path).Length)
                .FirstOrDefault();
        }
        catch (Exception)
        {
            return null;
        }
    }

    /// <summary>
    /// Puts the richest real snapshot back, after snapshotting whatever is there
    /// now. Returns the file it restored from, or null when there was nothing to
    /// restore.
    ///
    /// It snapshots first ON PURPOSE: a restore is itself a destructive write, and
    /// the thing being replaced might be the only copy of something newer.
    /// </summary>
    public static string? Restore(string claudeDirectory, string relativePath)
    {
        try
        {
            var vault = VaultDirectory(claudeDirectory);
            var source = RichestRealSnapshot(vault, relativePath);
            if (source is null) return null;

            Snapshot(claudeDirectory);
            File.Copy(source, Path.Combine(claudeDirectory, relativePath), overwrite: true);
            return source;
        }
        catch (Exception)
        {
            return null;
        }
    }

    /// <summary>Drops the oldest snapshot folders past <see cref="KeepSnapshots"/>.</summary>
    private static void Prune(string vaultDirectory)
    {
        try
        {
            if (!Directory.Exists(vaultDirectory)) return;
            var folders = Directory.EnumerateDirectories(vaultDirectory)
                .OrderByDescending(Path.GetFileName, StringComparer.Ordinal)
                .ToList();

            foreach (var stale in folders.Skip(KeepSnapshots))
            {
                try { Directory.Delete(stale, recursive: true); } catch { /* keep going */ }
            }
        }
        catch (Exception)
        {
            // Pruning is housekeeping. Failing to prune must never fail a backup.
        }
    }

    private static string Sha256(byte[] bytes) => Convert.ToHexString(SHA256.HashData(bytes));

    private static string Normalize(string text) => text.Replace("\r\n", "\n").Trim();
}
