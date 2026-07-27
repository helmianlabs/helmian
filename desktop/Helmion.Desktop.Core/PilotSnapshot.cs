namespace Helmion.Desktop.Core;

public enum PilotDataSource
{
    Demo
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
    public required bool LocalServiceConnected { get; init; }
    public required bool AdvancedOwnerSigningConfigured { get; init; }
    public required bool ExternalAuthorityGranted { get; init; }
    public required bool LowRiskLocalWorkEnabled { get; init; }

    public static PilotSnapshot CreateDemo(DateTimeOffset now)
    {
        return new PilotSnapshot
        {
            ModeLabel = "Personal Pilot",
            DataSource = PilotDataSource.Demo,
            DataSourceLabel = "Demo data · local service disconnected",
            GeneratedAtLabel = $"Preview generated {now:MMM d, h:mm tt}",
            Workspace = new WorkspaceSummary(
                "Helmion",
                @"E:\Helmion",
                "main · local working tree",
                "Codex · local pilot",
                "Local pilot active",
                "Connect the read-only local service when ready"),
            RecentActivity =
            [
                new(
                    "2 min",
                    "Pilot policy evaluated",
                    "Bounded local workspace work stayed inside routine guardrails.",
                    "POLICY",
                    true),
                new(
                    "18 min",
                    "Handoff evidence assembled",
                    "Checkpoint, test summary, and next safe action were grouped for review.",
                    "EVIDENCE",
                    true),
                new(
                    "34 min",
                    "Development schema verified",
                    "Checksummed migration inventory reported ready in an earlier guarded session.",
                    "DATABASE",
                    true),
                new(
                    "1 hr",
                    "Advisor notes collected",
                    "Read-only suggestions remain advisory and cannot grant execution authority.",
                    "ADVISORY",
                    true)
            ],
            Handoffs =
            [
                new(
                    "H-042",
                    "Codex → Personal pilot",
                    "Complete",
                    "Desktop shell scope accepted with local-only boundaries.",
                    "Checkpoint · 63 tests · next action recorded",
                    true),
                new(
                    "H-041",
                    "Maestro → Codex",
                    "Complete",
                    "Windows owner-signing workflow documented; setup remains optional.",
                    "Policy decision · no key material created",
                    true),
                new(
                    "H-040",
                    "Codex → Maestro",
                    "Released",
                    "Isolated development switch-test lease was released cleanly.",
                    "Committed checkpoint · lease release acknowledged",
                    true)
            ],
            ApprovalQueue =
            [
                new(
                    "Publish a production integration",
                    "HIGH RISK",
                    "Would require an explicit owner decision",
                    "Preview only. The personal pilot has no external deployment authority.",
                    false,
                    true),
                new(
                    "Rotate a trusted identity",
                    "HIGH RISK",
                    "Advanced owner signing is not configured",
                    "Optional workflow preview; no identity enrollment action is exposed here.",
                    false,
                    true)
            ],
            OrchestrationEvents =
            [
                new(
                    "00:00",
                    "USER → CODEX",
                    "ROUTE",
                    "Coordinator selected",
                    "Demo route: a user assigns a bounded workspace task to the selected provider.",
                    "DEMO ROUTE",
                    "A live event must identify the selected profile, exact task, and Maestro decision.",
                    "Redacted demo payload · no provider transcript recorded",
                    true,
                    false),
                new(
                    "00:04",
                    "MAESTRO",
                    "POLICY",
                    "Guardrails evaluated",
                    "Demo policy result: routine local read-only work is eligible to continue.",
                    "DEMO POLICY",
                    "A live event links the deterministic policy result and operation fingerprint.",
                    "Redacted policy fixture · no secret or private content",
                    true,
                    false),
                new(
                    "00:19",
                    "REVIEWER",
                    "FINDING",
                    "Potential defect surfaced",
                    "Demo claim only. A real “bug caught” event stays unverified until linked to a diff, failing test, or reproduction.",
                    "EVIDENCE REQUIRED",
                    "Required: file/diff identity plus test failure or deterministic reproduction.",
                    "No raw provider log exists · expandable area demonstrates the redacted link contract",
                    true,
                    false),
                new(
                    "00:31",
                    "CODEX → MAESTRO",
                    "BLOCKER",
                    "Blocker resolution proposed",
                    "Demo proposal only. Maestro cannot mark resolution durable from provider text alone.",
                    "PROOF REQUIRED",
                    "Required: exact blocker identity, empirical fix evidence, and durable acknowledgement.",
                    "Demo blocker B-017 · no live state changed",
                    true,
                    false),
                new(
                    "00:46",
                    "TEST RUNNER",
                    "EVIDENCE",
                    "Verification result attached",
                    "Fixture example of a test result that could support—but cannot authorize—a checkpoint.",
                    "FIXTURE TEST",
                    "Required live fields: command identity, exit result, scope, timestamp, and redacted output link.",
                    "Fixture only · tests were not launched by this screen",
                    true,
                    false),
                new(
                    "01:02",
                    "MAESTRO → CLAUDE",
                    "HANDOFF",
                    "Checkpoint and handoff assembled",
                    "Demo handoff showing the required chain from task to evidence to acknowledged checkpoint.",
                    "DEMO HANDOFF",
                    "A live handoff must reference a durable checkpoint and current lease state.",
                    "No Claude configuration, hook, session, or transcript was accessed",
                    true,
                    false)
            ],
            Integrations =
            [
                new(
                    "Helmion local service",
                    "Available · read-only",
                    "Current-user authenticated named-pipe service for live local workspace inventory.",
                    "The renderer receives typed non-secret state; write commands fail closed.",
                    false,
                    false),
                new(
                    "Neon development",
                    "Exact profile bound · not enrolled",
                    "The direct Helmion Development endpoint/database definition is fixed; no credential is loaded.",
                    "Future material stays in CurrentUser DPAPI and the typed read-only test must pass first.",
                    false,
                    false),
                new(
                    "Provider adapters",
                    "Registry split by auth surface",
                    "Codex CLI/OpenAI API and Gemini CLI/Gemini API are separate unconfigured profiles.",
                    "CLI sign-in stays provider-owned; API material stays service-protected.",
                    false,
                    false),
                new(
                    "Existing AI systems",
                    "Not inspected or managed",
                    "This pilot does not inspect or modify existing agent configuration.",
                    "Use explicit isolated profiles; never reuse or rewrite existing Claude/Gemini setup.",
                    false,
                    false)
            ],
            ReleaseCapabilities =
            [
                new(
                    "Tenant isolation",
                    "Organization → workspace → project boundaries enforced in API and database RLS",
                    "Single local workspace demo",
                    "Cross-tenant negative tests and reviewed RLS policy",
                    "5C"),
                new(
                    "Identity & roles",
                    "OIDC identity with owner, admin, member, and read-only auditor roles",
                    "Local Windows identity label only",
                    "Step-up authentication, session controls, and role matrix tests",
                    "5C"),
                new(
                    "Invitations",
                    "Expiring, one-time, revocable invitations bound to tenant and intended role",
                    "Not implemented",
                    "Abuse controls, audited acceptance, and subject binding",
                    "5C"),
                new(
                    "Approval authority",
                    "Role-authorized, exact-action, expiring, one-time owner/admin decisions",
                    "Optional local signing primitive",
                    "Server authorization plus replay, revocation, and escalation tests",
                    "5D"),
                new(
                    "Audit history",
                    "Immutable actor/action/target/result history with export and retention policy",
                    "Demo evidence timeline",
                    "Append-only storage, outbox delivery, integrity and retention verification",
                    "5C"),
                new(
                    "Safe integrations",
                    "Per-tenant OAuth grants and vaulted service credentials with least privilege",
                    "Local DPAPI store and redacted test contract; no enrollment or connection",
                    "Provider review, scoped tokens, revocation, and contract tests",
                    "5D"),
                new(
                    "Portable profiles",
                    "Versioned Helmion Profile Package with Policy Pack, reviewed learning, mappings, and optional templates",
                    "Architecture only; no user sources read",
                    "Inventory, redaction, signed manifest, safe install, and rollback tests",
                    "5D"),
                new(
                    "Live orchestration",
                    "Real-time routing, findings, tests, blockers, checkpoints, and handoffs with evidence links",
                    "Demo event contract only",
                    "Typed event stream, provenance, redaction, evidence binding, reconnect, and scale tests",
                    "5B"),
                new(
                    "Installer & updates",
                    "Signed Windows package, staged update channels, rollback, and SBOM",
                    "Unsigned local EXE",
                    "Code signing, clean-machine install/update/uninstall matrix",
                    "5E")
            ],
            ReleasePhases =
            [
                new("5A", "Desktop foundation", "Native shell, explicit state provenance, packaging smoke", "IMPLEMENTED SHELL"),
                new("5B", "Local service", "Authenticated named-pipe API with read-only live state first", "IN PROGRESS"),
                new("5C", "Multi-user control plane", "Tenants, roles, invitations, RLS, and immutable audit", "PLANNED"),
                new("5D", "Governed integrations", "Approval authority, OAuth custody, and write workflows", "PLANNED"),
                new("5E", "Release engineering", "Signed installer, updates, recovery, and test certification", "PLANNED")
            ],
            NavigationItems =
            [
                "Overview",
                "Workspace",
                "Console",
                "Activity",
                "Evidence",
                "Approvals",
                "Integrations",
                "Release",
                "Settings"
            ],
            LocalServiceConnected = false,
            AdvancedOwnerSigningConfigured = false,
            ExternalAuthorityGranted = false,
            LowRiskLocalWorkEnabled = true
        };
    }
}
