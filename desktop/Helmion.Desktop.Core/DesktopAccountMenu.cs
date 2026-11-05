namespace Helmion.Desktop.Core;

/// <summary>One entry in the desktop account menu (id + label, web words).</summary>
public sealed record DesktopAccountMenuItem(string Id, string Label);

/// <summary>
/// The desktop account menu model — the parity twin of the web app's
/// account menu (web/marketing/app/account-menu.mjs, ACCOUNT_MENU_ITEMS).
/// Same items, same order, same words: Settings, Keyboard shortcuts,
/// Download apps, Report an issue, Log out. The desktop's identity is the
/// Envoy cloud link (an 8-character code exchanged for a desktop token),
/// not a Clerk session, so the identity half reads the link: who is signed
/// in here is the workspace this computer is linked to. Log out on the
/// desktop is the link road's end: revoke the desktop token on the server
/// (POST /api/admin/desktop/link/revoke) and clear the local copy, so
/// signing out ends access — the same guarantee the web's sign-out gives.
/// </summary>
public static class DesktopAccountMenu
{
    public static readonly IReadOnlyList<DesktopAccountMenuItem> Items = Array.AsReadOnly(new[]
    {
        new DesktopAccountMenuItem("settings", "Settings"),
        new DesktopAccountMenuItem("shortcuts", "Keyboard shortcuts"),
        new DesktopAccountMenuItem("downloads", "Download apps"),
        new DesktopAccountMenuItem("report", "Report an issue"),
        new DesktopAccountMenuItem("logout", "Log out"),
    });

    /// <summary>The product's issue contact — the same address the web's Report-an-issue hand-off mails.</summary>
    public const string IssueContact = "helmianlabs@gmail.com";

    /// <summary>The mailto the web builds in reportIssueHref(): default subject "Helmian issue report".</summary>
    public static string ReportIssueHref(string? subject = null)
    {
        var title = string.IsNullOrWhiteSpace(subject) ? "Helmian issue report" : subject.Trim();
        return $"mailto:{IssueContact}?subject={Uri.EscapeDataString(title)}";
    }

    /// <summary>
    /// Where Download apps points: the site's own download road
    /// (get-started reads the same /api/latest-release pipeline as the web's
    /// Download apps panel), resolved against the linked cloud origin.
    /// </summary>
    public static Uri DownloadsUri(Uri origin) => new(origin, "/get-started");

    /// <summary>
    /// The identity headline, mirroring the web's accountIdentityModel
    /// fallback order (name, then email, then "Your account") with the one
    /// identity the desktop holds: the linked workspace's organization.
    /// An unlinked desktop says so plainly.
    /// </summary>
    public static string IdentityHeadline(EnvoyCloudLink? link)
    {
        if (link is null) return "Not linked";
        return string.IsNullOrWhiteSpace(link.Organization) ? "Your account" : link.Organization.Trim();
    }

    /// <summary>The detail line under the headline on the Settings identity card.</summary>
    public static string IdentityDetail(EnvoyCloudLink? link)
    {
        if (link is null) return "Link this computer from Team Chat to connect your workspace.";
        var host = new Uri(link.Origin).Host;
        return $"Linked to {host} · {link.LinkedAt.ToLocalTime():MMM d, yyyy}";
    }
}
