namespace Helmion.Desktop.Core;

/// <summary>One guard card describing the local helper service.</summary>
public sealed record LocalServiceCard(GuardLevel Level, string Title, string Detail);

/// <summary>
/// Turns "is the local helper answering" into a guard card.
///
/// THREE STATES, AND THE THIRD ONE IS THE WHOLE POINT.
///
/// This mapping used to live inline in MainWindow.GuardPanel.cs:269-281, reading a
/// plain <c>bool</c> field that defaults to false (MainWindow.xaml.cs:43). The card
/// was published from the window's constructor, and App.xaml.cs:122-124 only starts
/// the named-pipe hello AFTER the window is shown — so the first thing on the panel
/// was "Local service not connected · The read-only named-pipe service is not
/// answering", stated with confidence about a question nobody had asked yet.
///
/// A bool cannot say "I have not looked". That is not a wording problem, it is a
/// missing state, so the state is added here rather than papered over: null means
/// nothing has tried yet, and it renders grey and says so.
///
/// The direction of that old lie was the safe one — it cried wolf rather than
/// giving a false all-clear — but a panel that opens with a red-adjacent warning it
/// invented is a panel you learn to ignore, and then it is not there when something
/// is genuinely wrong.
/// </summary>
public static class LocalServicePosture
{
    /// <summary>The dedup signature for this card. One card, updated in place.</summary>
    public const string Signature = "local-service-state";

    /// <param name="connected">
    /// True when the pipe answered, false when it was asked and did not, and NULL
    /// when nothing has asked it yet.
    /// </param>
    public static LocalServiceCard Describe(bool? connected) => connected switch
    {
        true => new LocalServiceCard(
            GuardLevel.Normal,
            "The local helper is answering",
            "Helmion's own background helper answered when I asked it. That is all this says: "
            + "it does not mean your database is reachable or that any of your keys work."),

        false => new LocalServiceCard(
            GuardLevel.Warning,
            "The local helper is not answering",
            "I asked Helmion's background helper and got nothing back. Helmion keeps working "
            + "without it — it reads your project directly instead — so there is nothing you "
            + "need to do unless you keep seeing this."),

        _ => new LocalServiceCard(
            GuardLevel.Unknown,
            "I have not checked the local helper yet",
            "Helmion has only just started and has not tried to reach its background helper. "
            + "I will say either way as soon as I know. This is not a problem; it is just not "
            + "an answer yet."),
    };
}
