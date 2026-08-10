# Helmion multi-user release roadmap

## Product posture

The current WPF application is a real native desktop foundation with an
offline Personal Pilot mode. It is not yet a multi-user release. The release
work below is an architecture and acceptance plan, not an implemented-feature
claim.

Personal Pilot remains useful and visually distinct:

- bounded, reversible local work can proceed under deterministic guardrails;
- demo data is visibly labeled;
- optional local owner signing may remain unconfigured; and
- the shell has no external, destructive, credential, or production authority.

## Tonight's locked public-release execution plan

Scope is frozen to the approved list below. UI defects and verification needed
to ship it may be fixed; no adjacent product idea is part of this release.

1. **Finish the desktop work surface.** Keep normal Windows-maximized startup;
   make F11 true captionless full screen; provide familiar independent left- and
   right-panel toggles; remove remaining border overlays, technical session
   footer text, clipped labels, migration-name clipping, and responsive defects.
2. **Complete project handoff.** After Create, select the new project and refresh
   Workspace and Console immediately. Fresh customer installs default to
   `Documents\Helmian Projects`; existing `E:\Helmion` data is never moved,
   renamed, or replaced.
3. **Complete the bounded workbench.** Right-side tabs are Guard, Browser,
   Canvas, Preview, and Create. Canvas holds project notes/decisions; Browser and
   Preview are non-executing surfaces.
4. **Complete Artifact Studio.** Images, PDFs, documents, slides, spreadsheets,
   and design assets use official provider APIs or approved SDKs only. Before any
   provider send/create, show provider, destination, data scope, and an explicit
   approval gate; record successful outputs in the active project's artifact
   history and Preview.
5. **Verify the release candidate.** Run policy, provider-contract, project,
   accessibility, responsive-layout, packaging, clean-start, and rollback checks
   without weakening Guard, approval, or audit behavior.

Architecture constraints remain fixed: Neon is the Maestro coordination/audit
layer; consumer CLI bridges and terminal workarounds are prohibited; Slack and
GitHub replacement work and optional integrations are deferred; branding and
the logo are unchanged unless correcting an existing defect.

## Target architecture

```text
Windows desktop
  presentation, owner interaction, system-browser sign-in
              │
              │ authenticated Windows named pipe
              ▼
Per-user Helmion local service
  workspace observation, policy evaluation, adapter process boundary
              │
              │ TLS + short-lived user/service authorization
              ▼
Multi-user control plane
  identity │ tenants │ memberships │ invitations │ approvals │ audit
              │
              ├── tenant-scoped PostgreSQL data
              ├── append-only audit/outbox
              └── managed integration secret vault
```

On Windows, prefer an ACL-restricted named pipe bound to the interactive user
SID over an unauthenticated loopback port. If a loopback protocol is retained,
it needs an equivalent per-session authentication and origin-binding design.
The desktop renderer must never become the credential store or database
client.

## Tenant and workspace isolation

The durable hierarchy is:

```text
tenant
  membership
  workspace
    project
      lease
      checkpoint
      handoff
      approval
      integration binding
```

Every shared row must carry a non-null tenant identity, either directly or
through an immutable tenant-owned parent. Every API route resolves one
authenticated tenant context before any repository operation.

PostgreSQL enforcement should include:

- row-level security on all tenant-owned tables;
- transaction-local tenant and actor context set by a narrowly scoped service
  role;
- tenant IDs in uniqueness and foreign-key boundaries where required;
- no administrator-style application connection that silently bypasses RLS;
- migration checks that reject newly added unscoped tables; and
- adversarial cross-tenant read/write tests for every repository method.

Application filters alone are not an isolation boundary.

## Authentication and roles

Use a supported OIDC provider with Authorization Code + PKCE in the system
browser. Validate issuer, audience, nonce, signature, time, and tenant claims
server-side. Keep refresh material in an OS- or service-protected store, never
the WPF visual tree, command arguments, logs, or source files.

Minimum tenant roles:

| Role | Intended authority |
| --- | --- |
| Owner | Tenant security, owner succession, destructive tenant actions, trust and highest-risk approvals |
| Admin | Membership, invitations, workspace policy, and approved integration administration |
| Member | Routine workspace work within assigned project and policy boundaries |
| Auditor | Read-only evidence, audit history, exports, and compliance review |

Do not infer approval rights merely from write access. High-risk authority is
an explicit permission evaluated against action scope, risk class, tenant,
workspace, current role, session strength, and any required separation of
duties.

## Invitations and membership

An invitation is:

- tenant-bound and created by an authorized owner/admin;
- bound to an intended role and, when policy requires, an intended
  email/domain or identity-provider organization;
