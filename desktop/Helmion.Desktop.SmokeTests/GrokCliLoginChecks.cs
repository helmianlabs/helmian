using Helmion.Desktop.Core;

/// <summary>
/// Pure checks for the hidden "grok login --device-auth" helper: output parsing, the
/// read-only auth-file status probe, and plain-language error mapping. Never runs grok and
/// never reads the machine's real ~/.grok/auth.json.
/// </summary>
internal static class GrokCliLoginChecks
{
    public static void Run()
    {
        var checks = 0;

        Assert(GrokCliLogin.ParseVerificationUrl("Open https://accounts.x.ai/device?x=1 to continue.")
                == "https://accounts.x.ai/device?x=1",
            "the verification URL is read from CLI output without trailing punctuation");
        Assert(GrokCliLogin.ParseVerificationUrl("Waiting…") is null, "no URL, no match");
        Assert(GrokCliLogin.ParseUserCode("Your code: WDJB-MJHT") == "WDJB-MJHT", "labelled code");
        Assert(GrokCliLogin.ParseUserCode("Enter WDJB-MJHT at the page") == "WDJB-MJHT", "bare code");
        Assert(GrokCliLogin.ParseUserCode("Enter the code below") is null, "prose is not a code");
        Assert(GrokCliLogin.ParseUserCode("https://auth.x.ai/device?user_code=ABCD-EFGH") is null,
            "a code inside a URL is not shown twice as the code");
        checks += 6;

        Assert(GrokCliLogin.FriendlyError("Grok CLI exited with code 1: 403 User does not have Grok code CLI")
                == GrokCliLogin.PlanMissingMessage, "403 / entitlement becomes the plan message");
        Assert(GrokCliLogin.FriendlyError("Grok CLI exited with code 1: Error: not signed in. Run grok login")
                == GrokCliLogin.SignInNeededMessage, "not signed in becomes the Sign in message");
        Assert(GrokCliLogin.FriendlyError("Could not find the \"Grok CLI\" command on PATH (x). Install ... \"Grok CLI login\"")
                == GrokCliLogin.NotInstalledMessage, "missing CLI becomes the install message");
        Assert(GrokCliLogin.FriendlyError("boom") == "boom", "other errors pass through");
        Assert(GrokCliLogin.NotInstalledMessage.Contains(GrokCliLogin.InstallUrl, StringComparison.Ordinal),
            "the install message carries the official link");
        checks += 5;

        var root = Path.Combine(Path.GetTempPath(), "helmion-grokcli-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(root);
        try
        {
            var file = Path.Combine(root, "auth.json");
            Assert(!GrokCliLogin.HasCliSession(file), "no file means not signed in");
            File.WriteAllText(file, "{ \"https://auth.x.ai::client\": { \"key\": \"\", \"refresh_token\": \"r\" } }");
            Assert(GrokCliLogin.HasCliSession(file), "a refreshable CLI sign-in counts as signed in");
            File.WriteAllText(file, "{ \"https://elsewhere.example::c\": { \"key\": \"k\" } }");
            Assert(!GrokCliLogin.HasCliSession(file), "only the auth.x.ai issuer counts");
            File.WriteAllText(file, "not json");
            Assert(!GrokCliLogin.HasCliSession(file), "a corrupt file is not signed in, and does not throw");
            checks += 4;
        }
        finally
        {
            try { Directory.Delete(root, recursive: true); } catch { /* temp */ }
        }

        Console.WriteLine($"Grok CLI login smoke tests passed ({checks} checks).");
    }

    private static void Assert(bool condition, string what)
    {
        if (!condition) throw new InvalidOperationException($"Grok CLI login check failed: {what}");
    }
}
