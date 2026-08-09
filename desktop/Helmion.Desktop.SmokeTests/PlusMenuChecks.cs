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
        Assert(entries.Count == 5, "the menu has Connectors, Plugins, Skills, Upload, Permissions");
        Assert(
            entries.Select(e => e.Kind).SequenceEqual(
                [PlusMenuKind.Connector, PlusMenuKind.Plugin, PlusMenuKind.Skill, PlusMenuKind.Upload, PlusMenuKind.Permission]),
            "items appear in order Connectors, Plugins, Skills, Upload, Permissions");
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
            // REMOVE TAKES THE ROW OFF THE LIST. This assertion is the REVERSE of
            // what it was until 2026-07-30, and the reversal is deliberate.
            //
            // It used to require Items.Count == 1 after a remove — the row had to
            // stay visible so undo had something to restore. Troy sent a screenshot
            // of eleven stacked "New project — Removed" bars filling his console and
            // said: "When you hit Remove, those need to go away." The old assertion
            // was pinning the exact behaviour he was complaining about, which is why
            // 267 green checks never caught it: the suite agreed with the defect.
            //
            // Undo still works, and the two checks below prove it — the row comes
            // back into Items, in its original position. Membership in Items is what
            // ActiveAttachments reads, so removal genuinely detaches an upload and
            // undo genuinely re-attaches it.
            Assert(controller.Items.Count == 0, $"{kind}: remove takes the row OFF the list");
            Assert(item.CanUndo, $"{kind}: removed offers undo");
            Assert(controller.Undo(item), $"{kind}: undo works");
            Assert(item.State == PlusActionState.Succeeded, $"{kind}: undo restores the state it had before removal");
            Assert(controller.Items.Count == 1 && ReferenceEquals(controller.Items[0], item),
                $"{kind}: undo puts the row back on the list, not just the state");
            checks += 7;

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

            // Discard drops a removed row for good — no undo left. Since 2026-07-30
            // Remove already takes the row OUT of Items, so Discard's job is now to
            // make that permanent by forgetting the undo position, and it returns
            // false for a row that is not in the Removed state.
            Assert(!controller.Discard(failed), $"{kind}: a failed row is not discarded without being removed first");
            controller.Remove(failed);
            Assert(failed.State == PlusActionState.Removed && !controller.Items.Contains(failed),
                $"{kind}: remove already took the failed row off the list");
            Assert(controller.Discard(failed), $"{kind}: a removed row can be discarded for good");
            Assert(!controller.Items.Contains(failed), $"{kind}: a discarded row is not on the list");
            checks += 4;
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
            Assert(caps!.Count == 5, $"{name} exposes five kinds (connectors/plugins/skills/upload/permissions)");
            Assert(caps.Select(c => c.Kind).Distinct().Count() == 5, $"{name} has no duplicate kinds");
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

            var imagePath = Path.Combine(sendDir, "vision.png");
            File.WriteAllBytes(imagePath, Convert.FromBase64String(
                "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="));
            var imageSend = new PlusMenuController();
            var imageRow = imageSend.Begin(PlusMenuKind.Upload, "vision.png", null, imagePath);
            imageSend.Succeed(imageRow, AttachmentPolicy.Validate(imagePath).Message);
            var geminiImage = PromptAttachments.Compose("describe this", imageSend.ActiveAttachments, "Gemini");
            Assert(geminiImage.Images.Count == 1
                && geminiImage.Images[0].MediaType == "image/png"
                && geminiImage.Images[0].Base64Data.Length > 0,
                "a real PNG becomes bounded base64 vision input for Gemini");
            var grokImage = PromptAttachments.Compose("describe this", imageSend.ActiveAttachments, "Grok");
            Assert(grokImage.Images.Count == 0 && grokImage.AnyRefused
                && grokImage.Refused[0].Message.Contains("no approved Helmion vision adapter", StringComparison.Ordinal),
                "a provider without an approved vision adapter is refused truthfully");
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

        // --- 7. SKILLS AND PLUGINS USE THE PAYLOAD THEY FETCH ------------------
        //
        // THE DEFECT THIS SECTION EXISTS FOR, and it is the same shape as the
        // Upload defect one section above: the row does real work, throws the
        // result away, and shows a sentence written at compile time.
        //
        //   Skills  — MainWindow.PlusMenu.cs:169 called ListCommandsAsync() with NO
        //             workspace, so the bridge answered about the Helmion repo root
        //             rather than the registered workspace (AgentBridge.cs:236-245
        //             says so in its own docs, and the other caller at
        //             MainWindow.xaml.cs:2328 already passed it). Then :171-181 read
        //             ONLY ev.Event and emitted a fixed string. ev.Commands — the
        //             real, freshly re-scanned command list — was never touched, so
        //             an empty workspace and a workspace with fifty skills produced
        //             byte-identical output.
        //
        //   Plugins — FirstRunStates.cs:78-95 stat()ed .helmion/plugins.json and
        //             printed its SIZE IN BYTES. It never parsed the file, never
        //             named a plugin, and never showed which MCP servers the install
        //             gate refused — the one fact on the whole screen that is a
        //             security decision.
        //
        // WHY THESE ASSERTIONS CANNOT PASS BY ACCIDENT. Every name asserted below is
        // a GUID generated at run time, so nothing here can be satisfied by a
        // literal written into the product. An assertion passes only if the value
        // travelled from the event into the sentence the operator reads.
        var skillName = $"deploy-{Guid.NewGuid():N}";
        var otherSkill = $"rollback-{Guid.NewGuid():N}";
        var scanned = Path.Combine(Path.GetTempPath(), $"ws-{Guid.NewGuid():N}");

        var listed = new AgentBridgeEvent(
            "commands",
            Workspace: scanned,
            Commands:
            [
                new AgentSlashCommand(skillName, "ship it", null, "project", "a.md", true),
                new AgentSlashCommand(otherSkill, null, null, "user", "b.md", true),
            ]);

        var skills = BridgeCapabilitySummary.Skills(listed, scanned);
        Assert(skills.State == PlusActionState.Succeeded, "a workspace with commands settles as a success");
        Assert(skills.Message.Contains(skillName, StringComparison.Ordinal),
            "the skills row names an ACTUAL command from the payload, not a fixed sentence");
        Assert(skills.Message.Contains(otherSkill, StringComparison.Ordinal),
            "and does not stop at the first one");
        Assert(skills.Message.Contains("2", StringComparison.Ordinal),
            "the skills row states how many were found, so the number is checkable");
        Assert(skills.Message.Contains(scanned, StringComparison.Ordinal),
            "the skills row names the FOLDER that was scanned — the D2 bug was a listing "
            + "that described a different project than the next turn would run in");
        checks += 5;

        // A command the bridge marks non-invocable is not offered as one to type.
        var hidden = $"internal-{Guid.NewGuid():N}";
        var withHidden = new AgentBridgeEvent(
            "commands",
            Workspace: scanned,
            Commands:
            [
                new AgentSlashCommand(skillName, null, null, "project", "a.md", true),
                new AgentSlashCommand(hidden, null, null, "project", "h.md", false),
            ]);
        var visible = BridgeCapabilitySummary.Skills(withHidden, scanned);
        Assert(!visible.Message.Contains(hidden, StringComparison.Ordinal),
            "a command the bridge marks non-invocable is not offered to the user as typeable");
        checks += 1;

        // ZERO COMMANDS IS EMPTY, NOT "Skills loaded". The old fixed string claimed
        // success over an empty registry, which is the same small lie the Empty
        // state was introduced to stop everywhere else on this menu.
        var noneListed = new AgentBridgeEvent("commands", Workspace: scanned, Commands: []);
        var emptySkills = BridgeCapabilitySummary.Skills(noneListed, scanned);
        Assert(emptySkills.State == PlusActionState.Empty,
            "a workspace with no commands is EMPTY, not a success claiming skills loaded");
        Assert(!emptySkills.IsRed, "and an empty command list draws no red");
        Assert(emptySkills.Message.Contains("SKILL.md", StringComparison.Ordinal),
            "the empty skills row still says what would put something there");
        checks += 3;

        // THE BRIDGE ANSWERED ABOUT A DIFFERENT FOLDER THAN THE ONE ASKED FOR.
        // Silently rendering that as success is how a listing describes the wrong
        // project while looking perfectly healthy.
        var elsewhere = Path.Combine(Path.GetTempPath(), $"other-{Guid.NewGuid():N}");
        var wrongFolder = new AgentBridgeEvent(
            "commands",
            Workspace: elsewhere,
            Commands: [new AgentSlashCommand(skillName, null, null, "project", "a.md", true)]);
        var mismatch = BridgeCapabilitySummary.Skills(wrongFolder, scanned);
        Assert(mismatch.Message.Contains(elsewhere, StringComparison.Ordinal)
            && mismatch.Message.Contains(scanned, StringComparison.Ordinal),
            "when the bridge answers about a different folder than the one asked for, the row names BOTH");
        checks += 1;

        // A non-commands answer is a real failure and keeps carrying its reason.
        var broke = BridgeCapabilitySummary.Skills(
            new AgentBridgeEvent("error", Message: "spawn ENOENT"), scanned);
        Assert(broke.State == PlusActionState.Failed, "a bridge error is a genuine failure");
        Assert(broke.Message.Contains("spawn ENOENT", StringComparison.Ordinal),
            "and the bridge's own words survive into the row instead of a generic sentence");
        checks += 2;

        // --- PLUGINS: THE REFUSALS ARE THE POINT -------------------------------
        var pluginName = $"acme-{Guid.NewGuid():N}";
        var approvedServer = $"sqlite-{Guid.NewGuid():N}";
        var refusedServer = $"scraper-{Guid.NewGuid():N}";
        var refusalReason = $"never approved: no baseline {Guid.NewGuid():N}";
        var warning = $"commands/ is in the wrong place {Guid.NewGuid():N}";

        var loaded = new AgentBridgeEvent(
            "commands",
            Workspace: scanned,
            PluginDetails:
            [
                new AgentPluginInfo(
                    pluginName,
                    Root: @"C:\plugins\acme",
                    Version: "2.1.0",
                    HasCommands: true,
                    ApprovedMcpServers: [approvedServer],
                    RefusedMcpServers: [new AgentMcpRefusal(refusedServer, refusalReason)],
                    Warnings: [warning]),
            ]);

        var plugins = BridgeCapabilitySummary.Plugins(loaded, scanned);
        Assert(plugins.Message.Contains(pluginName, StringComparison.Ordinal),
            "the plugins row NAMES the installed plugin instead of reporting a file size");
        Assert(plugins.Message.Contains("2.1.0", StringComparison.Ordinal),
            "and its version");
        Assert(plugins.Message.Contains(refusedServer, StringComparison.Ordinal),
            "the MCP server the install gate REFUSED is named on screen");
        Assert(plugins.Message.Contains(refusalReason, StringComparison.Ordinal),
            "with the gate's own reason — a refusal with no reason teaches nobody why");
        Assert(plugins.Message.Contains(approvedServer, StringComparison.Ordinal),
            "an approved server is named too, so approved and refused are distinguishable");
        Assert(plugins.Message.Contains(warning, StringComparison.Ordinal),
            "and the loader's warnings are surfaced rather than swallowed");
        checks += 6;

        // A refusal must never be reported as a plain success. Something the user
        // installed is not running, and the row has to say so in words.
        Assert(plugins.Message.Contains("REFUSED", StringComparison.Ordinal),
            "the row uses the word REFUSED, so the security decision is readable at a glance");
        checks += 1;

        // NO PLUGINS IS EMPTY, and still says what would put one there.
        var noPlugins = new AgentBridgeEvent("commands", Workspace: scanned, PluginDetails: []);
        var emptyPlugins = BridgeCapabilitySummary.Plugins(noPlugins, scanned);
        Assert(emptyPlugins.State == PlusActionState.Empty,
            "a workspace with no plugins is EMPTY, not a success over an empty registry");
        Assert(!emptyPlugins.IsRed, "and draws no red on a fresh workspace");
        Assert(emptyPlugins.Message.Contains("helmion plugin add", StringComparison.Ordinal),
            "the empty plugins row still names the command that installs one");
        checks += 3;

        var pluginError = BridgeCapabilitySummary.Plugins(
            new AgentBridgeEvent("error", Message: "bridge closed stdout"), scanned);
        Assert(pluginError.State == PlusActionState.Failed
            && pluginError.Message.Contains("bridge closed stdout", StringComparison.Ordinal),
            "a bridge error while listing plugins is a failure carrying the bridge's own words");
        checks += 1;

        // --- 7b. THE ROW SAYS WHAT PRESSING IT DOES ----------------------------
        //
        // A row headed "Connectors (MCP)" over the line `claude mcp add <name> --
        // <command>` reads as a button that adds a connector. It is not one. It runs
        // a GitHub search and CANNOT install anything, because approval needs a
        // human at a real terminal (src/core/mcp-approval.mjs:80-89) and a window has
        // none. That gate is a decision, not a gap — so the row has to stop
        // advertising a capability it will never have.
        foreach (var name in builtIns)
        {
            foreach (var cap in ProviderCapabilityCatalog.For(name)!)
            {
                Assert(cap.Detail.Contains("PRESSING THIS ROW", StringComparison.Ordinal),
                    $"{name}/{cap.Kind} states what pressing it does, not only what that CLI can do");
                checks += 1;
            }

            var connector = ProviderCapabilityCatalog.For(name)!.First(c => c.Kind == PlusMenuKind.Connector);
            Assert(connector.Detail.Contains("does NOT install or connect", StringComparison.Ordinal),
                $"{name}'s connector row says plainly that pressing it does not connect anything");
            Assert(connector.Detail.Contains("helmion mcp-install", StringComparison.Ordinal),
                $"{name}'s connector row names where approval actually happens instead of leaving a dead end");

            var plugin = ProviderCapabilityCatalog.For(name)!.First(c => c.Kind == PlusMenuKind.Plugin);
            Assert(plugin.Detail.Contains("does not install one", StringComparison.Ordinal)
                && plugin.Detail.Contains("helmion plugin add", StringComparison.Ordinal),
                $"{name}'s plugin row says it lists rather than installs, and names the command that installs");

            var skill = ProviderCapabilityCatalog.For(name)!.First(c => c.Kind == PlusMenuKind.Skill);
            Assert(skill.Detail.Contains("does not create one", StringComparison.Ordinal),
                $"{name}'s skills row says it lists rather than creates");
            checks += 4;

            // The provider's own documented syntax must SURVIVE the addition. If
            // appending Helmion's sentence ever displaces it, the menu has stopped
            // being that provider's menu, which was the whole requirement.
            Assert(connector.Detail.Contains(connector.HowItWorks, StringComparison.Ordinal),
                $"{name}'s connector row still carries that CLI's own syntax verbatim");
            checks += 1;
        }

        // AND THE STATE CHIP STOPS SAYING "Added" OVER THINGS NOTHING WAS ADDED TO.
        // The chip is the first thing read on a settled row; "Added" over a list of
        // GitHub search results is a lie in the one place meant to report the truth.
        var words = new PlusMenuController();
        var searched = words.Begin(PlusMenuKind.Connector, "Connector search", successWord: "Found");
        words.Succeed(searched, "five candidates on GitHub");
        Assert(searched.StateText == "Found",
            "a connector SEARCH settles as Found — nothing was added, so it must not say Added");
        var listedRow = words.Begin(PlusMenuKind.Skill, "Skills", successWord: "Listed");
        words.Succeed(listedRow, "three skills");
        Assert(listedRow.StateText == "Listed", "a skills LISTING settles as Listed");
        var uploaded = words.Begin(PlusMenuKind.Upload, "notes.md");
        words.Succeed(uploaded, "attached");
        Assert(uploaded.StateText == "Added",
            "an upload still says Added, because that one genuinely does add something");
        var blankWord = words.Begin(PlusMenuKind.Plugin, "p", successWord: "   ");
        words.Succeed(blankWord, "x");
        Assert(blankWord.StateText == "Added", "a blank success word falls back rather than rendering empty");
        checks += 4;

        // --- 8. END TO END, THROUGH THE REAL NODE BRIDGE -----------------------
        //
        // Everything above proves the SUMMARY is honest about an event it is
        // handed. This proves the EVENT is real: a command file written to disk
        // here, discovered by the actual `helmion agent-bridge` node process, and
        // arriving in the sentence the operator reads. Disk → node → C# → row.
        //
        // No API key is involved: bridge.mjs:299-301 deliberately keeps `commands`
        // off the configure path precisely so listing needs no model.
        var liveRoot = Path.Combine(Path.GetTempPath(), $"helmion-live-{Guid.NewGuid():N}");
        var liveCommand = $"e2e-{Guid.NewGuid():N}";
        Directory.CreateDirectory(Path.Combine(liveRoot, ".helmion", "commands"));
        try
        {
            File.WriteAllText(
                Path.Combine(liveRoot, ".helmion", "commands", $"{liveCommand}.md"),
                "---\ndescription: written by the smoke suite\n---\nrun the thing\n");

            using var bridge = new AgentBridge();
            using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(90));
            var ev = bridge.ListCommandsAsync(liveRoot, cts.Token).GetAwaiter().GetResult();

            Assert(ev.Event == "commands",
                $"the real agent-bridge answers a commands request (got '{ev.Event}': {ev.Message})");
            Assert(ev.Commands is not null && ev.Commands.Any(c =>
                    string.Equals(c.Name, liveCommand, StringComparison.Ordinal)),
                "a command file written to disk a moment ago comes back from the REAL bridge");

            var live = BridgeCapabilitySummary.Skills(ev, liveRoot);
            Assert(live.Message.Contains(liveCommand, StringComparison.Ordinal),
                "and its name reaches the sentence the operator actually reads — disk to screen");
            Assert(live.State == PlusActionState.Succeeded, "a workspace with a real command is a success");
            checks += 4;
        }
        finally
        {
            try { Directory.Delete(liveRoot, recursive: true); } catch { /* temp dir */ }
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
