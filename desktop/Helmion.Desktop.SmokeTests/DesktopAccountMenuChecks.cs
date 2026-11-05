using Helmion.Desktop.Core;

internal static class DesktopAccountMenuChecks
{
    public static void Run()
    {
        // The account menu mirrors the web app's ACCOUNT_MENU_ITEMS
        // (web/marketing/app/account-menu.mjs): same items, same order,
        // same words.
        var labels = DesktopAccountMenu.Items.Select(i => i.Label).ToArray();
        Assert(labels.SequenceEqual(new[] { "Settings", "Keyboard shortcuts", "Download apps", "Report an issue", "Log out" }),
            "account menu items match the web order and words");
        var ids = DesktopAccountMenu.Items.Select(i => i.Id).ToArray();
        Assert(ids.SequenceEqual(new[] { "settings", "shortcuts", "downloads", "report", "logout" }),
            "account menu ids match the web ids");

        // Report an issue: the web's hand-off is a mailto to the product
        // contact with the default subject "Helmian issue report".
        var href = DesktopAccountMenu.ReportIssueHref();
        Assert(href.StartsWith("mailto:helmianlabs@gmail.com?subject=", StringComparison.Ordinal), "report issue mails the product contact");
        Assert(href.Contains("Helmian%20issue%20report", StringComparison.Ordinal), "report issue carries the default subject");
        Assert(DesktopAccountMenu.ReportIssueHref("Crash on open").Contains("Crash%20on%20open", StringComparison.Ordinal), "report issue subject is encoded");

        // Download apps resolves against the linked origin's download road.
        Assert(DesktopAccountMenu.DownloadsUri(new Uri("https://helmian.cloud")).AbsoluteUri == "https://helmian.cloud/get-started",
            "download apps points at the get-started road");

        // Identity: the desktop's signed-in identity is the Envoy link —
        // the workspace this computer is linked to.
        Assert(DesktopAccountMenu.IdentityHeadline(null) == "Not linked", "unlinked headline says so plainly");
        var link = new EnvoyCloudLink("hdt_" + new string('a', 43), "https://helmian.cloud", "Personal Pilot", DateTimeOffset.UtcNow);
        Assert(DesktopAccountMenu.IdentityHeadline(link) == "Personal Pilot", "linked headline is the workspace name");
        var anonymous = new EnvoyCloudLink("hdt_" + new string('a', 43), "https://helmian.cloud", null, DateTimeOffset.UtcNow);
        Assert(DesktopAccountMenu.IdentityHeadline(anonymous) == "Your account", "nameless link falls back like the web model");
        Assert(DesktopAccountMenu.IdentityDetail(null).Contains("Link this computer", StringComparison.Ordinal), "unlinked detail explains the next step");
        Assert(DesktopAccountMenu.IdentityDetail(link).Contains("helmian.cloud", StringComparison.Ordinal), "linked detail names the cloud host");
        Console.WriteLine("Desktop account menu checks passed.");
    }

    private static void Assert(bool condition, string message)
    {
        if (!condition) throw new InvalidOperationException($"Desktop account menu check failed: {message}");
    }
}
