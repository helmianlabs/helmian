# Clerk unify: point Herald at witty-sawfly-97 (Troy checklist)

Today /app + /admin sign in on Clerk **witty-sawfly-97**; Herald (`/herald`, `/api/remote/*`, `/api/herald-*`) uses **crucial-wildcat-22**. Herald reads only env vars, so no code change is required for the switch itself.

## 1. Get the keys (Clerk dashboard → witty-sawfly-97 → Configure → API keys)
- Publishable key `pk_live_…` (or `pk_test_…`)
- Secret key `sk_live_…`

## 2. Vercel → project **helmian** → Settings → Environment Variables (Production, then Preview)
| Name | New value |
|---|---|
| `CLERK_PUBLISHABLE_KEY` | witty-sawfly-97 pk |
| `CLERK_SECRET_KEY` | witty-sawfly-97 sk |
| `HELMION_HERALD_CLERK_AUTHORIZED_PARTIES` | `https://helmian.cloud,https://www.helmian.cloud,https://helmian.vercel.app` (comma list, origins only — no paths or trailing slash, or config goes "misconfigured") |

Leave unchanged: `HELMION_HERALD_ENROLLMENT_PEPPER` (≥32 chars), `ABLY_API_KEY`, admin OIDC vars used by /app and /admin.

## 3. Clerk witty-sawfly-97 settings
- Domains / allowed origins: helmian.cloud (+ www, + helmian.vercel.app for previews).
- Session token: default JWT is fine. Herald checks `azp` against the authorized-parties list above and needs `sub = user_…`. No custom JWT template needed.
- Sign-ups Public + email code (also needed for Bryce).

## 4. Redeploy + verify
1. Redeploy helmian (Vercel → Deployments → Redeploy).
2. `GET https://helmian.cloud/api/herald-config` → `accountIdentity.state` = `ready`, publishableKey starts with the new pk.
3. Optional: `node web/marketing/scripts/check-remote-production-readiness.mjs`.
4. Sign in at /app → Devices should load (401 before = expected).

## Side effects
- Everyone signed in to /herald is signed out once; Clerk users are per instance, so crucial-wildcat-22 accounts don't carry over. Sign in again with the witty-sawfly-97 account (same email as /app).
- Desktop enrollments are tied to the old Clerk user id → each desktop must be **re-paired** (EXE shows new 8-digit code → /app Devices → enroll, or /herald).
- Phone pairing links / installed PWA keep working after re-sign-in.
- Rollback: put the crucial-wildcat-22 values back and redeploy.
