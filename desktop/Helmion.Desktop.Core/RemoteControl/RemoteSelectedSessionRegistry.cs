using Helmion.LocalService.Protocol;

namespace Helmion.Desktop.Core;

/// <summary>
/// Fail-closed lifecycle for the one desktop session selected for Remote Control.
/// Local intent is Registering/Updating/Revoking; only an accepted control-plane
/// acknowledgement can make the session remotely selectable or revoked.
/// </summary>
public sealed class RemoteSelectedSessionRegistry
{
    public RemoteSelectedSessionSnapshot? Current { get; private set; }

    public RemoteSelectedSessionSnapshot BeginRegistration(
        RemoteSelectedSessionMetadata metadata,
        DateTimeOffset? now = null)
    {
        var normalized = Normalize(metadata, now ?? DateTimeOffset.UtcNow);
        Current = new RemoteSelectedSessionSnapshot(
            normalized.ProjectId,
            normalized.ProjectDisplayName,
            normalized.SessionId,
            normalized.SessionDisplayName,
            normalized.AgentId,
            normalized.AgentDisplayName,
            normalized.ActivityState,
            normalized.GuardState,
            normalized.PendingApprovalCount,
            normalized.SessionStartedAtUtc,
            RemoteSelectedSessionLifecycle.Registering,
            Revision: 0,
            ServerRegistrationId: null,
            (now ?? DateTimeOffset.UtcNow).ToUniversalTime());
        return Current;
    }

    public RemoteSelectedSessionSnapshot ConfirmRegistration(
        RemoteControlPlaneAcknowledgement acknowledgement)
    {
        var current = RequireLifecycle(RemoteSelectedSessionLifecycle.Registering);
        ValidateAcceptedAcknowledgement(acknowledgement, minimumRevision: 1);
        var registrationId = RemoteControlContractValidation.RequireIdentifier(
            acknowledgement.ServerRegistrationId,
            nameof(acknowledgement.ServerRegistrationId));
        Current = current with
        {
            Lifecycle = RemoteSelectedSessionLifecycle.Online,
            Revision = acknowledgement.ServerRevision,
            ServerRegistrationId = registrationId,
            UpdatedAtUtc = acknowledgement.RecordedAtUtc.ToUniversalTime()
        };
        return Current;
    }

    public RemoteSelectedSessionSnapshot BeginUpdate(
        RemoteSelectedSessionMetadata metadata,
        DateTimeOffset? now = null)
    {
        var current = RequireLifecycle(RemoteSelectedSessionLifecycle.Online);
        var normalized = Normalize(metadata, now ?? DateTimeOffset.UtcNow);
        if (!string.Equals(current.ProjectId, normalized.ProjectId, StringComparison.Ordinal)
            || !string.Equals(current.SessionId, normalized.SessionId, StringComparison.Ordinal))
        {
            throw new InvalidOperationException(
                "A different project or session requires a new registration, not an update.");
        }
        Current = current with
        {
            ProjectDisplayName = normalized.ProjectDisplayName,
            SessionDisplayName = normalized.SessionDisplayName,
            AgentId = normalized.AgentId,
            AgentDisplayName = normalized.AgentDisplayName,
            ActivityState = normalized.ActivityState,
            GuardState = normalized.GuardState,
            PendingApprovalCount = normalized.PendingApprovalCount,
            Lifecycle = RemoteSelectedSessionLifecycle.Updating,
            UpdatedAtUtc = (now ?? DateTimeOffset.UtcNow).ToUniversalTime()
        };
        return Current;
    }

    public RemoteSelectedSessionSnapshot ConfirmUpdate(
        RemoteControlPlaneAcknowledgement acknowledgement)
    {
        var current = RequireLifecycle(RemoteSelectedSessionLifecycle.Updating);
        ValidateAcceptedAcknowledgement(acknowledgement, current.Revision + 1);
        if (!string.IsNullOrWhiteSpace(acknowledgement.ServerRegistrationId)
            && !string.Equals(
                acknowledgement.ServerRegistrationId,
                current.ServerRegistrationId,
                StringComparison.Ordinal))
        {
            throw new InvalidDataException(
                "Selected-session update acknowledgement changed the registration identity.");
        }
        Current = current with
        {
            Lifecycle = RemoteSelectedSessionLifecycle.Online,
            Revision = acknowledgement.ServerRevision,
            UpdatedAtUtc = acknowledgement.RecordedAtUtc.ToUniversalTime()
        };
        return Current;
    }

