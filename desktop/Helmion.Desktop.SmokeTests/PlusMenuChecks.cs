using Helmion.Desktop.Core;

/// <summary>
/// The tripwire under the composer's + menu.
///
/// WHY IT IS THIS THOROUGH. Troy's directive was explicit: "Do NOT build only the
/// happy path. The failed and in-progress states are required, not optional." A
/// UI feature normally gets tested by clicking it, which means the success path
/// gets exercised a hundred times and the failure path gets exercised the first
/// time it happens to a user. So the state machine lives in Core as a pure object
/// and every one of the four states is asserted here, with no window open.
///
/// The upload rules are asserted against REAL FILES in a temp directory — an
/// actual oversized file, an actual .exe, an actual empty file — because a policy
/// proven only against strings it was handed is a policy proven against itself.
/// </summary>
internal static class PlusMenuChecks
{
    public static void Run()
    {
        var checks = 0;

        // --- 1. THE MENU EXPLAINS ITSELF ---------------------------------------
        // "Do not assume the user knows the difference between a connector, a
        // plugin, and a skill." Three words that sound identical to a new user.
        var entries = PlusMenuCatalog.Entries;
        Assert(entries.Count == 4, "the menu has exactly the four items asked for");
        Assert(
            entries.Select(e => e.Kind).SequenceEqual(
                [PlusMenuKind.Connector, PlusMenuKind.Plugin, PlusMenuKind.Skill, PlusMenuKind.Upload]),
            "the four items appear in the order Connectors, Plugins, Skills, Upload");
        checks += 2;

        foreach (var entry in entries)
        {
            Assert(entry.OneLiner.Length >= 40,
                $"{entry.Label} carries a real one-line explanation, not a label repeated");
            Assert(!entry.OneLiner.Contains(entry.Label, StringComparison.OrdinalIgnoreCase),
                $"{entry.Label}'s description explains the word instead of restating it");
            Assert(entry.Icon.Length > 0 && entry.Label.Length > 0, $"{entry.Label} has an icon and a label");
            checks += 3;
        }

        // --- 2. ALL FOUR STATES, ON EVERY KIND ---------------------------------
        foreach (var kind in Enum.GetValues<PlusMenuKind>())
        {
            var controller = new PlusMenuController();

            // in-progress
            var item = controller.Begin(kind, $"test {kind}");
            Assert(item.State == PlusActionState.InProgress, $"{kind}: a new action starts in-progress");
            Assert(item.IsBusy, $"{kind}: in-progress reports busy so the row can spin");
            Assert(item.StateText == "Connecting…", $"{kind}: in-progress says so in words, not only by animation");
            Assert(item.Message.Length > 0, $"{kind}: an in-progress row still says what it is doing");
            Assert(!item.CanRemove, $"{kind}: an in-flight action cannot be removed out from under itself");
            Assert(controller.Items.Count == 1, $"{kind}: the row is on screen while it runs");
            checks += 6;

            // success
            controller.Succeed(item, "connected to the test target");
            Assert(item.State == PlusActionState.Succeeded && item.StateText == "Added", $"{kind}: success state");
            Assert(item.Message == "connected to the test target", $"{kind}: success keeps its message");
            Assert(item.CanRemove && !item.IsBusy, $"{kind}: a settled row can be removed");
            checks += 3;

            // remove / undo
            Assert(controller.Remove(item), $"{kind}: a settled row removes");
            Assert(item.State == PlusActionState.Removed && item.StateText == "Removed", $"{kind}: removed state");
            Assert(controller.Items.Count == 1, $"{kind}: a removed row is still present so undo has something to restore");
            Assert(item.CanUndo, $"{kind}: removed offers undo");
            Assert(controller.Undo(item), $"{kind}: undo works");
            Assert(item.State == PlusActionState.Succeeded, $"{kind}: undo restores the state it had before removal");
            checks += 6;

            // failure — the state Troy called out as the one that gets skipped
            var failed = controller.Begin(kind, $"failing {kind}");
            controller.Fail(failed, "the host refused the connection (timed out after 30s)");
            Assert(failed.State == PlusActionState.Failed && failed.StateText == "Failed", $"{kind}: failure state");
            Assert(failed.Message.Contains("timed out", StringComparison.Ordinal),
                $"{kind}: the failure carries the readable reason, not just the word Failed");
            Assert(failed.CanRemove, $"{kind}: a failed row can be dismissed");
            checks += 3;

            // A failure with no reason is refused. "Failed" with nothing after it
            // is the silent failure this feature exists to stop, wearing a label.
            var blank = controller.Begin(kind, "blank");
            controller.Fail(blank, "   ");
            Assert(blank.Message.Contains("bug in Helmion", StringComparison.Ordinal),
                $"{kind}: a reasonless failure names itself as a Helmion bug rather than showing an empty error");
            checks += 1;

            // Discard is the only thing that deletes, and only from Removed.
            Assert(!controller.Discard(failed), $"{kind}: a failed row is not discarded without being removed first");
            controller.Remove(failed);
            Assert(controller.Discard(failed), $"{kind}: a removed row can be discarded for good");
            checks += 2;
        }

        // --- 3. UPLOAD, AGAINST REAL FILES ON DISK -----------------------------
        var dir = Path.Combine(Path.GetTempPath(), $"helmion-plus-{Guid.NewGuid():N}");
        Directory.CreateDirectory(dir);
        try
        {
            var good = Path.Combine(dir, "notes.md");
            File.WriteAllText(good, "# real content\nthis is attachable\n");
            var ok = AttachmentPolicy.Validate(good);
            Assert(ok.Accepted && ok.Rejection == AttachmentRejection.None, "a small .md file is accepted");
            Assert(ok.Message.Contains("notes.md", StringComparison.Ordinal), "the success message names the file");
            checks += 2;

            // TOO LARGE — a real oversized file, not a claimed size.
            var big = Path.Combine(dir, "huge.txt");
            using (var fs = new FileStream(big, FileMode.Create, FileAccess.Write))
            {
                fs.SetLength(AttachmentPolicy.MaxBytes + 1024);
            }
            var large = AttachmentPolicy.Validate(big);
            Assert(!large.Accepted && large.Rejection == AttachmentRejection.TooLarge, "an oversized file is refused");
            Assert(large.Message.Contains("over the", StringComparison.Ordinal)
                && large.Message.Contains("limit", StringComparison.Ordinal),
                "the too-large message says it is over a limit");
            Assert(large.Message.Contains("MB", StringComparison.Ordinal),
                "the too-large message states the actual size, so it is actionable");
            Assert(large.Message.Contains("split", StringComparison.Ordinal),
                "the too-large message tells the user what to do instead");
            checks += 4;

            // UNSUPPORTED TYPE — a real .exe.
            var exe = Path.Combine(dir, "installer.exe");
            File.WriteAllBytes(exe, [0x4D, 0x5A, 0x90, 0x00]);
            var wrong = AttachmentPolicy.Validate(exe);
            Assert(!wrong.Accepted && wrong.Rejection == AttachmentRejection.UnsupportedType,
                "an .exe is refused as an unsupported type");
            Assert(wrong.Message.Contains(".exe", StringComparison.OrdinalIgnoreCase),
                "the unsupported-type message names the offending extension");
            Assert(wrong.Message.Contains(".md", StringComparison.Ordinal),
                "the unsupported-type message says what IS allowed instead of only what is not");
            checks += 3;

            // A file with no extension at all.
            var bare = Path.Combine(dir, "Makefile");
            File.WriteAllText(bare, "all:\n\techo hi\n");
            var noExt = AttachmentPolicy.Validate(bare);
            Assert(!noExt.Accepted && noExt.Rejection == AttachmentRejection.UnsupportedType,
                "a file with no extension is refused rather than guessed at");
            Assert(noExt.Message.Contains("no file extension", StringComparison.Ordinal),
                "the no-extension case says specifically that, not a generic type error");
            checks += 2;

            // EMPTY.
            var empty = Path.Combine(dir, "blank.txt");
            File.WriteAllText(empty, string.Empty);
            var none = AttachmentPolicy.Validate(empty);
            Assert(!none.Accepted && none.Rejection == AttachmentRejection.Empty, "an empty file is refused");
            Assert(none.Message.Contains("empty", StringComparison.OrdinalIgnoreCase),
                "the empty message says the file is empty");
            checks += 2;

            // MISSING and null.
            var gone = AttachmentPolicy.Validate(Path.Combine(dir, "not-here.txt"));
            Assert(!gone.Accepted && gone.Rejection == AttachmentRejection.Missing, "a missing file is refused");
            Assert(!AttachmentPolicy.Validate(null).Accepted, "a null path is refused");
            Assert(!AttachmentPolicy.Validate("   ").Accepted, "a blank path is refused");
            checks += 3;

            // EVERY refusal carries a sentence. This is the whole promise.
            foreach (var decision in new[] { large, wrong, noExt, none, gone })
            {
                Assert(!string.IsNullOrWhiteSpace(decision.Message),
                    $"the {decision.Rejection} refusal carries a readable message — never a silent failure");
                checks += 1;
            }

            // --- 4. A REFUSED UPLOAD SHOWS AS A FAILED ROW, NOT NOTHING --------
            // The seam where a silent failure would actually happen: policy says
            // no, and the UI never hears about it.
            var uploads = new PlusMenuController();
            var row = uploads.Begin(PlusMenuKind.Upload, Path.GetFileName(big));
            uploads.Fail(row, large.Message);
            Assert(row.State == PlusActionState.Failed, "a refused upload lands as a visible failed row");
            Assert(row.Message == large.Message, "the row shows the policy's own sentence, not a generic one");
            Assert(uploads.ActiveAttachments.Count == 0, "a refused upload is NOT counted as an attachment");
            checks += 3;

            var accepted = uploads.Begin(PlusMenuKind.Upload, Path.GetFileName(good));
            uploads.Succeed(accepted, ok.Message);
            Assert(uploads.ActiveAttachments.Count == 1, "an accepted upload IS counted as an attachment");
            uploads.Remove(accepted);
            Assert(uploads.ActiveAttachments.Count == 0,
                "removing an attachment stops it riding along with the next prompt");
            uploads.Undo(accepted);
            Assert(uploads.ActiveAttachments.Count == 1, "undo puts the attachment back on the prompt");
            checks += 3;
        }
        finally
        {
            try { Directory.Delete(dir, recursive: true); } catch { /* temp dir */ }
        }

        Console.WriteLine($"Helmion plus-menu checks passed ({checks} checks).");
    }

    private static void Assert(bool condition, string what)
    {
        if (!condition)
        {
            throw new InvalidOperationException($"Plus menu failed: {what}");
        }
    }
}
