using System.Net;
using System.Net.Sockets;
using Helmion.Desktop.Core;

internal static class EmbeddedBrowserPolicyChecks
{
    public static async Task RunAsync()
    {
        var checks = 0;
        void Check(bool condition, string description)
        {
            checks++;
            if (!condition)
            {
                throw new InvalidOperationException(
                    $"Embedded browser policy check failed: {description}");
            }
        }

        foreach (var refused in new[]
                 {
                     "",
                     "file:///C:/Windows/win.ini",
                     "http://example.com",
                     "https://user:password@example.com",
                     "https://localhost",
                     "https://127.0.0.1",
                     "https://10.1.2.3",
                     "javascript:alert(1)"
                 })
        {
            Check(!EmbeddedBrowserPolicy.ValidateSyntax(refused).Allowed,
                $"{refused} is refused before WebView2 navigation");
        }

        var normalized = EmbeddedBrowserPolicy.ValidateSyntax("example.com/watch?v=1");
        Check(normalized.Allowed
              && normalized.Address?.AbsoluteUri == "https://example.com/watch?v=1",
            "a normal host is normalized to HTTPS without discarding its path or query");

        var publicPolicy = new EmbeddedBrowserPolicy(
            (_, _) => Task.FromResult(new[] { IPAddress.Parse("8.8.8.8") }));
        var publicDecision = await publicPolicy.ValidateAsync("https://example.com/app");
        Check(publicDecision.Allowed && publicDecision.Address?.Host == "example.com",
            "a public DNS result is eligible for rendered browsing");

        var mixedPolicy = new EmbeddedBrowserPolicy(
            (_, _) => Task.FromResult(new[]
            {
                IPAddress.Parse("8.8.8.8"),
                IPAddress.Parse("192.168.1.20")
            }));
        var mixedDecision = await mixedPolicy.ValidateAsync("https://mixed.example/app");
        Check(!mixedDecision.Allowed
              && mixedDecision.Message.Contains("private-network", StringComparison.Ordinal),
            "any private DNS answer blocks navigation before WebView2 receives it");

        var failedPolicy = new EmbeddedBrowserPolicy(
            (_, _) => Task.FromException<IPAddress[]>(new SocketException()));
        var failedDecision = await failedPolicy.ValidateAsync("https://missing.example/");
        Check(!failedDecision.Allowed
              && failedDecision.Message.Contains("could not be resolved", StringComparison.Ordinal),
            "DNS failure becomes an honest user-facing refusal");

        Console.WriteLine($"Helmion embedded browser policy checks passed ({checks} checks).");
    }
}
