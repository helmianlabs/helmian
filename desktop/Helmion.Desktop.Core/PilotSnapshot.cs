using System;
using System.Collections.Generic;
using System.Linq;
using Helmion.LocalService.Protocol;

namespace Helmion.Desktop.Core;

public enum PilotDataSource
{
    Live,
    Unconfigured
}

public sealed record WorkspaceSummary(
    string Name,
    string RootPath,
    string Branch,
    string LeaseHolder,
    string LeaseState,
    string NextAction);

public sealed record ActivityEvidence(
    string TimeLabel,
    string Title,
    string Detail,
    string Kind,
    bool IsDemo);

public sealed record HandoffEvidence(
    string Id,
    string Direction,
    string Status,
    string Summary,
    string Evidence,
    bool IsDemo);

public sealed record ApprovalPreview(
    string Title,
    string Risk,
    string PolicyOutcome,
    string Detail,
    bool IsActionable,
    bool IsDemo);

public sealed record OrchestrationEvent(
    string TimeLabel,
    string Actor,
    string Kind,
    string Title,
    string Summary,
    string EvidenceLabel,
    string EvidenceDetail,
    string RawDetail,
    bool IsDemo,
    bool IsEvidenceBacked);

public sealed record IntegrationSummary(
    string Name,
    string State,
    string Detail,
    string Guidance,
    string StatusLabel,
    bool AcceptsSecrets,
    bool IsLive);

public sealed record ReleaseCapability(
    string Area,
    string Target,
    string CurrentState,
    string ReleaseGate,
    string Phase);

public sealed record ReleasePhase(
    string Id,
    string Name,
    string Outcome,
    string Status);

public sealed class PilotSnapshot
{
    public required string ModeLabel { get; init; }
    public required PilotDataSource DataSource { get; init; }
    public required string DataSourceLabel { get; init; }
    public required string GeneratedAtLabel { get; init; }
    public required WorkspaceSummary Workspace { get; init; }
    public required IReadOnlyList<ActivityEvidence> RecentActivity { get; init; }
    public required IReadOnlyList<HandoffEvidence> Handoffs { get; init; }
    public required IReadOnlyList<ApprovalPreview> ApprovalQueue { get; init; }
    public required IReadOnlyList<OrchestrationEvent> OrchestrationEvents { get; init; }
    public required IReadOnlyList<IntegrationSummary> Integrations { get; init; }
    public required IReadOnlyList<ReleaseCapability> ReleaseCapabilities { get; init; }
    public required IReadOnlyList<ReleasePhase> ReleasePhases { get; init; }
    public required IReadOnlyList<string> NavigationItems { get; init; }
    public required string SelectedCoordinatorLabel { get; init; }
    public required bool LocalServiceConnected { get; init; }
    public required bool AdvancedOwnerSigningConfigured { get; init; }
    public required bool ExternalAuthorityGranted { get; init; }
    public required bool LowRiskLocalWorkEnabled { get; init; }

