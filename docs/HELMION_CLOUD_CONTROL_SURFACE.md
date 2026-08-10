# Helmian Cloud control surface

The standalone Helmian Cloud control surface is a tenant-admin-only working
sample-mode foundation for tenant scope, integration readiness, approvals, and
audit posture. It has no cross-tenant selector, secret field, provider call, or
mutation endpoint.

Run `npm run cloud:admin` to open the working local sample site. It intentionally
refuses a public bind until the Cloud identity gateway is implemented; tenant and
role query values are sample fixtures, not authentication.

Load-board search has one normalized contract. DAT, Truckstop, and 123Loadboard
present deterministic sample results through the existing local adapter. Their
status remains `awaiting_integration` until the customer approves OAuth/API
connections. A future live adapter must preserve this shape and Helmian's policy,
audit, and approval boundaries.
