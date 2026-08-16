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
