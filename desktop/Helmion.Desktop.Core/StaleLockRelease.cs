using Helmion.LocalService.Protocol;

namespace Helmion.Desktop.Core;

/// <param name="Cleared">Whether the lock file was actually removed.</param>
/// <param name="Message">What to tell him, in the words the card uses.</param>
public sealed record StaleLockResult(bool Cleared, string Message);

/// <summary>
/// The one real action on the write-lock card: throw away a lock nobody holds.
///
/// WHY THIS EXISTS AT ALL. Troy, 2026-07-30: "you need to have an actionable button
/// or interaction on the card for that specific agent." Acknowledge is not an
/// action — it hides the card and changes nothing about the thing the card is
/// complaining about. The stale-lock card described a real, fixable condition and
/// offered nothing but a way to stop looking at it.
///
/// IT RE-CHECKS BEFORE IT DELETES, AND THAT IS NOT PARANOIA. The card he is
/// clicking may have been drawn minutes ago; a lock that was stale then can be held
/// by a live agent now, because the next writer takes over a stale lock by
/// REWRITING the same file (src/core/lease.mjs). Deleting on the strength of what
/// the card said would then throw away a live writer's claim and let two agents
/// write the same project at once — turning a tidy-up button into the exact failure
/// the lease exists to prevent. So the state is read again, at the moment of the
/// click, and anything other than STALE refuses and says why.
/// </summary>
public static class StaleLockRelease
{
    /// <summary>Routing tag the window matches to run this.</summary>
    public const string ActionKind = "guard-clear-stale-lock";

    public static StaleLockResult Run(string? workspacePath, DateTimeOffset now)
    {
        if (string.IsNullOrWhiteSpace(workspacePath))
        {
            return new StaleLockResult(false,
                "There is no project open, so there is no lock to clear.");
        }

        var posture = LeaseInspector.Inspect(workspacePath, now);
        if (posture.Status != LeaseInspector.StatusStale)
        {
            return new StaleLockResult(false, posture.Status switch
            {
                LeaseInspector.StatusActive =>
                    "I did not clear it. Something is holding this lock right now, and taking it "
                    + "away would let two agents write to the same project at once.",
                LeaseInspector.StatusNone =>
                    "There was nothing to clear — the lock is already gone.",
                LeaseInspector.StatusUnreadable =>
                    "I did not clear it. I cannot read the lock, so I cannot tell whether anything "
                    + "is holding it, and I will not throw away something I do not understand.",
                _ =>
                    "I did not clear it, because I could not work out what state it is in.",
            });
        }

        try
        {
            File.Delete(LeaseInspector.LeaseFilePath(workspacePath));
        }
        catch (Exception error) when (
            error is IOException or UnauthorizedAccessException or NotSupportedException
                or ArgumentException or System.Security.SecurityException)
        {
            return new StaleLockResult(false,
                $"I tried to clear the old lock and could not ({error.Message}). Nothing changed.");
        }

        return new StaleLockResult(true,
            "Cleared. The lock nobody was holding is gone, and the next agent can take it.");
    }
}