- stored as a hash, not a reusable bearer value;
- short-lived, one-time, revocable, and rate-limited;
- accepted only after authenticated subject verification; and
- audited at creation, delivery request, acceptance, expiry, revocation, and
  role assignment.

Acceptance must not let the recipient substitute another tenant, role, or
identity subject. Owner invitations and owner succession need stronger
step-up and recovery rules than ordinary member invitations.

## Approval authority

Preserve the existing exact-action properties:

- canonical action hash;
- tenant, workspace, project, and handoff binding;
- verified actor and authorization decision;
- short issue/expiry window;
- one-time durable consumption;
- revocation and role-change checks; and
- idempotent retry semantics.

Multi-user approval is not magic text and is not advisor consensus. A service
must authorize the human session and role, require step-up authentication
where policy calls for it, record approve/decline in immutable audit history,
and consume the decision in the same durable operation boundary as the
governed action.

Optional local Ed25519 owner signing can remain a defense-in-depth or offline
recovery path. It must not become the only general team-authentication scheme.

## Audit history

Every security-relevant state change needs an append-only event with:

- tenant, workspace, and project;
- actor subject, role snapshot, session/authentication strength;
- action type, canonical target, request/correlation ID;
- policy version and decision;
- before/after references or a privacy-reviewed summary;
- acknowledged result and failure classification; and
- trusted server timestamp.

Use a transactional outbox so the state change and audit emission cannot
silently diverge. Define retention, export, legal hold, integrity verification,
redaction, and privileged audit-access policies before production.

## Safe integrations

Integrations are tenant-owned grants, not desktop text fields.

- Use provider OAuth or explicitly supported service-account flows.
- Keep refresh tokens and private credentials in a managed encrypted vault.
- Record grant owner, scopes, provider tenant/account, expiry, and revocation.
- Default to read-only scopes, then separately authorize write capabilities.
- Bind each governed write to tenant, workspace, lease, policy, and actor.
- Isolate provider webhooks with signature validation, replay protection, and
  tenant routing.
- Never scrape provider keys, create accounts automatically, or import
  existing Claude/Gemini configuration.

## Windows release engineering

The production package needs:

- a stable application identity and upgrade code;
- Authenticode signing from protected release infrastructure;
- MSIX or reviewed MSI packaging with least-privilege install behavior;
- signed update manifests and staged stable/beta rings;
- downgrade/rollback and failed-update recovery;
- SBOM, dependency provenance, malware scan, and artifact hashes;
- clean install, upgrade, repair, rollback, and uninstall tests; and
- accessibility, DPI, multi-monitor, offline, proxy, and supported-Windows
  matrix coverage.

The present local `.exe` is unsigned and is not an installer.

## Verification strategy

Release gates include:

1. unit and property tests for policy, canonicalization, and replay resistance;
2. tenant-isolation tests that attempt cross-tenant access through every API;
3. authentication, role, invitation, expiry, revocation, and step-up tests;
4. approval race, idempotency, stale-role, and one-time-consumption tests;
5. audit/state atomicity and outbox recovery tests;
6. provider sandbox and contract tests with fault injection;
7. named-pipe identity and desktop/local-service protocol tests;
8. WPF accessibility and automated screen/navigation smoke tests;
9. signed installer/update/rollback tests on clean Windows images;
10. backup restore, disaster recovery, key rotation, and incident exercises;
11. dependency, secret, static, dynamic, and penetration testing; and
12. a privacy and threat-model review before any production tenant data.

## Enterprise AI governance and audit-readiness build track

This is a cross-phase build and evidence plan, not legal advice, a compliance
claim, or a claim that Helmion is certified. **SOC 2 is a future assurance
objective, not a current certification.** Organize the AI governance program
against the NIST AI Risk Management Framework first; consider eventual
ISO/IEC 42001 adoption only after the operating scope, owners, and repeatable
controls exist.

### Helmian Cloud product direction

Helmian Cloud is a standalone multi-agent governance product, not merely an
internal AimForge feature. AimForge may consume Helmian Cloud as a governed
orchestration layer, while other individual, company, and enterprise customers
can connect their own approved agents, models, domains, and business systems.
Cora is a Helmian Cloud capability: a governed operator interface and agent
participant, rather than a tenant's unchecked source of authority.

The product must support a clear deployment boundary between:

- customer applications such as AimForge;
- the Helmian Cloud control plane for identities, tenant policy, approvals,
  audit evidence, and integration grants; and
- customer-owned model, agent, tool, data, and provider environments.

Its enterprise governance roadmap has five required capabilities:

1. **Discovery and inventory.** Record approved agents, models, tools,
   connectors, data classes, owners, environments, and their current posture.
   Discovery findings must be reviewable; unverified findings must not be
   treated as facts or silently disabled.
