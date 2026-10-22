using Helmion.Desktop.Core;

internal static class HeraldPairingLinkChecks
{
    public static void Run()
    {
        Assert(HeraldPairingLink.TryBuild("https://helmian.cloud/herald/", "1234 5678", HeraldPairingLink.EnrollKey)
            == "https://helmian.cloud/herald/#enroll=12345678", "enrollment QR carries the code only in the fragment");
        Assert(HeraldPairingLink.TryBuild("https://helmian.cloud/herald/?channel=herald_abc", "01234567", HeraldPairingLink.PairKey)
            == "https://helmian.cloud/herald/?channel=herald_abc#pair=01234567", "relay QR keeps the channel and adds the code");
        Assert(HeraldPairingLink.TryBuild("http://helmian.cloud/herald/", "12345678", HeraldPairingLink.EnrollKey) is null, "plain HTTP is refused");
        Assert(HeraldPairingLink.TryBuild("https://evil.example/herald/", "12345678", HeraldPairingLink.EnrollKey) is null, "untrusted hosts are refused");
        Assert(HeraldPairingLink.TryBuild("https://helmian.cloud/herald/", "1234", HeraldPairingLink.EnrollKey) is null, "short codes are refused");
        Assert(HeraldPairingLink.ParseCliPairingCode("Pairing code: 87654321 (expires 2026-10-14T21:00:00Z)") == "87654321", "CLI code line parses");
        Assert(HeraldPairingLink.ParseCliPairingCode("Phone: https://x") is null, "non-code lines are ignored");
        Assert(HeraldPairingLink.IsPrivateLanHttp(new Uri("http://192.168.1.20:7420/#pair=12345678")), "LAN fallback accepts private Wi-Fi addresses");
        Assert(!HeraldPairingLink.IsPrivateLanHttp(new Uri("http://8.8.8.8:7420/")), "LAN fallback refuses public addresses");
        Assert(HeraldPairingFallback.ShouldUseAccountPairing(@"C:\Helmian", @"C:\node.exe", ownerSecretPresent: false),
            "no owner secret falls back to account pairing (QR still shown)");
        Assert(HeraldPairingFallback.ShouldUseAccountPairing(null, @"C:\node.exe", ownerSecretPresent: true),
            "missing bin\\helmion.mjs falls back to account pairing");
        Assert(HeraldPairingFallback.ShouldUseAccountPairing(@"C:\Helmian", null, ownerSecretPresent: true),
            "missing Node falls back to account pairing");
        Assert(!HeraldPairingFallback.ShouldUseAccountPairing(@"C:\Helmian", @"C:\node.exe", ownerSecretPresent: true),
            "fully set-up legacy relay keeps the relay path");
        Assert(HeraldPairingFallback.IsMissingOwnerEnrollmentExit(3) && !HeraldPairingFallback.IsMissingOwnerEnrollmentExit(4)
            && !HeraldPairingFallback.IsMissingOwnerEnrollmentExit(null), "only exit 3 means no owner enrollment");
        Console.WriteLine("Herald pairing link checks passed.");
    }

    private static void Assert(bool condition, string message)
    {
        if (!condition) throw new InvalidOperationException($"Herald pairing link check failed: {message}");
    }
}
