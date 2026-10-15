# Getting into helmian.cloud/admin

Why it says "membership required": Clerk sign-in works, but Helmian only lets in
accounts that have a row in `helmion.tenant_memberships`. No owner row exists yet.

## One-time setup (Troy)
Option A — automatic first-owner claim (preferred):
```
fly secrets set -a helmian-cloud HELMION_ADMIN_OWNER_EMAIL=<your Clerk email> HELMION_ADMIN_BOOTSTRAP_TENANT=dairyforge HELMION_ADMIN_BOOTSTRAP_TENANT_NAME="DairyForge"
fly deploy
```
Then open https://helmian.cloud/admin/auth/login and sign in with that email
(verified in Clerk). You become owner of `dairyforge`. It only works while the
tenant has no owner, so it can't be reused.

Option B — fallback if Clerk doesn't send a verified email claim:
sign in, and the admin page shows "your sign-in ID: user_...". Then, with
HELMION_DATABASE_URL and HELMION_EXPECTED_ENDPOINT_ID set:
```
node bin/helmion-admin-bootstrap.mjs --tenant-id dairyforge --display-name DairyForge --subject user_... --confirm
```