    public RemoteSelectedSessionSnapshot BeginRevocation(DateTimeOffset? now = null)
    {
        var current = Current
            ?? throw new InvalidOperationException("No selected remote session is registered.");
        if (current.Lifecycle is RemoteSelectedSessionLifecycle.Revoked
            or RemoteSelectedSessionLifecycle.Revoking)
        {
            throw new InvalidOperationException("The selected remote session is already revoking or revoked.");
        }
        Current = current with
        {
            Lifecycle = RemoteSelectedSessionLifecycle.Revoking,
            UpdatedAtUtc = (now ?? DateTimeOffset.UtcNow).ToUniversalTime()
        };
        return Current;
    }

    public RemoteSelectedSessionSnapshot ConfirmRevocation(
        RemoteControlPlaneAcknowledgement acknowledgement)
    {
        var current = RequireLifecycle(RemoteSelectedSessionLifecycle.Revoking);
        ValidateAcceptedAcknowledgement(acknowledgement, current.Revision + 1);
        Current = current with
        {
            Lifecycle = RemoteSelectedSessionLifecycle.Revoked,
            Revision = acknowledgement.ServerRevision,
            UpdatedAtUtc = acknowledgement.RecordedAtUtc.ToUniversalTime()
        };
        return Current;
    }

    public RemoteSelectedSessionSnapshot MarkOffline(DateTimeOffset? now = null)
    {
        var current = Current
            ?? throw new InvalidOperationException("No selected remote session can be marked offline.");
        if (current.Lifecycle == RemoteSelectedSessionLifecycle.Revoked) return current;
        Current = current with
        {
            Lifecycle = RemoteSelectedSessionLifecycle.Offline,
            UpdatedAtUtc = (now ?? DateTimeOffset.UtcNow).ToUniversalTime()
        };
        return Current;
    }

    private RemoteSelectedSessionSnapshot RequireLifecycle(
        RemoteSelectedSessionLifecycle required)
    {
        var current = Current
            ?? throw new InvalidOperationException("No selected remote session state exists.");
        if (current.Lifecycle != required)
        {
            throw new InvalidOperationException(
                $"Selected remote session must be {required} for this transition.");
        }
        return current;
    }

    private static RemoteSelectedSessionMetadata Normalize(
        RemoteSelectedSessionMetadata metadata,
        DateTimeOffset now)
    {
        ArgumentNullException.ThrowIfNull(metadata);
        if (metadata.PendingApprovalCount is < 0 or > 999)
        {
            throw new ArgumentOutOfRangeException(
                nameof(metadata.PendingApprovalCount),
                "Remote approval count must be between 0 and 999.");
        }
        var started = metadata.SessionStartedAtUtc.ToUniversalTime();
        if (started > now.ToUniversalTime().AddMinutes(5))
        {
            throw new ArgumentException("Remote session start time is in the future.", nameof(metadata));
        }
        return metadata with
        {
            ProjectId = RemoteControlContractValidation.RequireIdentifier(
                metadata.ProjectId, nameof(metadata.ProjectId)),
            ProjectDisplayName = RemoteControlContractValidation.NormalizeDisplayName(
                metadata.ProjectDisplayName, nameof(metadata.ProjectDisplayName)),
            SessionId = RemoteControlContractValidation.RequireIdentifier(
                metadata.SessionId, nameof(metadata.SessionId)),
            SessionDisplayName = RemoteControlContractValidation.NormalizeDisplayName(
                metadata.SessionDisplayName, nameof(metadata.SessionDisplayName)),
            AgentId = RemoteControlContractValidation.RequireIdentifier(
                metadata.AgentId, nameof(metadata.AgentId)),
            AgentDisplayName = RemoteControlContractValidation.NormalizeDisplayName(
                metadata.AgentDisplayName, nameof(metadata.AgentDisplayName)),
            SessionStartedAtUtc = started
        };
    }

    private static void ValidateAcceptedAcknowledgement(
        RemoteControlPlaneAcknowledgement acknowledgement,
        long minimumRevision)
    {
        ArgumentNullException.ThrowIfNull(acknowledgement);
        if (!acknowledgement.Accepted || acknowledgement.ServerRevision < minimumRevision)
        {
            throw new InvalidOperationException(
                "The control plane did not confirm the selected-session state transition.");
        }
    }
}

