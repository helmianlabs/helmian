using Helmion.Desktop.Core;

/// <summary>
/// THE PIN: "the console header names the model that ANSWERED, never the one the
/// router intended."
///
/// WHY THIS FILE EXISTS. On 2026-07-30 Troy saw "Qwen 3.5" go by, said "hello
/// Grok", and got a reply calling itself Helmion. When he asked who he had been
/// talking to, nothing could answer. Part of the reason was the header itself:
/// it was written from the `model` event, which src/agent/loop.mjs emits BEFORE
/// the request goes out. That is an intention, and when a fallback fires it
/// names a model that never produced a word.
///
/// The fix is only worth having if it cannot silently regress into reporting an
/// intention again, so the decision lives in Helmion.Desktop.Core — which this
/// console project references and the WPF project does not gate — and is
/// asserted here with no window in the room.
///
/// The sequence tests below are the ones that matter. A single call to
/// ForAnswer proves formatting; only feeding a WHOLE TURN through HeaderState
/// proves the property that was actually broken.
/// </summary>
public static class ModelProvenanceLabelChecks
{
    public static void Run()
    {
        var checks = 0;

        // ── Helpers shaped exactly like the events the bridge emits ───────────
        static AgentBridgeEvent Chosen(string model, string tier) =>
            new("model", Model: model, Tier: tier, Reason: "router picked it");

        static AgentBridgeEvent Answered(
            string provider, string model, bool isLocal, string host, string session = "pid1234-abc") =>
            new("provenance",
                Provider: provider,
                Model: model,
                EndpointHost: host,
                IsLocal: isLocal,
                SessionId: session);

        // ── 1. A REMOTE ANSWER ───────────────────────────────────────────────
        var remote = ModelProvenanceLabel.ForAnswer(
            Answered("claude", "claude-sonnet-5", false, "api.anthropic.com"));
        Assert(remote is not null, "a provenance event produces a rendering");
        Assert(remote!.HeaderText == "model: claude · claude-sonnet-5",
            "the header names the provider and the exact model that answered");
        Assert(!remote.IsLocal, "a frontier answer is not marked local");
        Assert(remote.TranscriptLine is null,
            "a frontier answer adds no transcript line — the ◆ router line already describes it");
        Assert(remote.ToolTip.Contains("api.anthropic.com", StringComparison.Ordinal),
            "the tooltip names the host that actually answered");
        Assert(remote.ToolTip.Contains("helmion provenance last", StringComparison.Ordinal),
            "the tooltip says how to read the durable record");
        checks += 6;

        // ── 2. A LOCAL ANSWER — the case nobody could see ────────────────────
        var local = ModelProvenanceLabel.ForAnswer(
            Answered("local", "qwen3.5:4b", true, "127.0.0.1:11434"));
        Assert(local!.HeaderText == "model: LOCAL · local · qwen3.5:4b",
            "a local answer says LOCAL, and says it FIRST");
        Assert(local.HeaderText.StartsWith("model: LOCAL", StringComparison.Ordinal),
            "LOCAL is not a suffix a reader has to reach the end of the line to find");
        Assert(local.IsLocal, "the rendering reports it as local");
        Assert(local.TranscriptLine is not null
            && local.TranscriptLine.Contains("qwen3.5:4b", StringComparison.Ordinal),
            "a local answer also writes a transcript line naming the model");
        Assert(local.ToolTip.Contains("THIS MACHINE", StringComparison.Ordinal),
            "the tooltip states plainly that this did not come from a frontier provider");
        checks += 5;

        // ── 3. THE RULE, AS BEHAVIOUR OVER A WHOLE TURN ──────────────────────
        // This is the assertion the feature exists for. Everything above would
        // still pass if MainWindow went back to writing the header from the
        // `model` event; only this catches that.
        var routerOnly = new ModelProvenanceLabel.HeaderState();
        routerOnly.Observe(Chosen("qwen3.5:4b", "local"));
        routerOnly.Observe(Chosen("claude-haiku-4-5", "fast"));
        Assert(routerOnly.Header == ModelProvenanceLabel.PendingHeader,
            "A ROUTER CHOICE NEVER REACHES THE HEADER — it is an intention, not an answer");
        Assert(routerOnly.TranscriptLines.Count == 0,
            "and it writes no transcript line of its own here");
        checks += 2;

        // ── 4. A FALLBACK ACTUALLY MOVES THE LABEL ───────────────────────────
        // The router announces the local model, the local box dies, the frontier
        // answers. A header driven by the router would still read qwen. This is
        // the exact sequence loop.mjs runs on a local failure.
        var fallback = new ModelProvenanceLabel.HeaderState();
        fallback.Observe(Chosen("qwen3.5:4b", "local"));          // intended local
        fallback.Observe(Chosen("claude-haiku-4-5", "fast"));      // re-announced after the failure
        fallback.Observe(Answered("claude", "claude-haiku-4-5", false, "api.anthropic.com"));
        Assert(fallback.Header == "model: claude · claude-haiku-4-5",
            "AFTER A FALLBACK THE HEADER NAMES THE FRONTIER MODEL THAT ANSWERED");
        Assert(!fallback.Header.Contains("qwen", StringComparison.OrdinalIgnoreCase),
            "the header does not name a model that never produced a word");
        Assert(!fallback.AnsweredLocally,
            "an ATTEMPTED local turn that failed is not reported as a local answer");
        Assert(fallback.TranscriptLines.Count == 0,
            "and no LOCAL transcript line is written for a local model that never answered");
        checks += 4;

        // ── 5. THE OPPOSITE DIRECTION — local really does light it up ─────────
        // Without this, check 4 would also pass if the label were hardcoded to
        // never say LOCAL. A green that cannot go red is not a measurement.
        var wentLocal = new ModelProvenanceLabel.HeaderState();
        wentLocal.Observe(Chosen("qwen3.5:4b", "local"));
        wentLocal.Observe(Answered("local", "qwen3.5:4b", true, "127.0.0.1:11434"));
        Assert(wentLocal.Header == "model: LOCAL · local · qwen3.5:4b",
            "when a local model DOES answer, the header says so");
        Assert(wentLocal.AnsweredLocally, "and the state records that it happened");
        Assert(wentLocal.TranscriptLines.Count == 1,
            "with exactly one transcript line, not zero and not one per event");
        checks += 3;

        // ── 6. MULTI-ROUND: the LAST answer wins the header ──────────────────
        var multi = new ModelProvenanceLabel.HeaderState();
        multi.Observe(Answered("local", "qwen3.5:4b", true, "127.0.0.1:11434"));
        multi.Observe(Answered("grok", "grok-4.5", false, "api.x.ai"));
        Assert(multi.Header == "model: grok · grok-4.5",
            "the header reports the most recent answer, not the first one of the turn");
        Assert(multi.AnsweredLocally,
            "but a local answer earlier in the turn is not erased — it did happen");
        checks += 2;

        // ── 6b. THE NEGATIVE CONTROL ─────────────────────────────────────────
        //
        // Everything above proves the check PASSES on the fixed code. None of it
        // proves the check would have CAUGHT the bug, and a test that passes on
        // broken and fixed code alike proves nothing. So the pre-fix header is
        // reconstructed here and fed the same turns, and the SAME check must
        // fail on it.
        //
        // HeaderAnswers is written once and used by both halves deliberately. A
        // hand-rolled assertion in the negative half could quietly be weaker
        // than the positive one, which is how a control ends up controlling
        // nothing.

        // The turn Troy actually had on 2026-07-30: the router picked the local
        // qwen model, and the local qwen model answered.
        var localTurn = new[]
        {
            Chosen("qwen3.5:4b", "local"),
            Answered("local", "qwen3.5:4b", true, "127.0.0.1:11434"),
        };

        var fixedHeader = new ModelProvenanceLabel.HeaderState();
        foreach (var ev in localTurn) fixedHeader.Observe(ev);

        Assert(HeaderAnswers(fixedHeader.Header, "qwen3.5:4b", expectLocal: true),
            "POSITIVE: the answer-driven header names the model AND says it was local");
        Assert(!HeaderAnswers(IntentionHeader(localTurn), "qwen3.5:4b", expectLocal: true),
            "NEGATIVE CONTROL: THE SAME CHECK FAILS on a header fed the router's intention. "
            + "This is the 2026-07-30 defect exactly — the screen named a model and never "
            + "said it was running on his own machine.");
        checks += 2;

        // A second divergence, from a different cause: when the router has no
        // tier table for a provider it hands back model=null (model-router.mjs
        // modelForTier), and chatWithTools then substitutes its own default
        // (providers.mjs, `model || 'claude-sonnet-5'`). The intention names
        // nothing; the answer names sonnet.
        var defaultedTurn = new[]
        {
            new AgentBridgeEvent("model", Model: null, Tier: "standard"),
            Answered("claude", "claude-sonnet-5", false, "api.anthropic.com"),
        };

        var fixedDefaulted = new ModelProvenanceLabel.HeaderState();
        foreach (var ev in defaultedTurn) fixedDefaulted.Observe(ev);

        Assert(HeaderAnswers(fixedDefaulted.Header, "claude-sonnet-5", expectLocal: false),
            "POSITIVE: the header names the model the provider actually defaulted to");
        Assert(!HeaderAnswers(IntentionHeader(defaultedTurn), "claude-sonnet-5", expectLocal: false),
            "NEGATIVE CONTROL: an intention-driven header cannot name a model the router "
            + "never chose, so the same check fails on it");
        checks += 2;

        // And the control must not be vacuous — IntentionHeader has to be
        // capable of passing the check, or "it failed" would mean nothing.
        Assert(HeaderAnswers(IntentionHeader(new[] { Chosen("grok-4.5", "deep") }), "grok-4.5", false),
            "the reconstructed pre-fix header CAN satisfy the check when intention and "
            + "answer happen to agree — so its failures above are real, not vacuous");
        checks += 1;

        // ── 7. WHAT MUST PRODUCE NOTHING ─────────────────────────────────────
        Assert(ModelProvenanceLabel.ForAnswer(null!) is null, "a null event renders nothing");
        Assert(ModelProvenanceLabel.ForAnswer(new AgentBridgeEvent("assistant", Text: "hi")) is null,
            "a non-provenance event renders nothing");
        Assert(ModelProvenanceLabel.ForAnswer(new AgentBridgeEvent("provenance")) is null,
            "a provenance event with no model renders nothing rather than an empty label");
        Assert(ModelProvenanceLabel.ForAnswer(
            new AgentBridgeEvent("provenance", Model: "   ")) is null,
            "and neither does a whitespace model");
        checks += 4;

        // A model with no provider still renders — half an answer beats none.
        var bareModel = ModelProvenanceLabel.ForAnswer(
            new AgentBridgeEvent("provenance", Model: "some-model"));
        Assert(bareModel!.HeaderText == "model: some-model",
            "a model with no provider name still reaches the header");
        Assert(bareModel.ToolTip.Contains("an unrecorded host", StringComparison.Ordinal),
            "a missing host is stated as unrecorded, never invented or left blank");
        checks += 2;

        Console.WriteLine($"Helmion model-provenance label checks passed ({checks} checks).");
    }

