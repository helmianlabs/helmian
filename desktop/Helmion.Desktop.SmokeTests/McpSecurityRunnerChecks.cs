using Helmion.Desktop.Core;

internal static class McpSecurityRunnerChecks
{
    public static void Run()
    {
        const string audit = """
        {
          "findings": [
            {
              "severity": "critical",
              "rule": "credential/reads-secret-file",
              "message": "Reads a credential file.",
              "citation": "server.mjs:12",
              "evidence": "readFileSync(tokenPath)"
            },
            {
              "severity": "high",
              "rule": "network/raw-socket",
              "message": "Opens a raw socket.",
              "citation": "server.mjs:20",
              "evidence": "net.connect(host)"
            }
          ]
        }
        """;

        var token = McpSecurityRunner.SearchAuditFindings(audit, "secret / token access");
        Check(token.Contains("credential/reads-secret-file", StringComparison.Ordinal),
            "secret/token search reads matching credential findings from audit JSON");
        Check(!token.Contains("network/raw-socket", StringComparison.Ordinal),
            "secret/token search does not invent unrelated findings");
        Check(token.Contains("not a runtime-usage measurement", StringComparison.OrdinalIgnoreCase) == false,
            "a matching secret/token search reports evidence rather than an invented usage metric");

        var network = McpSecurityRunner.SearchAuditFindings(audit, "network");
        Check(network.Contains("network/raw-socket", StringComparison.Ordinal),
            "plain-text audit search uses the finding fields");
        Check(!network.Contains("credential/reads-secret-file", StringComparison.Ordinal),
            "plain-text audit search limits output to actual matches");

        var none = McpSecurityRunner.SearchAuditFindings(audit, "browser automation");
        Check(none.Contains("0 matching finding", StringComparison.Ordinal),
            "a miss says zero matching static findings");
        Check(none.Contains("not a runtime-usage measurement", StringComparison.OrdinalIgnoreCase),
            "a miss does not claim runtime absence");

        var beforeAudit = McpSecurityRunner.SearchAuditFindings(null, "token");
        Check(beforeAudit.Contains("Run Audit first", StringComparison.Ordinal),
            "search refuses to imply evidence before an audit exists");

        Console.WriteLine("Helmion MCP security runner checks passed (8 checks).");
    }

    private static void Check(bool condition, string message)
    {
        if (!condition) throw new InvalidOperationException("FAIL: " + message);
    }
}