/// <summary>
/// Maps the richer local lifecycle snapshot onto the current web worker's exact
/// heartbeat and stop-session request bodies. Authentication and the unique
/// X-Helmion-Nonce header stay outside these JSON bodies.
/// </summary>
public static class RemoteControlWebWireMapper
{
    public static RemoteRegisteredDesktopHeartbeatRequest Heartbeat(
        RemoteDesktopPresenceSnapshot presence)
    {
        ArgumentNullException.ThrowIfNull(presence);
        var session = presence.SelectedSession
            ?? throw new InvalidOperationException("A selected session is required for heartbeat registration.");
        if (session.Lifecycle is RemoteSelectedSessionLifecycle.Revoking
            or RemoteSelectedSessionLifecycle.Revoked
            or RemoteSelectedSessionLifecycle.Offline)
        {
            throw new InvalidOperationException(
                "A revoking, revoked or offline session must use stop-session rather than heartbeat.");
        }

        return new RemoteRegisteredDesktopHeartbeatRequest(
            RemoteControlApiRoutes.HeartbeatAction,
            presence.DesktopId,
            new RemoteHeartbeatSession(
                session.SessionId,
                new RemoteHeartbeatProject(session.ProjectId, session.ProjectDisplayName),
                session.SessionDisplayName,
                session.ActivityState switch
                {
                    RemoteSessionActivityState.Ready => "ready",
                    RemoteSessionActivityState.Working => "working",
                    _ => "blocked"
                },
                new RemoteHeartbeatAgent(
                    session.AgentId,
                    session.AgentDisplayName,
                    session.ActivityState switch
                    {
                        RemoteSessionActivityState.Ready => "idle",
                        RemoteSessionActivityState.Working => "working",
                        _ => "unavailable"
                    }),
                new RemoteHeartbeatGuard(
                    session.GuardState switch
                    {
                        RemoteGuardState.Normal => "quiet",
                        RemoteGuardState.Warning => "attention",
                        RemoteGuardState.Critical => "blocked",
                        _ => "unknown"
                    },
                    Detail: null)));
    }

    public static RemoteRegisteredDesktopStopSessionRequest StopSession(
        RemoteDesktopPresenceSnapshot presence)
    {
        ArgumentNullException.ThrowIfNull(presence);
        var session = presence.SelectedSession
            ?? throw new InvalidOperationException("A selected session is required for stop-session.");
        return new RemoteRegisteredDesktopStopSessionRequest(
            RemoteControlApiRoutes.StopSessionAction,
            presence.DesktopId,
            session.SessionId);
    }
}

public static class RemoteDesktopPresenceComposer
{
    public const int SchemaVersion = 1;

    public static RemoteDesktopPresenceSnapshot Create(
        RemoteDesktopEnrollmentDescriptor enrollment,
        string desktopDisplayName,
        string appVersion,
        RemoteDesktopPresenceState state,
        RemoteSelectedSessionSnapshot? selectedSession,
        DateTimeOffset? now = null)
    {
        ArgumentNullException.ThrowIfNull(enrollment);
        if (!enrollment.AccountOwned
            || enrollment.DesktopId is null
            || enrollment.InstallationId is null)
        {
            throw new InvalidOperationException(
                "Presence cannot be composed before account-confirmed desktop enrollment.");
        }
        var capturedAt = (now ?? DateTimeOffset.UtcNow).ToUniversalTime();
        if (enrollment.ExpiresAtUtc is { } expiry
            && expiry.ToUniversalTime() <= capturedAt)
        {
            throw new InvalidOperationException(
                "Presence cannot be composed with an expired desktop credential.");
        }
        if (state == RemoteDesktopPresenceState.Revoked)
        {
            throw new InvalidOperationException(
                "A revoked desktop cannot authenticate a presence publication.");
        }
        var normalizedName = RemoteControlContractValidation.NormalizeDisplayName(
            desktopDisplayName, nameof(desktopDisplayName));
        var normalizedVersion = RemoteControlContractValidation.NormalizeDisplayName(
            appVersion, nameof(appVersion));
        RemoteControlContractValidation.RequireIdentifier(
            enrollment.DesktopId, nameof(enrollment.DesktopId));
        RemoteControlContractValidation.RequireIdentifier(
            enrollment.InstallationId, nameof(enrollment.InstallationId));

        return new RemoteDesktopPresenceSnapshot(
            SchemaVersion,
            RemoteControlApiRoutes.ContractVersion,
            enrollment.DesktopId,
            enrollment.InstallationId,
            normalizedName,
            normalizedVersion,
            state,
            selectedSession,
            capturedAt);
    }
}