    /// <summary>
    /// THE CHECK, in one place. "Does this header name the model that answered,
    /// and does it say so when the answer came from this machine?"
    ///
    /// Used by both the positive assertions and the negative control, so the
    /// control cannot be weaker than the thing it is controlling.
    /// </summary>
    private static bool HeaderAnswers(string header, string expectedModel, bool expectLocal)
    {
        if (!header.Contains(expectedModel, StringComparison.Ordinal)) return false;
        return header.Contains("LOCAL", StringComparison.Ordinal) == expectLocal;
    }

    /// <summary>
    /// THE PRE-FIX HEADER, RECONSTRUCTED. This is what MainWindow.xaml.cs did
    /// before 2026-07-30: it wrote the label from the router's `model` event.
    ///
    /// src/agent/loop.mjs emits that event BEFORE the request goes out, and it
    /// carries no local flag into the label — so this header can name a model
    /// nobody ever called, and can never say an answer came from this machine.
    /// It exists only to be failed by <see cref="HeaderAnswers"/>.
    /// </summary>
    private static string IntentionHeader(IEnumerable<AgentBridgeEvent> turn)
    {
        var header = ModelProvenanceLabel.PendingHeader;
        foreach (var ev in turn)
        {
            if (!string.Equals(ev.Event, "model", StringComparison.Ordinal)) continue;
            if (string.IsNullOrWhiteSpace(ev.Model)) continue;
            var tier = string.IsNullOrWhiteSpace(ev.Tier) ? null : ev.Tier;
            header = tier is null ? $"model: {ev.Model}" : $"model: {tier} · {ev.Model}";
        }

        return header;
    }

    private static void Assert(bool condition, string message)
    {
        if (!condition)
        {
            Console.Error.WriteLine($"FAIL: {message}");
            Environment.Exit(1);
        }
    }
}
