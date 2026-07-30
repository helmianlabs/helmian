using Helmion.Desktop.Core;

/// <summary>
/// The net under the guards.
///
/// BASE_RULES.md, LEARNINGS.md and LESSONS.md have been destroyed three times and
/// a fourth loss — 33 of 41 LESSONS.md entries — went unnoticed for days. The
/// installer's guards are correct and they protect one code path. These checks
/// protect the thing that catches the NEXT regression, wherever it comes from.
///
/// Two behaviours matter more than the rest, and both exist because of how the
/// real losses actually played out:
///   - an EMPTY live file is never snapshotted, or a wipe becomes the newest
///     "backup" and the vault helps the loss along;
///   - recovery picks the RICHEST real snapshot, not the newest, because after a
///     wipe the newest copy IS the stub.
/// </summary>
internal static class LivingDocumentVaultChecks
{
    public static void Run()
    {
        var checks = 0;
        var profile = Path.Combine(Path.GetTempPath(), $"helmion-vault-{Guid.NewGuid():N}");
        Directory.CreateDirectory(profile);

        try
        {
            var lessons = Path.Combine(profile, "LESSONS.md");
            var vault = LivingDocumentVault.VaultDirectory(profile);

            // --- 1. IT TAKES A COPY -------------------------------------------
            File.WriteAllText(lessons, "# LESSONS.md\n\n## 2026-07-25 — a real lesson\nreal content\n");
            var first = LivingDocumentVault.Snapshot(profile, new DateTimeOffset(2026, 7, 30, 10, 0, 0, TimeSpan.Zero));
            var lessonsResult = first.Single(r => r.RelativePath == "LESSONS.md");
            Assert(lessonsResult.Taken, "a present living document is snapshotted");
            Assert(File.Exists(lessonsResult.SnapshotPath!), "the snapshot is on disk");
            Assert(File.ReadAllText(lessonsResult.SnapshotPath!) == File.ReadAllText(lessons),
                "the snapshot is byte-identical to the live file");
            checks += 3;

            // Absent files are reported, not invented.
            Assert(first.Single(r => r.RelativePath == "BASE_RULES.md").Taken == false,
                "a document not in this profile is not snapshotted");
            Assert(first.Single(r => r.RelativePath == "BASE_RULES.md").Reason.Contains("not present"),
                "and it says why");
            checks += 2;

            // --- 2. CONTENT-ADDRESSED: repeats do not fill the disk ------------
            var second = LivingDocumentVault.Snapshot(profile, new DateTimeOffset(2026, 7, 30, 11, 0, 0, TimeSpan.Zero));
            Assert(!second.Single(r => r.RelativePath == "LESSONS.md").Taken,
                "an unchanged file is not snapshotted again");
            Assert(second.Single(r => r.RelativePath == "LESSONS.md").Reason.Contains("unchanged"),
                "and it says it was unchanged rather than failing silently");
            Assert(Directory.GetDirectories(vault).Length == 1, "still one snapshot folder, not two");
            checks += 3;

            File.AppendAllText(lessons, "\n## 2026-07-26 — another\nmore\n");
            var third = LivingDocumentVault.Snapshot(profile, new DateTimeOffset(2026, 7, 30, 12, 0, 0, TimeSpan.Zero));
            Assert(third.Single(r => r.RelativePath == "LESSONS.md").Taken, "a CHANGED file is snapshotted");
            Assert(Directory.GetDirectories(vault).Length == 2, "now two snapshot folders");
            checks += 2;

            // --- 3. A WIPE IS NEVER SNAPSHOTTED AS IF IT WERE CONTENT ----------
            //
            // The single most important check here. If the vault snapshotted a
            // zero-byte file, the wipe would become the newest backup and the
            // vault would be helping the loss along.
            File.WriteAllText(lessons, string.Empty);
            var afterWipe = LivingDocumentVault.Snapshot(profile, new DateTimeOffset(2026, 7, 30, 13, 0, 0, TimeSpan.Zero));
            var wiped = afterWipe.Single(r => r.RelativePath == "LESSONS.md");
            Assert(!wiped.Taken, "an EMPTY live file is refused");
            Assert(wiped.Reason.Contains("EMPTY", StringComparison.Ordinal)
                && wiped.Reason.Contains("refusing", StringComparison.OrdinalIgnoreCase),
                "and the refusal says exactly why, in words");
            Assert(Directory.GetDirectories(vault).Length == 2, "the wipe added no snapshot folder");
            checks += 3;

            // --- 4. RECOVERY PICKS THE RICHEST, NOT THE NEWEST ----------------
            //
            // This is the 2026-07-29 failure in miniature: after a wipe the newest
            // copy is the stub, and restoring from newest launders the loss into
            // something that reads like a fix.
            var stubFolder = Path.Combine(vault, "20260730-140000");
            Directory.CreateDirectory(stubFolder);
            var template = ClaudeProfileInstaller.TemplateFor("LESSONS.md")!;
            File.WriteAllText(Path.Combine(stubFolder, "LESSONS.md"), template);

            var newest = LivingDocumentVault.NewestSnapshot(vault, "LESSONS.md");
            Assert(newest is not null && newest.Contains("20260730-140000", StringComparison.Ordinal),
                "precondition: the NEWEST snapshot is the template stub");

            var richest = LivingDocumentVault.RichestRealSnapshot(vault, "LESSONS.md");
            Assert(richest is not null, "a real snapshot is found");
            Assert(richest != newest, "the richest is NOT the newest — the stub is rejected");
            Assert(File.ReadAllText(richest!).Contains("another", StringComparison.Ordinal),
                "and it is the fullest real copy, the one with the most entries");
            checks += 4;

            // --- 5. RESTORE PUTS IT BACK, AND SNAPSHOTS FIRST -----------------
            var foldersBefore = Directory.GetDirectories(vault).Length;
            File.WriteAllText(lessons, "# LESSONS.md\nsomething newer but short\n");
            var restoredFrom = LivingDocumentVault.Restore(profile, "LESSONS.md");
            Assert(restoredFrom is not null, "restore reports what it restored from");
            Assert(File.ReadAllText(lessons).Contains("another", StringComparison.Ordinal),
                "the live file now holds the recovered content");
            Assert(Directory.GetDirectories(vault).Length > foldersBefore,
                "restore snapshotted what it was about to replace — a restore is itself a destructive write");
            checks += 3;

            // Nothing to restore is null, not an exception and not a blank write.
            Assert(LivingDocumentVault.Restore(profile, "NOT_A_DOCUMENT.md") is null,
                "restoring something with no snapshot returns null rather than writing an empty file");
            checks += 1;

            // --- 6. IT NEVER THROWS -------------------------------------------
            var missing = LivingDocumentVault.Snapshot(Path.Combine(Path.GetTempPath(), $"gone-{Guid.NewGuid():N}"));
            Assert(missing.Count == LivingDocumentVault.Protected.Count,
                "a missing profile directory reports every document rather than throwing");
            Assert(missing.All(r => !r.Taken), "and takes nothing");
            Assert(LivingDocumentVault.NewestSnapshot("Z:\\nope", "LESSONS.md") is null,
                "an unreadable vault returns null rather than throwing");
            checks += 3;

            // --- 7. THE INSTALLER TAKES A SNAPSHOT BEFORE IT RUNS -------------
            //
            // The whole point: the net is under the guards, not beside them.
            var fresh = Path.Combine(Path.GetTempPath(), $"helmion-vault-install-{Guid.NewGuid():N}");
            Directory.CreateDirectory(fresh);
            try
            {
                File.WriteAllText(Path.Combine(fresh, "LESSONS.md"), "# LESSONS.md\nTroy's own writing\n");
                ClaudeProfileInstaller.InstallAsync(
                    new HashSet<string> { "LESSONS.md" },
                    CancellationToken.None,
                    targetDirectory: fresh,
                    carryForwardFrom: fresh).GetAwaiter().GetResult();

                var vaulted = LivingDocumentVault.NewestSnapshot(LivingDocumentVault.VaultDirectory(fresh), "LESSONS.md");
                Assert(vaulted is not null, "running the installer took a snapshot first");
                Assert(File.ReadAllText(vaulted!).Contains("Troy's own writing", StringComparison.Ordinal),
                    "and the snapshot holds his content, taken BEFORE any write path could touch it");
                checks += 2;
            }
            finally
            {
                try { Directory.Delete(fresh, recursive: true); } catch { /* temp */ }
            }
        }
        finally
        {
            try { Directory.Delete(profile, recursive: true); } catch { /* temp */ }
        }

        Console.WriteLine($"Helmion living-document vault checks passed ({checks} checks).");
    }

    private static void Assert(bool condition, string what)
    {
        if (!condition)
        {
            throw new InvalidOperationException($"Living document vault failed: {what}");
        }
    }
}
