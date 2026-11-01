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
        Assert(EnvoyCloudChatClient.DescribeAuthor("agent:claude", "agent") == "Claude", "built-in agent Claude is described");
        Assert(EnvoyCloudChatClient.DescribeAuthor("agent:mistral", "agent") == "Mistral Le Chat", "Mistral Le Chat is described");
        Assert(EnvoyCloudChatClient.DescribeAuthor("agent:custom:rusty", "agent") == "@rusty", "custom Envoy agent handle is described");
        Assert(EnvoyCloudChatClient.DescribeAuthor("discord:123456:Troy", "human") == "Troy · Discord", "Discord mirrored author is described");
        Assert(EnvoyCloudChatClient.DescribeAuthor("slack:U0ABC:Troy", "human") == "Troy · Slack", "Slack mirrored author is described");
        var client = new EnvoyCloudChatClient(new HttpClient(), new Uri("https://helmian.cloud"));
        Assert(client.BuildFullCloneUri("chan_42").AbsoluteUri == "https://helmian.cloud/app?channel=chan_42#desktop", "full clone URI carries channel deep-link");
        Console.WriteLine("Envoy cloud chat checks passed.");
    }

    private static void Assert(bool condition, string message)
    {
        if (!condition) throw new InvalidOperationException($"Envoy cloud chat check failed: {message}");
    }
}
