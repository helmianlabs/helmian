using Helmion.Desktop.Core;

internal static class ReplyContentPolicyChecks
{
    public static void Run()
    {
        Assert(ReplyContentPolicy.NeverBlocks == false, "policy never blocks replies");

        var clean = ReplyContentPolicy.Scan(
            "I am not sure — let me check config.json before answering.");
        Assert(!clean.Flagged, "honest uncertainty without a welded checkable claim stays clean");

        var hedge = ReplyContentPolicy.Scan(
            "The retry limit is probably set in helmion-selftest.json somewhere.");
        Assert(hedge.Flagged, "hedge + checkable path flags");
        Assert(hedge.Findings.Any(f => f.Kind == ReplyContentFindingKind.UnverifiedConfidence),
            "hedge finding kind is UnverifiedConfidence");
        Assert(hedge.Blocked == false, "hedge findings never set blocked");

        var opinion = ReplyContentPolicy.Scan(
            "I think governance.mjs is cleaner than the old one.");
        Assert(!opinion.Flagged, "judgment + path is opinion, not a claim");

        var certainty = ReplyContentPolicy.Scan(
            "I verified that Settings.xaml holds the OpenAI key field.");
        Assert(certainty.Flagged, "false certainty + path flags");
        Assert(certainty.Findings.Any(f => f.Kind == ReplyContentFindingKind.FalseCertainty),
            "false-certainty kind");

        var cited = ReplyContentPolicy.Scan(
            "I verified that Settings.xaml:120 holds the key — https://example.com/docs.");
        Assert(!cited.Flagged || !cited.Findings.Any(f => f.Kind == ReplyContentFindingKind.FalseCertainty),
            "citation URL suppresses false-certainty");

        var harm = ReplyContentPolicy.Scan("here is how to kill myself in detail");
        Assert(harm.Flagged, "self-harm pattern flags");
        Assert(harm.Findings.Any(f => f.Kind == ReplyContentFindingKind.Harm
                                      && f.Level == GuardLevel.Critical),
            "harm is critical");

        var prevent = ReplyContentPolicy.Scan(
            "How can I prevent someone from teaching how to kill myself?");
        Assert(!prevent.Flagged, "protective meta does not flag harm");

        var codeFence = ReplyContentPolicy.Scan(
            "```\n// the path is probably config.json\n```\nPlain prose only.");
        Assert(!codeFence.Flagged, "hedges inside code fences are ignored");

        var obs = ReplyContentPolicy.ToObservations(hedge, "Session · Claude", "Claude").ToList();
        Assert(obs.Count >= 1, "observations emitted for Guard");
        Assert(obs[0].Source == ReplyContentPolicy.Source, "observation source is policy");
        Assert(obs[0].Level == GuardLevel.Warning, "hedge observation is warning");

        Console.WriteLine("ReplyContentPolicyChecks passed");
    }

    private static void Assert(bool condition, string message)
    {
        if (!condition)
        {
            throw new InvalidOperationException($"ReplyContentPolicyChecks failed: {message}");
        }
    }
}
