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

## Live CLM-port mount

The production Cora process mounts the live read-only handler only at `/admin`,
`/admin/auth/*`, and `/api/admin/*` on the same HTTP server. It does not serve
the site at `/`, does not intercept `/llm`, and does not change the Hume
WebSocket protocol. Admin HTML and JSON responses include a restrictive CSP,
frame denial, no-referrer, no-store, and browser-permission headers.

Every session and control-surface read requires both a verified OIDC session
and a current matching owner/admin row in `helmion.tenant_memberships`. Tenant
scope comes from that pair; URL/query tenant selectors are ignored. The surface
reports bounded read-only tool, release, migration, and audit readiness. It has
no migration, release, provider-call, enrollment, invitation, approval, or
identity-mutation endpoint.

External identity authority is still required before deployment. Register one
OIDC Authorization Code + PKCE client with these exact settings:

- issuer: `HELMION_ADMIN_ISSUER` (the chosen organization's HTTPS OIDC issuer);
- client ID: `HELMION_ADMIN_CLIENT_ID`;
- redirect URI: `https://<verified-helmian-host>/admin/auth/callback` exactly.

No issuer or client ID is invented in source. The deployment preflight reports
only missing environment-variable names, never their values. OIDC proves only
the Clerk subject with `openid profile email`; no token organization, role, or
public metadata is trusted. The tenant and current role are derived entirely
from active Neon memberships for that subject on every request. Exactly one
`owner` or `admin` membership proceeds. Zero denies access; more than one fails
closed until a server-issued picker bound to that membership set is built.

The live database begins with no tenant or membership. After OAuth and code
review, an operator may run the explicit one-time command below with the exact
Clerk subject selected by the owner. It verifies the asserted Neon endpoint,
requires all three named values plus `--confirm`, takes an advisory lock,
creates or exactly reads back one platform tenant and active owner membership,
and writes an audit event. It never runs during login and never auto-provisions.

```text
npm run cloud:admin-bootstrap -- --tenant-id <id> --display-name <name> --subject <Clerk subject> --confirm
```

Do not run it until the external OAuth application and exact subject have been
approved. This repository change does not enroll anyone or write production.
