# Cora full tenant-surface contract

`src/cora/full-surface-command-contract.mjs` is the bounded consumer registry
for Cora's future operations surface. It extends the existing four-intent
planner without changing its schema or Helmian's local orchestration provider
contracts.

The registry currently names the known tenant-facing surfaces: dashboard,
activity, dispatch board, fleet, truck detail, loads, load detail, driver,
pre-trip, payroll, documents, money, settlements, integrations, settings,
help, notifications, and approvals. Each entry has a stable surface ID and
consumer page ID, supported non-executing operations, role posture, and sample
availability. New surfaces are additive registry entries rather than a new
special-case intent.

`listCoraTenantSurfaces()` returns the complete posture for exactly one explicit
sample tenant scope. The caller must supply one `authorized_tenant_ids` value,
and it must equal `tenant_id`; a missing, mismatched, multi-tenant, or unknown
sample scope fails closed. This is a scope assertion for a future authorized
caller, not a membership lookup or an authorization grant. A production caller
must verify active tenant membership before calling it.

`previewCoraTenantSurface()` accepts only `mode: "sample"` and the operations
`open`, `read`, `select`, `control`, `prepare`, and `simulate`. `control` is a
simulation-only posture, never a live UI or provider control. Requests contain only
bounded allowlisted selectors (`record_id`, `filter`, `limit`, and payroll
`period`); unknown fields, free-form payloads, sensitive keys, cross-tenant
sample IDs, unknown surfaces, unsupported operations, and disallowed roles
return stable failure codes without echoing input.

Every successful result is frozen and explicitly carries:

- `mode: "sample-data-only"` and a tenant-keyed mock snapshot;
- `enabled: false`, `wired: false`, and `execution: "not-wired"`;
- `mutation`, `submission`, and `notification` as `not-performed`;
- `authorization: "not_evaluated"` and `invocation: "not_performed"`; and
- a bounded deterministic audit reference.

Payroll, settlements, and approval-handoff preparation retain confirmation and
approval requirements with `decision: "pending"`. No operation can execute,
mutate, submit, notify, approve, authorize, contact a provider, or control a
browser. `sample-unavailable` surfaces remain representable in the registry
and return an explicit unavailable result rather than fabricated data.
