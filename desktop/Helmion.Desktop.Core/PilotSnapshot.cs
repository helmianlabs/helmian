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

/// <summary>
/// The workspace card's contents. The four lease fields are the four honest states
/// <c>inspectLease</c> reports (src/core/lease.mjs:437-486), carried separately
/// instead of being crushed into two prose strings — the previous shape put the
/// lease LABEL in <c>LeaseHolder</c> and the DETAIL in <c>LeaseState</c>, so no
/// caller could branch on the actual status.
/// </summary>
public sealed record WorkspaceSummary(
    string Name,
    string RootPath,
    string Branch,
    string LeaseStatus,
    string LeaseLabel,
    string LeaseDetail,
    bool LeaseIsLive,
    string NextAction)
{
    /// <summary>The status word, for a template that must not carry it in colour alone.</summary>
    public string LeaseStatusText => string.IsNullOrWhiteSpace(LeaseStatus) ? "UNKNOWN" : LeaseStatus;

    /// <summary>
    /// Colour key. ACTIVE is the only value that earns the accent colour; UNREADABLE
    /// is a failure, not an absence, so it does not share NONE's quiet grey.
    /// </summary>
    public string LeaseLevelKey => LeaseStatusText switch
    {
        "ACTIVE" => "Normal",
        "STALE" => "Warning",
        "UNREADABLE" => "Critical",
        "NONE" => "Quiet",
        _ => "Unknown"
    };
}

public sealed record ActivityEvidence(
    string TimeLabel,
    string Title,
    string Detail,
    string Kind,
    bool IsDemo)
{
    /// <summary>
    /// Bound by MainWindow.xaml's ActivityTemplate. Before 2026-07-29 this flag
    /// existed and NO xaml read it, while the card above the list said "LIVE" over
    /// every row — a demo row and a live row rendered identically.
    /// </summary>
    public string ProvenanceLabel => IsDemo ? "DEMO" : "LIVE";

    public bool IsLive => !IsDemo;
}

public sealed record HandoffEvidence(
    string Id,
    string Direction,
    string Status,
    string Summary,
    string Evidence,
    bool IsDemo)
{
    /// <summary>Bound by HandoffTemplate, which used to print the literal "LIVE" on every row.</summary>
    public string ProvenanceLabel => IsDemo ? "DEMO" : "LIVE";
}

public sealed record ApprovalPreview(
    string Title,
    string Risk,
    string PolicyOutcome,
    string Detail,
    bool IsActionable,
    bool IsDemo)
{
    /// <summary>
    /// Bound by ApprovalTemplate, which used to print the literal "PENDING APPROVAL"
    /// on every row regardless of whether the row could be acted on at all.
    /// </summary>
    public string ProvenanceLabel => IsDemo
        ? "DEMO · NOT ACTIONABLE"
        : IsActionable
            ? "PENDING APPROVAL"
            : "PREVIEW ONLY · NOT ACTIONABLE";

    public string ActionabilityLabel => IsActionable
        ? "Actionable"
        : "Preview only";
}

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
    bool IsEvidenceBacked)
{
    /// <summary>
    /// Bound by OrchestrationEventTemplate, which used to print the literal
    /// "LIVE EVENT" on every row while both of these flags went unread. An event with
    /// no evidence link now says so on its face.
    /// </summary>
    public string ProvenanceLabel => IsDemo
        ? "DEMO EVENT"
        : IsEvidenceBacked
            ? "LIVE EVENT · EVIDENCE LINKED"
            : "LIVE EVENT · NO EVIDENCE LINK";
}

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

        // The lease now comes from LeaseInspector reading the real
        // <workspace>\.helmion\lease.json, and it is carried through with its status
        // intact so a template can branch on ACTIVE / STALE / NONE / UNREADABLE.
        // With no workspace registered there is no lease file to read, so the honest
        // answer is UNKNOWN — not "None", which would claim we looked.
        var noWorkspaceLease = LeaseInspector.NoWorkspace();
        var workspace = inspection != null
            ? new WorkspaceSummary(
                inspection.ProjectName,
                inspection.ProjectPath,
                inspection.Branch,
                inspection.Lease.Status,
                inspection.Lease.Label,
                inspection.Lease.Detail,
                inspection.Lease.IsLive,
                "Local source inventory is live. Writes still require the write lease.")
            : new WorkspaceSummary(
                "No registered workspace",
                "None",
                "Unknown",
                noWorkspaceLease.Status,
                noWorkspaceLease.Label,
                noWorkspaceLease.Detail,
                noWorkspaceLease.IsLive,
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
                "Process is managed and hosted automatically by Helmian.",
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
                // Corrected 2026-08-03. This said "saved locally in Windows
                // CurrentUser storage", which reads as DPAPI CurrentUser
                // protection. It is not. EnvironmentSettingsStore.Save writes
                // KEY=value lines with File.WriteAllLines
                // (EnvironmentSettingsStore.cs:186) into a plain .env file. Real
                // DPAPI code does exist in ProtectedProviderProfileStore, but
                // nothing on this path calls it.
                //
                // A safety product does not get to describe its own credential
                // storage as more protected than it is. The accurate string costs
                // nothing and tells the user what to actually guard.
                "API credentials are saved as plain text in a local .env file. They are not encrypted.",
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
            ModeLabel = "Helmian",
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
