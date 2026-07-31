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

            // EMPTY — the state that did not exist, and whose absence made every
            // fresh workspace look broken. An empty plugins registry was drawn in
            // red as "Failed" when nothing had failed at all.
            var nothing = controller.Begin(kind, $"empty {kind}");
            controller.Empty(nothing, "No plugins are installed in this workspace yet. Install one with: helmion plugin add <path>");
            Assert(nothing.State == PlusActionState.Empty, $"{kind}: an empty result lands in the empty state");
            Assert(nothing.StateText == "Nothing yet",
                $"{kind}: an empty result says 'Nothing yet' — it must never read as Failed");
            Assert(nothing.StateKey == "Empty",
                $"{kind}: empty carries its own colour key, so it is not drawn in the failure colour");
            Assert(nothing.StateKey != "Failed" && nothing.StateText != "Failed",
                $"{kind}: nothing-found is not reported as a failure anywhere on the row");
            Assert(nothing.Message.Contains("helmion plugin add", StringComparison.Ordinal),
                $"{kind}: an empty row still tells the user what would put something there");
            Assert(nothing.CanRemove && !nothing.IsBusy,
                $"{kind}: an empty row is settled and can be dismissed");
            checks += 6;

            // An empty state with no guidance is refused, same as a reasonless
            // failure. "Nothing yet" and no next step is a dead end.
            var mute = controller.Begin(kind, "mute");
            controller.Empty(mute, "  ");
            Assert(mute.Message.Contains("bug in Helmion", StringComparison.Ordinal),
                $"{kind}: an empty row with no guidance names itself a Helmion bug rather than sitting there blank");
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

        // --- 5. THE MENU IS PER-MAESTRO, WITH THAT CLI'S REAL SYNTAX -----------
        //
        // Troy's correction, 2026-07-30: "whoever the Maestro is, that's whose
        // skills, connectors, plugins, all that, exact copied and populated and
        // working." A generic four-item list was the wrong build. These checks
        // pin that each provider carries ITS OWN paths and commands, taken from
        // that provider's own documentation.
        var builtIns = new[] { "OpenAI", "Claude", "Gemini", "Grok" };
        foreach (var name in builtIns)
        {
            var caps = ProviderCapabilityCatalog.For(name);
            Assert(caps is not null, $"{name} is a built-in coordinator and must have a mapped menu");
            Assert(caps!.Count == 4, $"{name} exposes all four kinds");
            Assert(caps.Select(c => c.Kind).Distinct().Count() == 4, $"{name} has no duplicate kinds");
            foreach (var cap in caps)
            {
                Assert(cap.Label.Length > 0 && cap.OneLiner.Length > 0, $"{name}/{cap.Kind} is labelled and explained");
                Assert(cap.Detail.Length > 20, $"{name}/{cap.Kind} carries real syntax, not a placeholder");
                Assert(cap.Icon.Length > 0, $"{name}/{cap.Kind} inherits the shared icon for its kind");
            }
            checks += 3 + (caps.Count * 3);
        }

        // Each provider's connector row names ITS OWN config location. If these
        // ever collapse to one string, the menu has stopped being per-provider.
        AssertDetail("Grok", PlusMenuKind.Connector, "~/.grok/config.toml");
        AssertDetail("Gemini", PlusMenuKind.Connector, "~/.gemini/settings.json");
        AssertDetail("Claude", PlusMenuKind.Connector, ".mcp.json");
        AssertDetail("OpenAI", PlusMenuKind.Connector, "~/.codex/config.toml");
        checks += 4;

        AssertDetail("Grok", PlusMenuKind.Skill, "~/.grok/skills/");
        AssertDetail("Gemini", PlusMenuKind.Skill, "~/.gemini/skills/");
        AssertDetail("Claude", PlusMenuKind.Skill, "~/.claude/skills/");
        AssertDetail("OpenAI", PlusMenuKind.Skill, ".agents/skills");
        checks += 4;

        // THE ASYMMETRY THAT COSTS AN HOUR IF NOBODY SAYS IT. Claude Code's @
        // inlines the file's CONTENTS; Codex's @ inserts the PATH. Same symbol,
        // opposite behaviour, both documented.
        AssertDetail("Claude", PlusMenuKind.Upload, "INLINES THE FILE'S CONTENTS");
        AssertDetail("OpenAI", PlusMenuKind.Upload, "not its contents");
        // Grok is the only one of the four with a line-range form.
        AssertDetail("Grok", PlusMenuKind.Upload, ":10-50");
        // Grok gates plugin installs behind an explicit trust flag; Gemini does not.
        AssertDetail("Grok", PlusMenuKind.Plugin, "--trust");
        // Gemini calls them extensions, not plugins, and the menu uses its word.
        Assert(ProviderCapabilityCatalog.For("Gemini")!
                .First(c => c.Kind == PlusMenuKind.Plugin).Label == "Extensions",
            "Gemini's row is labelled Extensions, because that is what Gemini calls them");
        checks += 5;

        // Aliases resolve to the same menu.
        Assert(ReferenceEquals(ProviderCapabilityCatalog.For("codex"), ProviderCapabilityCatalog.For("OpenAI")),
            "the Codex CLI and the OpenAI coordinator are the same menu");
        Assert(ReferenceEquals(ProviderCapabilityCatalog.For("claude code"), ProviderCapabilityCatalog.For("Claude")),
            "a coordinator named for the CLI resolves to the same menu");
        Assert(MaestroKey.Normalize("  GROK  ") == MaestroKey.Grok, "normalisation trims and folds case");
        checks += 3;

        // AN UNMAPPED PROVIDER RETURNS NOTHING AND DOES NOT BORROW.
        foreach (var unknown in new[] { "MyLocalLlama", "", "   ", null })
        {
            Assert(ProviderCapabilityCatalog.For(unknown) is null,
                $"an unmapped coordinator ('{unknown}') has no menu rather than someone else's");
            Assert(!ProviderCapabilityCatalog.IsMapped(unknown), $"'{unknown}' reports itself unmapped");
            checks += 2;
        }
        Assert(MaestroKey.DisplayName("MyLocalLlama") == "MyLocalLlama",
            "a custom provider is still named on screen even though its menu is empty");
        Assert(MaestroKey.DisplayName(null) == "no Maestro selected",
            "no coordinator selected says so rather than naming a default");
        checks += 2;

        // An unsupported capability is still SHOWN, dimmed, with a reason - never
        // hidden. Nothing is unsupported today; this pins the behaviour for when
        // something is.
        var refused = new ProviderCapability(
            PlusMenuKind.Plugin, false, "Plugins", "one line", "how", "This CLI has no plugin system.");
        Assert(refused.Detail == "This CLI has no plugin system.", "an unsupported row shows the reason, not the syntax");
        Assert(refused.Opacity < 1.0, "an unsupported row is dimmed");
        var noReason = new ProviderCapability(PlusMenuKind.Plugin, false, "Plugins", "one line", "how");
        Assert(noReason.Detail.Length > 0, "an unsupported row with no stated reason still says something");
        checks += 3;

        // --- 6. THE ATTACHMENT ACTUALLY REACHES THE MODEL ----------------------
        //
        // THE DEFECT THIS SECTION EXISTS FOR. Upload was decorative. The picked
        // file's path was destroyed at MainWindow.PlusMenu.cs:139, which kept only
        // Path.GetFileName; PlusMenuController.ActiveAttachments had ZERO
        // production readers; and the send seam passed the typed text alone. The
        // user saw a green "attached" row and the model received nothing. Silent,
        // and shaped exactly like success.
        //
        // WHY THESE ASSERTIONS LOOK DIFFERENT FROM THE ONES ABOVE. Section 5 of
        // this file asserts that hardcoded strings contain hardcoded substrings —
        // it cannot fail unless someone edits both halves. Nothing below does
        // that. Every file's contents are a GUID generated at RUN TIME, so no
        // assertion here can pass by matching a literal written in this file, and
        // every assertion is about the OUTGOING PAYLOAD rather than a list count.
        // The old ActiveAttachments checks counted a collection nothing read.
        var sendDir = Path.Combine(Path.GetTempPath(), $"helmion-send-{Guid.NewGuid():N}");
        Directory.CreateDirectory(sendDir);
        try
        {
            var headMarker = $"HEAD-{Guid.NewGuid():N}";
            var tailMarker = $"TAIL-{Guid.NewGuid():N}";
            var attached = Path.Combine(sendDir, "payload.md");
            File.WriteAllText(attached, $"# notes\n{headMarker}\nmiddle\n{tailMarker}\n");

            var send = new PlusMenuController();
            var row = send.Begin(PlusMenuKind.Upload, Path.GetFileName(attached), null, attached);
            send.Succeed(row, AttachmentPolicy.Validate(attached).Message);

            // THE PATH SURVIVES. Without this the file can never be reopened and
            // an attachment is only ever a label.
            Assert(row.SourcePath == attached,
                "an upload row remembers the REAL path on disk, not just the file name");
            Assert(send.ActiveAttachments.Count == 1, "the accepted upload is live");
            checks += 2;

            // THE FIX ITSELF: content on the wire.
            var prompt = PromptAttachments.Compose("summarise this", send.ActiveAttachments);
            Assert(prompt.Text.Contains(headMarker, StringComparison.Ordinal),
                "the attached file's ACTUAL CONTENT is in the text that goes to the model");
            Assert(prompt.Text.Contains(tailMarker, StringComparison.Ordinal),
                "the WHOLE file goes, not a truncated head of it");
            Assert(prompt.Text.Contains("summarise this", StringComparison.Ordinal),
                "the user's typed words survive alongside the attachment");
            Assert(prompt.Text.Contains(Path.GetFileName(attached), StringComparison.Ordinal),
                "the payload names the file, so the model knows what it is reading");
            Assert(prompt.Included.Count == 1 && !prompt.AnyRefused,
                "exactly one file went and nothing was refused");
            checks += 5;

            // NOTHING ATTACHED MUST CHANGE NOTHING. A session that never touches
            // the + button has to send byte-for-byte what it sent before.
            var bare = PromptAttachments.Compose("just a question", new List<PlusActionItem>());
            Assert(bare.Text == "just a question",
                "with nothing attached the payload is exactly what the user typed");
            Assert(bare.Inclusions.Count == 0, "and nothing is reported as having been attached");
            checks += 2;

            // A REFUSED UPLOAD MUST NOT RIDE ALONG. Written as text inside an .exe
            // so the assertion is about the CONTENT, not the extension.
            var refusedMarker = $"REFUSED-{Guid.NewGuid():N}";
            var refusedFile = Path.Combine(sendDir, "tool.exe");
            File.WriteAllText(refusedFile, refusedMarker);
            var refusedRow = send.Begin(
                PlusMenuKind.Upload, Path.GetFileName(refusedFile), null, refusedFile);
            send.Fail(refusedRow, AttachmentPolicy.Validate(refusedFile).Message);

            var afterRefusal = PromptAttachments.Compose("go", send.ActiveAttachments);
            Assert(!afterRefusal.Text.Contains(refusedMarker, StringComparison.Ordinal),
                "a REFUSED upload's content never reaches the model");
            Assert(afterRefusal.Text.Contains(headMarker, StringComparison.Ordinal),
                "and refusing one file does not drop the one that was accepted");
            checks += 2;

            // REMOVE / UNDO, ASSERTED ON THE PAYLOAD. The pre-existing checks for
            // this only counted ActiveAttachments — a list no production code read,
            // so the count could be right while the model still got nothing.
            send.Remove(row);
            var afterRemove = PromptAttachments.Compose("go", send.ActiveAttachments);
            Assert(!afterRemove.Text.Contains(headMarker, StringComparison.Ordinal),
                "removing an attachment takes its CONTENT out of the outgoing payload");
            send.Undo(row);
            var afterUndo = PromptAttachments.Compose("go", send.ActiveAttachments);
            Assert(afterUndo.Text.Contains(headMarker, StringComparison.Ordinal),
                "undo puts the content back into the outgoing payload");
            checks += 2;

            // DELETED BETWEEN ATTACH AND SEND. The row said "Added" minutes ago;
            // the file is gone now. It must be reported, not silently skipped.
            var vanishMarker = $"VANISH-{Guid.NewGuid():N}";
            var vanishing = Path.Combine(sendDir, "gone.md");
            File.WriteAllText(vanishing, vanishMarker);
            var vanishSend = new PlusMenuController();
            var vanishRow = vanishSend.Begin(
                PlusMenuKind.Upload, Path.GetFileName(vanishing), null, vanishing);
            vanishSend.Succeed(vanishRow, AttachmentPolicy.Validate(vanishing).Message);
            File.Delete(vanishing);

            var afterDelete = PromptAttachments.Compose("go", vanishSend.ActiveAttachments);
            Assert(afterDelete.AnyRefused,
                "a file deleted between attach and send is REPORTED, not silently skipped");
            Assert(afterDelete.Refused.Any(r =>
                    string.Equals(r.FileName, "gone.md", StringComparison.Ordinal)),
                "the send-time refusal names the file that vanished");
            Assert(!string.IsNullOrWhiteSpace(afterDelete.Refused[0].Message),
                "and carries a readable reason, never an empty failure");
            Assert(!afterDelete.Text.Contains(vanishMarker, StringComparison.Ordinal),
                "no stale copy of a deleted file's content is sent");
            checks += 4;

            // GREW PAST THE LIMIT BETWEEN ATTACH AND SEND. Proves the policy is
            // re-run at send time rather than trusted from pick time.
            var growMarker = $"GROW-{Guid.NewGuid():N}";
            var grower = Path.Combine(sendDir, "grower.txt");
            File.WriteAllText(grower, growMarker);
            var growSend = new PlusMenuController();
            var growRow = growSend.Begin(
                PlusMenuKind.Upload, Path.GetFileName(grower), null, grower);
            growSend.Succeed(growRow, AttachmentPolicy.Validate(grower).Message);

            using (var fs = new FileStream(grower, FileMode.Create, FileAccess.Write))
            {
                fs.SetLength(AttachmentPolicy.MaxBytes + 1024);
            }

            var afterGrowth = PromptAttachments.Compose("go", growSend.ActiveAttachments);
            Assert(afterGrowth.AnyRefused && afterGrowth.Included.Count == 0,
                "a file that grew past the size limit after being attached is refused AT SEND TIME");
            Assert(!afterGrowth.Text.Contains(growMarker, StringComparison.Ordinal),
                "and its earlier, smaller content is not sent from a stale copy");
            checks += 2;

            // TWO FILES BOTH ARRIVE, each distinguishable.
            var firstMarker = $"ONE-{Guid.NewGuid():N}";
            var secondMarker = $"TWO-{Guid.NewGuid():N}";
            var first = Path.Combine(sendDir, "first.json");
            var second = Path.Combine(sendDir, "second.csv");
            File.WriteAllText(first, firstMarker);
            File.WriteAllText(second, secondMarker);

            var pair = new PlusMenuController();
            var firstRow = pair.Begin(PlusMenuKind.Upload, Path.GetFileName(first), null, first);
            pair.Succeed(firstRow, AttachmentPolicy.Validate(first).Message);
            var secondRow = pair.Begin(PlusMenuKind.Upload, Path.GetFileName(second), null, second);
            pair.Succeed(secondRow, AttachmentPolicy.Validate(second).Message);

            var both = PromptAttachments.Compose("compare these", pair.ActiveAttachments);
            Assert(both.Text.Contains(firstMarker, StringComparison.Ordinal)
                && both.Text.Contains(secondMarker, StringComparison.Ordinal),
                "two attachments both reach the model");
            Assert(both.Included.Count == 2, "and both are accounted for as included");
            Assert(both.Text.IndexOf(firstMarker, StringComparison.Ordinal)
                < both.Text.IndexOf(secondMarker, StringComparison.Ordinal),
                "attachments keep the order they were added in");
            checks += 3;

            // A NON-UPLOAD ROW IS NOT AN ATTACHMENT. A succeeded Plugins or
            // Connectors row has no file behind it and must never be opened as one.
            var mixed = new PlusMenuController();
            var pluginRow = mixed.Begin(PlusMenuKind.Plugin, "Plugins");
            mixed.Succeed(pluginRow, "read the registry");
            Assert(pluginRow.SourcePath is null, "a non-upload row has no file behind it");
            Assert(mixed.ActiveAttachments.Count == 0, "and is not counted as an attachment");
            var noFiles = PromptAttachments.Compose("hello", mixed.ActiveAttachments);
            Assert(noFiles.Text == "hello", "so the payload is untouched by it");
            checks += 3;
        }
        finally
        {
            try { Directory.Delete(sendDir, recursive: true); } catch { /* temp dir */ }
        }

        Console.WriteLine($"Helmion plus-menu checks passed ({checks} checks).");

        void AssertDetail(string maestro, PlusMenuKind kind, string mustContain)
        {
            var cap = ProviderCapabilityCatalog.For(maestro)!.First(c => c.Kind == kind);
            Assert(cap.Detail.Contains(mustContain, StringComparison.Ordinal),
                $"{maestro}/{kind} must name '{mustContain}' — that is what makes this menu {maestro}'s and not a generic one");
        }
    }

    private static void Assert(bool condition, string what)
    {
        if (!condition)
        {
            throw new InvalidOperationException($"Plus menu failed: {what}");
        }
    }
}
