using System.Text.Json;
using System.Text.Json.Serialization;

namespace Helmion.Desktop.Core;

/// <summary>
/// The PC bridge's half of the desktop link — the meeting point the chain
/// was missing. The desktop's link (EnvoyCloudLinkStore) keeps the token
/// DPAPI-sealed for this app's own chat pane, but the bridge
/// (bin/pc-bridge.mjs) reads its pairing from a plain file,
/// %APPDATA%\Helmian\pc-bridge-token.json, in the exact
/// { token, tenantId } shape its own first-run pairing writes. Until this
/// class existed the two stores never met: linking the desktop paired the
/// chat pane and nothing else, so no bridge on the PC ever held a token —
/// it reported no presence, claimed no profile-sync jobs, and answered no
/// turns as this computer. Save mirrors a fresh link into the bridge's
/// file; Clear removes it, so log out ends the bridge's access with the
/// chat pane's, under the same revoke.
/// </summary>
public static class BridgeLinkFile
{
    public static string DefaultPath() => Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "Helmian", "pc-bridge-token.json");

    /// <summary>The bridge token file's shape, key for key as bin/pc-bridge.mjs writes and reads it.</summary>
    public sealed record Shape(
        [property: JsonPropertyName("token")] string Token,
        [property: JsonPropertyName("tenantId")] string? TenantId);

    /// <summary>
    /// The file body for a link. EnvoyCloudLink.Organization carries the
    /// tenant id the link exchange returned (EnvoyCloudChatClient.LinkAsync
    /// maps the reply's TenantId into it), which is exactly the bridge's
    /// tenantId field.
    /// </summary>
    public static string Serialize(EnvoyCloudLink link)
    {
        ArgumentNullException.ThrowIfNull(link);
        return JsonSerializer.Serialize(new Shape(link.Token, link.Organization));
    }

    /// <summary>
    /// Write the bridge's token file for a link. Best effort by design:
    /// a bridge file that cannot be written must never fail the link
    /// itself — the chat pane stays linked and a later start can heal it.
    /// A value that is not a desktop token is never written.
    /// </summary>
    public static void Save(EnvoyCloudLink link, string? path = null)
    {
        ArgumentNullException.ThrowIfNull(link);
        if (!EnvoyCloudLinkStore.IsDesktopToken(link.Token)) return;
        try
        {
            var target = path ?? DefaultPath();
            Directory.CreateDirectory(Path.GetDirectoryName(target)!);
            File.WriteAllText(target, Serialize(link));
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            // The link stands; the bridge file is a mirror, not the link.
        }
    }

    /// <summary>Remove the bridge's token file (log out). Best effort, like Save.</summary>
    public static void Clear(string? path = null)
    {
        try
        {
            var target = path ?? DefaultPath();
            if (File.Exists(target)) File.Delete(target);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            // Nothing better to do: the server-side revoke already ended
            // the token's authority (the log-out path revokes first).
        }
    }
}
