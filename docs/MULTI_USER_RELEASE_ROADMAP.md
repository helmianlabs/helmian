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
