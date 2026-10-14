using Helmion.Desktop.Core;

internal static class HeraldPairingLinkChecks
{
    public static void Run()
    {
        Assert(HeraldPairingLink.TryBuild("https://helmian.vercel.app/herald/", "1234 5678", HeraldPairingLink.EnrollKey)
            == "https://helmian.vercel.app/herald/#enroll=12345678", "enrollment QR carries the code only in the fragment");
        Assert(HeraldPairingLink.TryBuild("https://helmian.vercel.app/herald/?channel=herald_abc", "01234567", HeraldPairingLink.PairKey)
            == "https://helmian.vercel.app/herald/?channel=herald_abc#pair=01234567", "relay QR keeps the channel and adds the code");
        Assert(HeraldPairingLink.TryBuild("http://helmian.vercel.app/herald/", "12345678", HeraldPairingLink.EnrollKey) is null, "plain HTTP is refused");
        Assert(HeraldPairingLink.TryBuild("https://evil.example/herald/", "12345678", HeraldPairingLink.EnrollKey) is null, "untrusted hosts are refused");
        Assert(HeraldPairingLink.TryBuild("https://helmian.vercel.app/herald/", "1234", HeraldPairingLink.EnrollKey) is null, "short codes are refused");
        Assert(HeraldPairingLink.ParseCliPairingCode("Pairing code: 87654321 (expires 2026-10-14T21:00:00Z)") == "87654321", "CLI code line parses");
        Assert(HeraldPairingLink.ParseCliPairingCode("Phone: https://x") is null, "non-code lines are ignored");
        Console.WriteLine("Herald pairing link checks passed.");
    }

    private static void Assert(bool condition, string message)
    {
        if (!condition) throw new InvalidOperationException($"Herald pairing link check failed: {message}");
    }
}
