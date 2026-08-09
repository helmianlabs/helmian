namespace Helmion.Desktop.Core;

/// <summary>
/// The sentence a card adds when it is a measurement taken ONCE.
///
/// WHY THIS EXISTS. Two of the cards on the panel — the browser guard and the
/// command guard — are published exactly once each, from PublishStaticPostureCards
/// (MainWindow.GuardPanel.cs:157-158), and nothing calls either again for the life
/// of the window. The command-guard card then said "Execution guard is LIVE …
/// Probed just now" for the rest of the day.
///
/// Six hours later that is a green all-clear for a check that has not run since.
/// It is the same defect as an unknown rendering as OK, only slower and harder to
/// see, because the card looks freshly measured and the panel's clock is visibly
/// ticking beside it (that clock re-runs the escalation rule in memory only — it
/// performs no I/O, GuardPanel.cs:89-93).
///
/// The honest fix is not to pretend it is live. It is to say when it was measured
/// and that nothing measures it again, which is exactly what the code can prove.
/// </summary>
public static class GuardFreshness
{
    /// <param name="when">The clock time the measurement was actually taken.</param>
    public static string MeasuredAt(DateTimeOffset when) =>
        $"Checked at {when:h:mm tt}. It is not checked again on its own — this is measured "
        + "once, when Helmion starts.";
}