2. **Runtime guardrails.** Evaluate each governed tool call, data request, and
   agent-to-agent handoff against tenant policy before execution. Block or hold
   privilege escalation, cross-tenant requests, prohibited data transfer, and
   unapproved high-risk actions.
3. **Least-privilege access.** Use tenant-owned OAuth grants or supported
   service identities, narrow scopes, expiration, revocation, and just-in-time
   elevation bound to a specific approved task. No shared desktop login or
   long-lived plaintext credential is a cloud integration boundary.
4. **Correlated observability.** Join model, agent, tool, approval, policy,
   data-class, and outcome events into one tenant-scoped trace. Evidence must
   show what was requested, what policy decided, who approved when required,
   and what actually happened, without storing unnecessary raw sensitive data.
5. **Compliance evidence mapping.** Map implemented controls and retained
   evidence to NIST AI RMF first, then to customer-specific requirements such
   as SOC 2, HIPAA, or the EU AI Act where applicable. A framework label is not
   a certification or a substitute for legal, security, or independent audit
   review.

Build in this order: inventory and policy model; governed sample adapters and
traces; OAuth/service-connection vaulting; runtime enforcement and approval
flows; evaluation, retention, export, and compliance evidence; then
customer-specific production enablement. Real provider actions remain disabled
until the relevant integration, data handling, role policy, and approval path
are implemented and verified.

Required build artifacts:

- a tenant-aware capability inventory that marks each function released,
  pilot-only, simulated, disabled, or unavailable
- a documented use-case risk assessment and risk owner for every AI capability
- a data map covering source, tenant, purpose, minimization/redaction,
  provider transfer, retention, deletion, and incident handling
- model/provider/prompt/policy/schema change controls with version, evaluation,
  approval, staged rollout, rollback, and customer-impact records
- versioned representative, edge, stale, adversarial, prohibited-use, and
  cross-tenant evaluation fixtures with reproducible results
- authentication, authorization, pairing, expiry, replay, revocation,
  tenant-isolation, data-boundary, and prohibited-action security tests
- immutable policy/approval/audit evidence and incident detection,
  containment, recovery, notification-decision, and corrective-action records
- dated pilot/customer acceptance, rejection, exception, limitation, and
  remediation records tied to the exact capability and version evaluated

No AI capability may automate employment, discipline, compensation, or
termination decisions or reduce safety/driver signals to an opaque score.
Those signals require traceable evidence, explanation, and human review for
support. Legal review of the consequential-decision use case and the applicable
product/customer state footprint is a prerequisite to enabling any such use,
not a post-launch cleanup item.

### Evidence gates

| Gate | Evidence required to pass |
|---|---|
| **Pre-pilot** | Approved capability inventory, risk assessment, data/retention map, provider-neutral interface, change-control record, evaluation baseline, access/security test results, incident procedure, prohibited-use results, and completed legal review where consequential use is proposed. Critical failures block entry. |
| **Pilot** | Named participants, tenant/device/capability scope, exact model/provider/policy versions, immutable decisions and incidents, evaluation results after every material change, access reviews, and explicit customer/pilot acceptance or exception records. Scope expansion requires a new gate. |
| **Post-pilot** | Reconciliation of promised versus observed behavior; incident and remediation closure; access, retention/deletion, and change-log review; evaluation regression report; customer acceptance/limitations; and an approved go, revise, or stop decision. An independent readiness assessment precedes any assurance claim. |

These artifacts must be versioned, attributable, retention-controlled, and
exportable without granting the Auditor role operational authority. Framework
mapping follows implemented evidence; a checklist never substitutes for a
working control.

## Delivery phases

### 5A — Desktop foundation (implemented shell)

Native WPF shell, explicit data provenance, demo/live distinction, safe
settings, app-owned visual smoke rendering, and Windows package smoke.

### 5B — Local service (in progress)

ACL-restricted named pipe, typed/versioned protocol, health/reconnect state,
read-only project/lease/handoff/history views, and structured diagnostics.
Writes remain disabled at this phase.

The current slice implements current-user-only named-pipe authentication,
expected-server process validation, versioned hello, selected-workspace source
inventory, filename-only CLI capability detection, and fail-closed write
rejection. Durable lease/handoff/history reads, protected provider profiles,
health/reconnect hardening, and adapter canaries remain.

### 5C — Multi-user control plane

OIDC, tenant/membership schema, roles, invitations, database RLS, immutable
audit/outbox, admin APIs, and cross-tenant certification.

### 5D — Governed integrations

Vaulted OAuth grants, provider adapters, role-aware exact-action approvals,
lease-bound writes, revocation, Policy Pack/Profile Package review, and
integration contract certification.

### 5E — Release engineering

Threat-model closure, signed installer, update rings, telemetry/privacy
controls, clean-machine matrices, recovery exercises, and production release
approval.

No phase is complete merely because its UI is visible.
