using Helmion.Desktop.Core;

internal static class EnvoyCloudChatChecks
{
    public static void Run()
    {
        Assert(EnvoyCloudChatClient.NormalizeLinkCode("abcd efgh") == "ABCD-EFGH", "link codes are normalized");
        Assert(EnvoyCloudChatClient.NormalizeLinkCode("ABCD-EFGH") == "ABCD-EFGH", "dashed codes are accepted");
        Assert(EnvoyCloudChatClient.NormalizeLinkCode("ABCD-EFG") is null, "short codes are refused");
        Assert(EnvoyCloudChatClient.NormalizeLinkCode("ABCD-EFG0") is null, "ambiguous characters (0/O/1/I) are refused");
        Assert(EnvoyCloudLinkStore.IsDesktopToken("hdt_" + new string('a', 43)), "desktop tokens are recognized");
        Assert(!EnvoyCloudLinkStore.IsDesktopToken("sk-live-123"), "other secrets are not treated as desktop tokens");
        var threw = false;
        try { _ = new EnvoyCloudChatClient(new HttpClient(), new Uri("http://helmian.cloud")); } catch (ArgumentException) { threw = true; }
        Assert(threw, "plain HTTP cloud origins are refused");
        Console.WriteLine("Envoy cloud chat checks passed.");
    }

    private static void Assert(bool condition, string message)
    {
        if (!condition) throw new InvalidOperationException($"Envoy cloud chat check failed: {message}");
    }
}
