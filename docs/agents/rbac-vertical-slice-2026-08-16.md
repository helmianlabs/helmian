# RBAC/ABAC vertical slice work log

> The hard 45-min / 60-min handoff cap is RETIRED. Do NOT schedule a checkpoint at session start, do NOT stop forward work at 45/60 min, and do NOT force a handoff on the clock. What replaces it is the source-of-truth, full-tracing, CSI-audit, stamp, and verified-push discipline.

> Every factual claim I make to Troy must satisfy BOTH gates. Cite the primary source where the claim lives and trace every chain explicitly A→B→C→…→N with a citation on EVERY arrow. A chain with ONE uncited arrow IS the lie. If any link cannot be cited, mark the gap; do not claim completion.

## Scope

This work log covers only the Helmian Cloud tenant workspace-project registration vertical slice. Forge TMS, domains, Cora provider wiring, and unrelated systems are out of scope.

## Mandatory audit questions

1. TRACE the return value, don't grep the function — where does its return value persist? Cite the writer's file:line or stamp GAP.
2. READ the body of every important-sounding name — names lie.
3. Verify against CODE, not a prior handoff.
4. Give sub-AIs the CODE, not the handoff.
5. "Shipped" ≠ "wired end-to-end" — draw A→B→C→D→E, each transition cited.

## Code trace

`OIDC session subject` → `activeTenantActor` derives the only active tenant membership and role in `src/cloud/live-admin.mjs:302-326` → `requireActiveTenantMembership` rechecks the role inside a transaction in `src/core/tenant-context.mjs:79-101` → `authorizeTenantAction` checks tenant equality and role policy in `src/cloud/tenant-action-authorization.mjs:17-42` → denied writes persist a `DENY` audit receipt in `src/cloud/tenant-action-authorization.mjs:44-88` → allowed writes persist project metadata and an `ALLOW` audit receipt in one transaction in `src/cloud/workspace-project-repository.mjs:30-42` → `live-admin` returns the authorization and receipt result to the browser in `src/cloud/live-admin.mjs:893-911` → the UI renders the denial receipt in `web/cloud-admin/app.js:937-944`.

## Authority edge

The live OIDC session and Neon membership row are external runtime authority. This work proves the code seam and local route tests; actual live identity/Neon receipt evidence remains a deployment gate until the deployed route is exercised with owner, admin, and member identities.

## Deployment evidence

- Combined branch `4bb4701` is pushed to `origin/codex/helmian-rbac-vertical-slice` with zero ahead/behind: `git rev-list --left-right --count origin/codex/helmian-rbac-vertical-slice...HEAD` returned `0 0`.
- Fly deployment `deployment-01M04CXQGWR4675HNY7BRAJSFX` completed as release `v49`; machine `0803e9db390658` reached `started` with one passing check. The deployment command was `fly deploy --app helmian-cloud --remote-only`.
- Live checks: `https://helmian-cloud.fly.dev/admin/` returned `200`; `/admin/assets/app.js` returned `200` with 95,718 bytes; unauthenticated `/api/admin/session` returned `403`; canonical `https://helmian.cloud/admin/assets/app.js` returned `200` and canonical `/api/admin/session` returned `403`.
- Full repository test run passed `1,282` tests, failed `0`, skipped `2`; the focused cloud-admin/RBAC suite passed `34/34`. Live owner/admin/member sign-in and Neon receipt evidence is still `UNVERIFIED`.
