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

## Live CLM-port mount and bounded runtime policy

The production Cora process mounts the live handler only at `/admin`,
`/admin/auth/*`, and `/api/admin/*` on the same HTTP server. It does not serve
the site at `/`, does not intercept `/llm`, and does not change the Hume
WebSocket protocol. Admin HTML and JSON responses include a restrictive CSP,
frame denial, no-referrer, no-store, and browser-permission headers.

Every session and control-surface read requires both a verified OIDC session
and a current matching owner/admin row in `helmion.tenant_memberships`. Tenant
scope comes from that pair; URL/query tenant selectors are ignored. The surface
reports bounded tool, release, migration, and audit readiness. It has no
migration, release, provider-call, enrollment, invitation, approval, or
identity-mutation endpoint.

Migrations `007_platform_action_policy.sql` and
`008_equipment_safety_action_policy.sql` define the only live mutation currently
available: platform-global kill switches for the six fixed Helmian hands. The
sole manager is an active owner/admin of the exact `helmian-platform` tenant.
The schema uses six boolean columns rather than accepting tool names, customer
tenant IDs, URLs, commands, providers, models, or secret values. These switches
can only remove actions from the compiled release; they cannot add authority or
expand what a signed AimForge session may do. The API exposes:

- `GET /api/admin/action-policy`, with a version ETag;
- `POST /api/admin/action-policy/preview`, which requires that ETag and writes
  an audit event but does not change the policy; and
- `POST /api/admin/action-policy/confirm`, which consumes one actor-bound,
  platform-tenant-bound, five-minute preview and atomically writes only if the
  version still matches.

Both writes revalidate the current Clerk subject against the exact live Neon
`helmian-platform` owner/admin membership. A URL or body cannot select a
customer tenant. Unknown fields,
unknown actions, duplicate actions, stale versions, reused previews, oversized
bodies, and previews created by another actor fail closed. Successful previews,
successful confirms, and authenticated denials are durably audited; all route
outcomes also emit bounded logs without policy bodies, subjects, tenant IDs, or
secrets.

The runtime reads this one global policy when it creates **every new
cryptographically signed AimForge session**, regardless of the customer's
tenant ID, and intersects it with the fixed compiled tool release. A facility
or plant is only a physical business record and is not an identity,
organization, tenant, routing, authorization, RBAC/ABAC, or allowed-facility
scope.
The signed bridge and AimForge APIs still derive and enforce the actual customer
tenant, subject, role, focus, and action authorization; the platform policy does
not replace or widen those checks. Active sessions are not mutated. A missing
row retains the six fixed compiled hands; a database read failure does not
fall back and the new signed session fails closed. Hume has zero attached tools
in the custom-language-model configuration—these are Helmian hands executed by
the CLM.

Provider and model selection are intentionally absent. The current CLM resolves
its provider and model at process startup, so presenting either as a hot tenant
setting would be false. Changing them still requires an explicit deployment or
restart through the existing environment/CLI contract. There is also no generic
HTTP, shell, workspace, approve, send, or arbitrary action editor.

External identity authority is still required before deployment. Register one
OIDC Authorization Code + PKCE client with these exact settings:

- issuer: `HELMION_ADMIN_ISSUER` (the chosen organization's HTTPS OIDC issuer);
- client ID: `HELMION_ADMIN_CLIENT_ID`;
- redirect URI: `https://helmian.cloud/admin/auth/callback` exactly for the current canonical Helmian Cloud deployment. The Fly runtime also receives `HELMION_ADMIN_ORIGIN=https://helmian.cloud`; this prevents the Vercel-to-Fly proxy from emitting the Fly hostname as the OAuth callback.

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
npm run cloud:admin-bootstrap -- --tenant-id helmian-platform --display-name "Helmian Platform" --subject <Clerk subject> --confirm
```

Do not run it until the external OAuth application and exact subject have been
approved. This repository change does not enroll anyone or write production.
