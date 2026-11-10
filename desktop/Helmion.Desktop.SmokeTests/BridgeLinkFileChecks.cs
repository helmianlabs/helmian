using System.Text.Json;
using Helmion.Desktop.Core;

internal static class BridgeLinkFileChecks
{
    public static void Run()
    {
        // The bridge token file is the meeting point between the desktop's
        // link and bin/pc-bridge.mjs: same folder the bridge reads
        // (%APPDATA%\Helmian), same file name, same { token, tenantId }
        // shape its own pairing writes (loadToken/pairWithCode).
        Assert(BridgeLinkFile.DefaultPath().EndsWith(Path.Combine("Helmian", "pc-bridge-token.json"), StringComparison.Ordinal),
            "bridge token file lives where the bridge reads it");

        var tenantId = "0d7ca4d3-a2f4-458a-936b-d8a002a569e0";
        var token = "hdt_" + new string('a', 43);
        var link = new EnvoyCloudLink(token, "https://helmian.cloud", tenantId, DateTimeOffset.UtcNow);

        // Serialize: exactly the two keys the bridge reads, tenant id
        // carried from the link exchange (EnvoyCloudLink.Organization).
        using (var doc = JsonDocument.Parse(BridgeLinkFile.Serialize(link)))
        {
            var names = doc.RootElement.EnumerateObject().Select(p => p.Name).OrderBy(n => n).ToArray();
            Assert(names.SequenceEqual(new[] { "tenantId", "token" }), "bridge token file carries exactly token and tenantId");
            Assert(doc.RootElement.GetProperty("token").GetString() == token, "bridge token file carries the desktop token");
            Assert(doc.RootElement.GetProperty("tenantId").GetString() == tenantId, "bridge token file carries the tenant id");
        }

        // Save/Load round trip against a scratch path: the file the
        // desktop writes is the file the bridge would read.
        var scratch = Path.Combine(Path.GetTempPath(), $"helmian-bridge-link-{Guid.NewGuid():N}", "pc-bridge-token.json");
        BridgeLinkFile.Save(link, scratch);
        Assert(File.Exists(scratch), "save writes the bridge token file");
        using (var doc = JsonDocument.Parse(File.ReadAllText(scratch)))
        {
            Assert(doc.RootElement.GetProperty("token").GetString() == token, "saved file reads back the token");
        }

        // A value that is not a desktop token is never mirrored.
        var impostor = new EnvoyCloudLink("not-a-desktop-token", "https://helmian.cloud", tenantId, DateTimeOffset.UtcNow);
        var impostorPath = Path.Combine(Path.GetTempPath(), $"helmian-bridge-link-{Guid.NewGuid():N}", "pc-bridge-token.json");
        BridgeLinkFile.Save(impostor, impostorPath);
        Assert(!File.Exists(impostorPath), "a non-desktop token is never written to the bridge file");

        // Clear removes the file (log out), and clearing twice is fine.
        BridgeLinkFile.Clear(scratch);
        Assert(!File.Exists(scratch), "clear removes the bridge token file");
        BridgeLinkFile.Clear(scratch);

        Console.WriteLine("Bridge link file checks passed.");
    }

    private static void Assert(bool condition, string message)
    {
        if (!condition) throw new InvalidOperationException($"Bridge link file check failed: {message}");
    }
}
