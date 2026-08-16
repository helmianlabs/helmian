# Helmian Cloud: Fly + Neon release procedure

Helmian Cloud is a separate service from AimForge, DairyForge, and marketing.
It runs Cora's guarded service on Fly and uses a dedicated Helmian Neon project
or dedicated Helmian database/branch. The existing local sample workflows,
tenant boundaries, policy gates, and audit contracts remain the application
behavior; a real provider connection is a separate, later integration step.

## Required external setup

1. Create or identify a **dedicated Helmian Cloud** Fly application. Do not use
   an existing DairyForge, AimForge, or marketing app.
2. In Neon, create or select the intended Helmian Cloud development/staging
   database and record its non-secret endpoint ID.
3. Apply the guarded migration procedure in `PHASE_TWO_NEON_RUNBOOK.md` to that
   database. This is explicit because migrations change external state.
4. In Fly secrets, set `HELMION_DATABASE_URL`, `HELMION_EXPECTED_ENDPOINT_ID`,
   `HELMION_CORA_TOKEN`, and the selected model provider key. Secrets are never
   placed in `fly.toml`, Git, shell history, or chat.
5. Copy `deploy/helmian-cloud/fly.toml.example` to a local ignored `fly.toml`,
   replace the app name with the verified Helmian Cloud app, and set the chosen
   region/environment. For production change `HELMION_CLOUD_ENVIRONMENT` to
   `production` only after staging verification.

## Preflight and deployment

Run the secret-free shape check in the Fly release environment:

```text
node bin/helmion-cloud-preflight.mjs
```

It verifies environment names, token presence/length, the provider key presence,
and that the Neon URL points at the asserted endpoint. It never prints secrets.

The same preflight now requires the live admin OIDC names
`HELMION_ADMIN_ISSUER`, `HELMION_ADMIN_CLIENT_ID`, and
`HELMION_ADMIN_REDIRECT_URI`. The redirect must be the deployed HTTPS Helmian
origin plus `/admin/auth/callback`; for the current canonical deployment that is
`https://helmian.cloud/admin/auth/callback`. The Fly app is already mounted
behind the canonical Vercel `/admin` and `/api/admin` rewrites, but external
Clerk callback completion remains an open release gate until the owner completes
one real sign-in. Before enabling that gate, the external identity administrator
must register the exact client and redirect. Then deploy with Fly from this
repository. The Fly app should pass its TCP
readiness check; authenticated `GET /healthz` is the application health check.

## Verify and rollback

After deployment, verify that the Fly TCP check is healthy, then call the
health endpoint with the deployment token and confirm Cora is ready. Run a
tenant-scoped sample workflow and verify its audit output before connecting a
live provider. Roll back with Fly's previous release mechanism if readiness or
the authenticated health check fails. Never point a rollback at another product's
Fly application.
