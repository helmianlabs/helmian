# Self-hosting Helmian on Hetzner

This guide takes you from zero to a running Helmian cloud with your own
always-on runner. You bring your own accounts; nothing is shared with us.

## What you need (accounts)

| Service | What for | Cost |
|---|---|---|
| Hetzner Cloud | The always-on runner box | ~€20.49/mo (cpx11, US) or ~€6.49/mo (cx23, EU) |
| Vercel | Hosts helmian.cloud (the web app + API) | Free (Hobby) to start |
| Neon | Postgres database (chat history, audit, leases) | Free tier to start |
| Clerk | Sign-in (email, Google, GitHub) | Free tier to start |
| Ably | Realtime pipe (chat push, Herald) | Free tier to start |

Total to start: the Hetzner box. Everything else has a free tier.

## 1. Create the Hetzner server

1. Sign up at hetzner.com/cloud (project name is up to you).
2. Create an API token (Security, API Tokens, Read & Write) if you want
   scripted management. Otherwise use the console.
3. Add a server:
   - Location: pick one near your Neon region (Hillsboro `hil` for US,
     Nuremberg `nbg1` / Falkenstein `fsn1` / Helsinki `hel1` for EU).
   - Image: Ubuntu 24.04.
   - Type: cpx11 (2 vCPU, 2 GB) in the US, or cx23 in the EU.
   - Add your SSH key.
4. Note the server's public IP.

Hetzner bills postpaid by the hour with a monthly cap. Powering a server
off does NOT stop billing; only deleting it does.

## 2. Provision the box

SSH in as root and run:

```bash
curl -fsSL https://raw.githubusercontent.com/helmianlabs/helmian/main/deploy/provision-runner.sh | bash
```

This installs Node 24, git, clones the repo to `/opt/helmian`, creates the
`helmian` user, and installs the base systemd unit. (Read the script first;
never pipe-to-bash blindly.)

## 3. Deploy the web app to Vercel

1. Push this repo (or your fork) to GitHub.
2. In Vercel, import the repo. Set the project root to `web/marketing`.
3. Add the environment variables (see `.env.example`):
   - `HELMION_DATABASE_URL` (Neon pooled connection string)
   - `HELMION_EXPECTED_ENDPOINT_ID` (Neon endpoint ID)
   - `CLERK_PUBLISHABLE_KEY`, `CLERK_SECRET_KEY`
   - `ABLY_API_KEY`
   - `HELMION_ADMIN_*` (admin console auth, see example)
4. Deploy. The build step (`vercel-build`) bundles the API backend.

## 4. Run the database migrations

From your own machine (with the repo cloned and `.env` holding your
`HELMION_DATABASE_URL`):

```bash
node bin/helmion.mjs migrate
```

The `migration inventory` error at the end is expected and harmless (it
comes from six retired migration slots, 035-040). Migrations apply first;
the check complains after.

## 5. Provision your tenant on the runner

SSH to the runner as root:

```bash
node /opt/helmian/bin/provision-tenant.mjs --slug <your-name> --tenant-id <tenant-uuid> --provider gemini
```

Find your tenant UUID in the cloud database (`helmion.tenants` table).
The script creates a Linux user, a private vault, a workspace directory,
and starts a dedicated bridge: `helmian-bridge@<your-name>.service`.

## 6. Pair and connect a provider

1. In the web app, go to Settings and generate a pairing code.
2. On the runner, add it to `/etc/helmian/tenants/<your-name>.env` as
   `HELMION_BRIDGE_PAIRING_CODE=<code>`, then restart:
   `systemctl restart helmian-bridge@<your-name>.service`.
   Remove the code line after the first successful start.
3. Store your provider key (never in the cloud, never in chat):
   `sudo -u helmian-t-<your-name> node /opt/helmian/bin/runner-vault.mjs store gemini`
4. Check: `journalctl -u helmian-bridge@<your-name> -n 20`
   You want `agent ready`, `presence reported`, and `transport: Ably push`.

## 7. Add more tenants

Repeat step 5-6 per tenant. Each gets an isolated Linux user, vault, and
bridge. One cpx11 comfortably holds dozens of light tenants.

## Costs as you grow

- 1 box (~$22/mo) serves dozens of users on the light path.
- Heavier use: add a second box and split tenants across them, or move a
  tenant to a bigger type. The tenant slug makes moves explicit.
- The SaaS math: at $20-50/seat, one shared box pays for itself many times
  over. Price tiers by compute (shared, priority, dedicated box).

## Security notes

- Provider keys live in the per-tenant vault on the runner, encrypted with
  a key derived from the tenant's device token. They never touch Vercel,
  Neon, or chat.
- Tenant homes are `0700`; registry and env files are root-only `0600`.
- The systemd template adds `ProtectHome=read-only` and
  `NoNewPrivileges=true` per tenant instance.
- Keep the box updated: `unattended-upgrades` is enabled by the provision
  script, but check periodically.
