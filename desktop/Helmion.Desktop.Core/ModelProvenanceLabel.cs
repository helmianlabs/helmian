namespace Helmion.Desktop.Core;

/// <summary>
/// What the Pilot's Console header should say about who answered the last turn.
///
/// WHY THIS IS A PURE FUNCTION IN Core AND NOT A METHOD ON MainWindow.
/// The console SmokeTests project references Helmion.Desktop.Core but NOT the
/// WPF project, and nothing may appear on Troy's screen — so anything left
/// inline in MainWindow.xaml.cs can only ever be proven to COMPILE. That is
/// exactly the standard this feature exists to raise: the header was wrong for
/// months and no test could have caught it, because there was nothing testable
/// to catch. Moving the decision here means the rule below is asserted headless
/// against real inputs, and MainWindow keeps only the two lines that paint it.
///
/// THE RULE, stated once so it can be tested once:
///
///   The header names the model that ANSWERED. It is never written from the
///   router's choice.
///
/// src/agent/loop.mjs emits its `model` event BEFORE the request goes out, so
/// that event is an intention. On 2026-07-30 an intention ("Qwen 3.5") was the
/// only thing on screen while something else did the answering, and when Troy
/// asked who he had been talking to, nothing could tell him. The `provenance`
/// event is emitted only after a response arrived AND after the row was written
/// to .helmion\audit\provenance-*.jsonl, so a header driven by it is a view of
/// the evidence rather than a second opinion about it.
/// </summary>
public static class ModelProvenanceLabel
{
    /// <summary>Shown before anything has answered. Not a model name.</summary>
    public const string PendingHeader = "model: —";

    /// <summary>
    /// The header, tooltip, and optional transcript line for one answered turn.
    /// <see cref="TranscriptLine"/> is null when the turn needs no extra line.
    /// </summary>
    public sealed record Rendering(
        string HeaderText,
        string ToolTip,
        bool IsLocal,
        string? TranscriptLine);

    /// <summary>
    /// Build the rendering for a <c>provenance</c> event, or null when the event
    /// carries no model — a header that renders "model: " with nothing after it
    /// is worse than one that still says it does not know.
    /// </summary>
    public static Rendering? ForAnswer(AgentBridgeEvent ev)
    {
        if (ev is null) return null;
        if (!string.Equals(ev.Event, "provenance", StringComparison.Ordinal)) return null;
        if (string.IsNullOrWhiteSpace(ev.Model)) return null;

        var model = ev.Model!.Trim();
        var provider = string.IsNullOrWhiteSpace(ev.Provider) ? null : ev.Provider!.Trim();
        var label = provider is null ? model : $"{provider} · {model}";

        // LOCAL goes FIRST, not as a suffix. Troy asked "who am I talking to"
        // after a 4B model on this machine answered in Helmion's voice with
        // nothing on screen to say so; a marker he has to read to the end of the
        // line to find would not have answered him any sooner than no marker.
        if (ev.IsLocal) label = $"LOCAL · {label}";

        var host = string.IsNullOrWhiteSpace(ev.EndpointHost) ? "an unrecorded host" : ev.EndpointHost!.Trim();
        var session = string.IsNullOrWhiteSpace(ev.SessionId) ? "unknown" : ev.SessionId!.Trim();

        var tooltip = $"{label} answered the last turn, from {host}."
            + (ev.IsLocal ? "\nThis ran on THIS MACHINE, not a frontier provider." : string.Empty)
            + $"\nRecorded in .helmion\\audit\\provenance-*.jsonl (session {session})."
            + "\nRun: helmion provenance last";

        // Only a local answer earns a transcript line. A frontier answer is
        // already described by the ◆ router line above it, and repeating every
        // turn would bury the one case that matters inside the noise.
        var transcript = ev.IsLocal
            ? $"  ⚑ answered by a LOCAL model on this machine: {model}"
                + (string.IsNullOrWhiteSpace(ev.EndpointHost) ? string.Empty : $" ({host})")
            : null;

        return new Rendering($"model: {label}", tooltip, ev.IsLocal, transcript);
    }

    /// <summary>
    /// The console header as a running value across a turn's events.
    ///
    /// This exists so the rule can be tested as BEHAVIOUR OVER A SEQUENCE rather
    /// than as one function call. The defect was never "ForAnswer formats badly";
    /// it was that a `model` event reached the header at all. Feeding a whole
    /// turn through <see cref="Observe"/> and asserting what <see cref="Header"/>
    /// ends up as is the only shape that can catch a regression back to showing
    /// the router's intention.
    /// </summary>
    public sealed class HeaderState
    {
        public string Header { get; private set; } = PendingHeader;

        public string? ToolTip { get; private set; }

        /// <summary>True once a LOCAL model has answered a turn in this state.</summary>
        public bool AnsweredLocally { get; private set; }

        /// <summary>Every transcript line this state produced, in order.</summary>
        public IReadOnlyList<string> TranscriptLines => _transcript;

        private readonly List<string> _transcript = new();

        /// <summary>
        /// Feed one bridge event. A `model` event is deliberately IGNORED for the
        /// header — that is the whole rule, expressed as code rather than as a
        /// comment somebody can drift away from.
        /// </summary>
        public void Observe(AgentBridgeEvent ev)
        {
            var rendering = ForAnswer(ev);
            if (rendering is null) return;

            Header = rendering.HeaderText;
            ToolTip = rendering.ToolTip;
            if (rendering.IsLocal) AnsweredLocally = true;
            if (rendering.TranscriptLine is not null) _transcript.Add(rendering.TranscriptLine);
        }
    }
}
