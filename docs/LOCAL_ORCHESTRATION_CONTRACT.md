# Helmion local orchestration contract

`src/core/local-orchestration.mjs` is the first local-only orchestration
foundation behind a future Cora hands surface. It exposes stable, bounded
contract data and deterministic mock results for three product domains:

- `fleet-eld-mock`: tenant-scoped truck location and status reads;
- `load-board-mock`: basic-criteria load-board search;
- `payroll-mock`: payroll-work preparation plans.

These providers are deliberately not adapters to live services. Every
contract states `transport: "none"`, `network: "disabled"`,
`credentials: "none"`, and `mutations: "disabled"`. The fixtures are local,
fixed, tenant-keyed data. No credential, API call, external transport,
notification channel, database operation, or payroll write exists in this
module.

## Scope and safe output

Every service requires an explicit `tenant_id` and `actor_role`. Tenant IDs and
roles are normalized through the existing tenant-context contract; fixture
selection is an exact tenant-key lookup, so a request cannot receive another
tenant's mock rows. The role is scope shape only and is returned in every
result with `authorization: "not_evaluated"`. Membership and live authority
remain outside this pure local module.

All outputs are frozen, bounded, deterministic, and expose audit-friendly IDs.
Invalid scope, provider, criteria, limits, or sensitive/unsupported fields fail
closed to a stable category code. Raw errors, credentials, targets, and
unbounded provider payloads do not cross the service boundary.

## Domain services

`readFleetStatus` returns safe truck IDs, status, city/state, observation time,
and a deterministic `audit_id`. `searchLoadBoard` accepts only basic origin,
destination, equipment, and pickup-date criteria and returns safe load IDs,
route, equipment, date, miles, rate, and `audit_id`.

`preparePayrollWork` accepts a bounded period and worker-hour inputs only. It
returns a deterministic pending plan with worker audit IDs and hour totals; it
does not accept approval, confirmation, submit, commit, or execution fields.
The plan always carries `approval_required: true`,
`confirmation_required: true`, `decision: "pending"`,
`authorization: "not_evaluated"`, `invocation: "not_performed"`, and
`mutation: "not_performed"`. Only owner/admin role-shaped requests may form a
plan; this local capability check is not membership authorization.

There is intentionally no approval endpoint, notification path, provider
transport, executor, or payroll mutation function here. A future Cora/Aim
Forge consumer may request these safe contract results and must perform its
own active membership, authority, human-confirmation, and invocation checks.

## Request envelope and inspection

`buildOrchestrationRequestEnvelope` accepts one of the three operation names:
`fleet_status_read`, `load_board_search`, or `payroll_work_prepare`. It
validates the operation-specific metadata, tenant/role scope, provider binding,
request ID, and policy version, then returns a frozen
`helmion.orchestration-request.v1` envelope. The envelope contains a
deterministic request digest and audit ID, but never copies the truck filter,
route criteria, worker IDs, hours, or other request parameters. It carries only
a bounded parameter shape summary.

`inspectOrchestrationRequest` accepts that envelope plus the caller's explicit
tenant/role scope. It verifies exact fields, operation/provider binding,
approval posture, bounded summary shape, and the self-bound audit ID. It
returns only a frozen `helmion.orchestration-request-inspection.v1` summary or
a stable failure code. Inspection is not membership authorization, approval,
confirmation, invocation, notification, transport, or mutation.

## Integration readiness registry

`localIntegrationReadinessRegistry` is the extensible local readiness catalog
for the three product surfaces. Its descriptors are bound to the mock provider
registry and are rejected if their surface/provider binding, capabilities, or
safety state drifts. The current descriptors report:

- `fleet-eld-readiness` for fleet/ELD;
- `load-board-readiness` for load-board search;
- `payroll-readiness` for payroll work.

`listLocalIntegrationReadiness` and `inspectLocalIntegrationReadiness` require
explicit tenant/role scope and return only frozen audit-safe state. Every
descriptor is `mock_only`, `awaiting_user_connection`,
`connection: "not_configured"`, `credential_state: "not_present"`, with
transport, execution, and mutations disabled. Payroll additionally reports
`owner_admin_prepare` and `approval_required: true`; an auditor/member can see
that posture but cannot be treated as eligible to prepare payroll work.

Readiness is descriptive, not authorization. No descriptor probes a provider,
reads credentials, opens a connection, sends data, grants approval, invokes an
action, or changes a tenant record. A future live integration must introduce a
separate reviewed state transition after explicit user connection and active
tenant membership checks.
