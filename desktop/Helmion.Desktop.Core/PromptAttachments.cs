namespace Helmion.Desktop.Core;

/// <summary>
/// What happened to one attachment when the prompt was built.
/// </summary>
/// <param name="Included">
/// False means the file did NOT go to the model. It is never silently dropped —
/// <paramref name="Message"/> carries the reason and the caller turns it into a
/// visible failed row.
/// </param>
public sealed record AttachmentInclusion(
    string FileName,
    string Path,
    bool Included,
    string Message);

/// <summary>
/// The text that actually goes on the wire, plus a per-file account of what made
/// it in. <see cref="Text"/> is the ONLY thing sent; anything not in it did not
/// reach the model, whatever the row on screen said.
/// </summary>
public sealed record OutgoingPrompt(
    string Text,
    IReadOnlyList<AttachmentInclusion> Inclusions)
{
    public bool AnyRefused => Inclusions.Any(inclusion => !inclusion.Included);

    public IReadOnlyList<AttachmentInclusion> Refused =>
        Inclusions.Where(inclusion => !inclusion.Included).ToList();

    public IReadOnlyList<AttachmentInclusion> Included =>
        Inclusions.Where(inclusion => inclusion.Included).ToList();
}

/// <summary>
/// Builds the outgoing prompt from the typed text plus whatever the + menu
/// attached.
///
/// THIS EXISTS BECAUSE UPLOAD WAS DECORATIVE. The + menu validated a file, drew a
/// green "attached" row, and then dropped the path on the floor: nothing read
/// <see cref="PlusMenuController.ActiveAttachments"/>, and the send path passed
/// the typed text alone. The user was told the model had their file. It did not.
/// That is the worst failure mode in the app, because it is silent and it looks
/// like success.
///
/// WHY INLINE RATHER THAN A NEW BRIDGE FIELD. The alternative was a separate
/// field on the agent-bridge protocol that Node would read. That is the larger,
/// less reversible option: it edits `src/agent/bridge.mjs`, and it puts the EXE
/// and the Node CLI on different protocol versions, so an old bridge silently
/// ignores attachments — the very bug being fixed, one layer down. Inlining is
/// desktop-only and reverts by deleting one call at the send seam.
///
/// RE-VALIDATED AT SEND TIME, NOT ONLY AT PICK TIME. A file can be edited,
/// deleted, or grown past the limit between the moment it is attached and the
/// moment Enter is pressed. Re-running <see cref="AttachmentPolicy"/> here is what
/// stops the composer sending stale content, or nothing at all, while the row on
/// screen still reads "Added".
/// </summary>
public static class PromptAttachments
{
    /// <summary>Opens the block that holds one attached file's contents.</summary>
    public const string OpenMarker = "----- attached file: ";

    /// <summary>Closes it.</summary>
    public const string CloseMarker = "----- end of attached file: ";

    /// <summary>
    /// The typed text with every live attachment's CONTENTS appended.
    ///
    /// With no attachments the text is returned byte-for-byte unchanged, so a
    /// session that never touches the + button sends exactly what it sent before
    /// this file existed.
    /// </summary>
    public static OutgoingPrompt Compose(
        string? text,
        IReadOnlyList<PlusActionItem>? attachments)
    {
        var typed = text ?? string.Empty;

        if (attachments is null || attachments.Count == 0)
        {
            return new OutgoingPrompt(typed, []);
        }

        var inclusions = new List<AttachmentInclusion>();
        var body = new System.Text.StringBuilder(typed);

        foreach (var item in attachments)
        {
            // Anything that is not a live upload with a path behind it is not a
            // file, and must not be opened as one.
            if (item is null
                || item.Kind != PlusMenuKind.Upload
                || item.State != PlusActionState.Succeeded
                || string.IsNullOrWhiteSpace(item.SourcePath))
            {
                continue;
            }

            var path = item.SourcePath;

            // RE-VALIDATED HERE, not trusted from pick time. Between the file
            // dialog and this moment the file can have been deleted, emptied, or
            // grown past the cap, and the row on screen would still read "Added".
            var decision = AttachmentPolicy.Validate(path);
            if (!decision.Accepted)
            {
                inclusions.Add(new AttachmentInclusion(
                    decision.FileName.Length > 0 ? decision.FileName : item.Title,
                    path,
                    false,
                    decision.Message));
                continue;
            }

            string contents;
            try
            {
                contents = File.ReadAllText(path);
            }
            catch (Exception ex)
            {
                // Named, never swallowed. A file we validated a millisecond ago
                // and then could not read is exactly the case that used to
                // disappear.
                inclusions.Add(new AttachmentInclusion(
                    decision.FileName,
                    path,
                    false,
                    $"\"{decision.FileName}\" could not be read: {ex.Message}"));
                continue;
            }

            body.AppendLine();
            body.AppendLine();
            body.AppendLine(
                $"{OpenMarker}{decision.FileName} ({AttachmentPolicy.DescribeSize(decision.Bytes)}) -----");
            body.AppendLine(contents.TrimEnd('\r', '\n'));
            body.AppendLine($"{CloseMarker}{decision.FileName} -----");

            inclusions.Add(new AttachmentInclusion(
                decision.FileName,
                path,
                true,
                decision.Message));
        }

        // Nothing made it in: send the typed text untouched rather than a prompt
        // trailing empty ceremony. The refusals still travel back to the caller.
        return inclusions.Any(inclusion => inclusion.Included)
            ? new OutgoingPrompt(body.ToString(), inclusions)
            : new OutgoingPrompt(typed, inclusions);
    }
}