    public static PilotSnapshot CreateLive(
        bool serviceConnected,
        WorkspaceInspection? inspection,
        string databaseUrl,
        string apiKeys,
        string grokApiKey,
        string maestroCoordinator)
    {
        var hasDb = !string.IsNullOrWhiteSpace(databaseUrl);
        var hasKeys = !string.IsNullOrWhiteSpace(apiKeys) || !string.IsNullOrWhiteSpace(grokApiKey);

        var workspace = inspection != null
            ? new WorkspaceSummary(
                inspection.ProjectName,
                inspection.ProjectPath,
                inspection.Branch,
                inspection.Lease.Label,
                inspection.Lease.Detail,
                inspection.Lease.Status)
            : new WorkspaceSummary(
                "No registered workspace",
                "None",
                "None",
                "None",
                "Not active",
                "Select a local project workspace to get started");

        var activity = inspection?.Evidence
            .Select(e => new ActivityEvidence("Live", e.Name, e.Detail, e.Kind, false))
            .ToList() ?? new List<ActivityEvidence>();

        var integrations = new List<IntegrationSummary>
        {
            new(
                "Helmion local service",
                serviceConnected ? "Connected · live" : "Unavailable · disconnected",
                serviceConnected
                    ? "Current-user authenticated named-pipe service is active."
                    : "The background local service process is currently offline.",
                "Process is managed and hosted automatically by Helmion Pilot.",
                serviceConnected ? "ACTIVE / CONNECTED" : "NOT LIVE",
                false,
                serviceConnected),
            // A saved URL is not a connection and a saved key is not a session: both
            // rows below report only what having the value in settings actually proves.
            new(
                "Neon database",
                hasDb ? "URL saved · not connected" : "Not configured",
                hasDb
                    ? "A database URL is saved. Helmion has not opened a connection to it from this window."
                    : "No database URL is saved. Paste your connection URL in Settings.",
                "Direct connection to your isolated cloud developer database.",
                hasDb ? "SAVED · UNVERIFIED" : "NOT LIVE",
                true,
                false),
            new(
                "Provider adapters",
                hasKeys ? "API keys saved · not verified" : "Not configured",
                hasKeys
                    ? "API keys are saved locally. No request has been made to confirm they are valid."
                    : "API keys are not configured. Enter keys on the Settings page.",
                "API credentials are saved locally in Windows CurrentUser storage.",
                hasKeys ? "SAVED · UNVERIFIED" : "NOT LIVE",
                true,
                false)
        };

        var releaseCapabilities = new List<ReleaseCapability>
        {
            new(
                "Tenant isolation",
                "Organization → workspace → project boundaries enforced in API and database RLS",
                "Local workspace only · Multi-user not implemented",
                "Cross-tenant negative tests and reviewed RLS policy",
                "5C"),
            new(
                "Identity & roles",
                "OIDC identity with owner, admin, member, and read-only auditor roles",
                "Local Windows identity only · OIDC not configured",
                "Step-up authentication, session controls, and role matrix tests",
                "5C"),
            new(
                "Invitations",
                "Expiring, one-time, revocable invitations bound to tenant and intended role",
                "Single user local mode · Not implemented",
                "Abuse controls, audited acceptance, and subject binding",
                "5C"),
            new(
                "Approval authority",
                "Role-authorized, exact-action, expiring, one-time owner/admin decisions",
                "Optional local signing only · Authority not active",
                "Server authorization plus replay, revocation, and escalation tests",
                "5D"),
            new(
                "Audit history",
                "Immutable actor/action/target/result history with export and retention policy",
                "Local database history only · Retention policy not configured",
                "Append-only storage, outbox delivery, integrity and retention verification",
                "5C"),
            new(
                "Safe integrations",
                "Per-tenant OAuth grants and vaulted service credentials with least privilege",
                "Local secure DPAPI vault · Vaulted OAuth not configured",
                "Provider review, scoped tokens, revocation, and contract tests",
                "5D"),
            new(
                "Portable profiles",
                "Versioned Helmion Profile Package with Policy Pack, reviewed learning, mappings, and optional templates",
                "Local sync engine only · Import/rollback not configured",
                "Inventory, redaction, signed manifest, safe install, and rollback tests",
                "5D"),
            new(
                "Live orchestration",
                "Real-time routing, findings, tests, blockers, checkpoints, and handoffs with evidence links",
                "Local named-pipe channel active · Reconnect pending",
                "Typed event stream, provenance, redaction, evidence binding, reconnect, and scale tests",
                "5B"),
            new(
                "Installer & updates",
                "Signed Windows package, staged update channels, rollback, and SBOM",
                "Local developer build · Unsigned package",
                "Code signing, clean-machine install/update/uninstall matrix",
                "5E")
        };

        var releasePhases = new List<ReleasePhase>
        {
            new("5A", "Desktop foundation", "Native shell, explicit state provenance, packaging smoke", "IMPLEMENTED"),
            new("5B", "Local service", "Authenticated named-pipe API with read-only live state", "IN PROGRESS"),
            new("5C", "Multi-user control plane", "Tenants, roles, invitations, RLS, and immutable audit", "PLANNED"),
            new("5D", "Governed integrations", "Approval authority, OAuth custody, and write workflows", "PLANNED"),
            new("5E", "Release engineering", "Signed installer, updates, recovery, and test certification", "PLANNED")
        };

        return new PilotSnapshot
        {
            ModeLabel = "Personal Pilot",
            DataSource = serviceConnected ? PilotDataSource.Live : PilotDataSource.Unconfigured,
            // serviceConnected proves the named pipe answered — it says nothing about the database.
            DataSourceLabel = serviceConnected
                ? "Local service connected · database not verified"
                : "Service disconnected · enter configuration in Settings",
            GeneratedAtLabel = $"Active session · {DateTimeOffset.Now:MMM d, h:mm tt}",
            Workspace = workspace,
            RecentActivity = activity,
            Handoffs = new List<HandoffEvidence>(),
            ApprovalQueue = new List<ApprovalPreview>(),
            OrchestrationEvents = new List<OrchestrationEvent>(),
            Integrations = integrations,
            ReleaseCapabilities = releaseCapabilities,
            ReleasePhases = releasePhases,
            NavigationItems = new List<string>
            {
                "Overview",
                "Workspace",
                "Console",
                "Activity",
                "Evidence",
                "Approvals",
                "Integrations",
                "Release",
                "Settings"
            },
            SelectedCoordinatorLabel = maestroCoordinator,
            LocalServiceConnected = serviceConnected,
            AdvancedOwnerSigningConfigured = false,
            ExternalAuthorityGranted = false,
            LowRiskLocalWorkEnabled = serviceConnected
        };
    }
}
