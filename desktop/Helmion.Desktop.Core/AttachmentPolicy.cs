namespace Helmion.Desktop.Core;

/// <summary>Why an attachment was refused. <see cref="None"/> means it was accepted.</summary>
public enum AttachmentRejection
{
    None = 0,
    Missing,
    Empty,
    TooLarge,
    UnsupportedType,
    Unreadable,
}

/// <summary>
/// The answer to "can this file be attached", with a sentence a human can act on.
/// <see cref="Message"/> is never empty, including on success, because the composer
/// shows it either way.
/// </summary>
public sealed record AttachmentDecision(
    bool Accepted,
    AttachmentRejection Rejection,
    string Message,
    string FileName,
    long Bytes);

/// <summary>
/// Decides whether a file may be attached to a prompt, and says why in words.
///
/// TROY'S REQUIREMENT, VERBATIM: "handle file-too-large and unsupported-file-type
/// with a clear visible message. Never a silent failure."
///
/// So there is no boolean return anywhere in this file. Every path produces an
/// <see cref="AttachmentDecision"/> carrying a sentence, and the caller has
/// nothing else to display — it cannot accidentally swallow a refusal, because
/// there is no shape it could swallow it into.
///
/// Pure and filesystem-light on purpose: the size and existence come from a
/// <see cref="FileInfo"/> the caller supplies, so the whole policy can be proven
/// against temp files in the smoke suite without a window or a file dialog.
/// </summary>
public static class AttachmentPolicy
{
    /// <summary>
    /// Cap on one attachment. A prompt is text sent to a model — this is not a
    /// file store — and a model's context is measured in tokens, not megabytes.
    /// 5 MB of text is already far past any context window that exists, so a
    /// bigger file is not a limitation being imposed, it is a file that was never
    /// going to work.
    /// </summary>
    public const long MaxBytes = 5 * 1024 * 1024;

    /// <summary>
    /// What can be attached: text a model can actually read.
    ///
    /// This is an ALLOW-LIST, not a deny-list. A deny-list of "bad" extensions is
    /// a list you are always one new format behind on, and the failure direction
    /// is that something unreadable gets attached and the model is handed binary
    /// noise it will confidently describe. An allow-list fails the other way — a
    /// legitimate format is refused with a message naming exactly what is
    /// allowed, and the fix is one entry here.
    /// </summary>
    public static readonly IReadOnlySet<string> AllowedExtensions =
        new HashSet<string>(StringComparer.OrdinalIgnoreCase)
        {
            ".txt", ".md", ".markdown", ".log", ".csv", ".tsv",
            ".json", ".jsonl", ".yaml", ".yml", ".toml", ".ini", ".env",
            ".xml", ".html", ".htm", ".css",
            ".js", ".mjs", ".cjs", ".jsx", ".ts", ".tsx",
            ".cs", ".csproj", ".sln", ".slnx", ".fs", ".vb",
            ".py", ".rb", ".go", ".rs", ".java", ".kt", ".swift",
            ".c", ".h", ".cpp", ".hpp", ".sql", ".sh", ".ps1", ".bat", ".psm1",
            ".xaml", ".razor", ".vue", ".svelte", ".graphql", ".proto",
            ".gitignore", ".gitattributes", ".editorconfig", ".dockerfile",
            ".png", ".jpg", ".jpeg", ".webp",
        };

    /// <summary>A human-readable size. Used in the refusal sentences.</summary>
    public static string DescribeSize(long bytes)
    {
        if (bytes >= 1024L * 1024L) return $"{bytes / (1024.0 * 1024.0):0.#} MB";
        if (bytes >= 1024L) return $"{bytes / 1024.0:0.#} KB";
        return $"{bytes} bytes";
    }

    /// <summary>A short, readable list of what IS allowed, for the refusal message.</summary>
    public static string AllowedSummary =>
        "text/code files such as .md, .txt, .json and source files, plus bounded PNG, JPEG, and WebP images when the selected provider supports vision";

    public static bool IsImage(string? path) =>
        Path.GetExtension(path ?? string.Empty).ToLowerInvariant() is ".png" or ".jpg" or ".jpeg" or ".webp";

    public static string? ImageMediaType(string? path) =>
        Path.GetExtension(path ?? string.Empty).ToLowerInvariant() switch
        {
            ".png" => "image/png",
            ".jpg" or ".jpeg" => "image/jpeg",
            ".webp" => "image/webp",
            _ => null,
        };

    public static bool ProviderSupportsImages(string? provider) =>
        (provider ?? string.Empty).Trim().ToLowerInvariant() is
            "openai" or "chatgpt" or "claude" or "anthropic" or "gemini";

    public static AttachmentDecision Validate(string? path)
    {
        if (string.IsNullOrWhiteSpace(path))
        {
            return new AttachmentDecision(
                false, AttachmentRejection.Missing,
                "No file was chosen.", string.Empty, 0);
        }

        FileInfo info;
        try
        {
            info = new FileInfo(path);
        }
        catch (Exception ex)
        {
            // A path the OS refuses to even parse. Named, not swallowed.
            return new AttachmentDecision(
                false, AttachmentRejection.Unreadable,
                $"That path could not be read: {ex.Message}", path, 0);
        }

        var name = info.Name;

        if (!info.Exists)
        {
            return new AttachmentDecision(
                false, AttachmentRejection.Missing,
                $"\"{name}\" no longer exists at that location.", name, 0);
        }

        // ORDER MATTERS AND IT IS DELIBERATE. Size is checked before type because
        // a 900 MB .zip should be told it is too large AND the wrong type, and the
        // size is the more actionable of the two — but an EMPTY file is checked
        // first of all, because "0 bytes" explains itself and a type complaint
        // about an empty file is noise.
        if (info.Length == 0)
        {
            return new AttachmentDecision(
                false, AttachmentRejection.Empty,
                $"\"{name}\" is empty — there is nothing in it to send.", name, 0);
        }

        if (info.Length > MaxBytes)
        {
            return new AttachmentDecision(
                false, AttachmentRejection.TooLarge,
                $"\"{name}\" is {DescribeSize(info.Length)}, over the "
                + $"{DescribeSize(MaxBytes)} limit for one attachment. "
                + "Send the relevant section instead, or split the file.",
                name, info.Length);
        }

        var extension = info.Extension;
        if (string.IsNullOrEmpty(extension) || !AllowedExtensions.Contains(extension))
        {
            var what = string.IsNullOrEmpty(extension)
                ? "has no file extension"
                : $"is a {extension} file";
            return new AttachmentDecision(
                false, AttachmentRejection.UnsupportedType,
                $"\"{name}\" {what}, which cannot be attached. Helmion attaches "
                + $"{AllowedSummary}.",
                name, info.Length);
        }

        return new AttachmentDecision(
            true, AttachmentRejection.None,
            $"\"{name}\" attached · {DescribeSize(info.Length)}.",
            name, info.Length);
    }
}
