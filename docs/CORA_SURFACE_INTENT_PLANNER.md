# Cora typed surface-intent planner

`src/cora/surface-intent-planner.mjs` is the narrow typed seam between a future
voice/UI classifier and the full tenant-surface preview contract. It recognizes
only six fixed intent IDs:

- `open-surface`
- `read-surface`
- `select-surface`
- `control-surface`
- `prepare-surface`
- `simulate-surface`

The planner does not interpret free-form speech. A future parser must first
produce the exact bounded shape `{ surface, request }`; this module then maps
the known intent to the corresponding operation and delegates validation,
tenant scope, role posture, sample availability, and redaction to
`previewCoraTenantSurface()`.

The returned `cora.surface-intent-plan.v1` is frozen and preview-only. It
retains the tenant-scoped request summary and nested surface preview while
preserving `enabled: false`, `wired: false`, `execution: "not-wired"`,
`authorization: "not_evaluated"`, and `invocation: "not_performed"`.

Unknown intents, missing request shape, cross-tenant scope, unsupported
surfaces, sensitive/free-form fields, unavailable sample surfaces, and role
violations fail closed without echoing the rejected input. `control-surface`
and `simulate-surface` are simulated previews only; they do not control a UI,
send notifications, mutate data, submit work, approve anything, or contact a
provider. Payroll preparation still carries pending confirmation and approval
gates.

