# Helmian always-on box (Hetzner)

> **STATUS (2026-10-17): FUTURE PATH, NOT LIVE.** The box currently runs
> bridge-only via systemd (`deploy/helmian-bridge.service`, provisioned by
> `deploy/provision-runner.sh`): no Docker, no Caddy, no listening ports.
> This compose stack (Caddy + Kokoro voice server + relay) is the planned
> next step for when the box needs to serve voice and relay traffic. Do not
> run both paths on the same box without deciding which owns ports 80/443.


Runs only what Vercel can't keep alive: **Kokoro voice**, **Mark's relay**, and the **background worker**.
Website, /app, API routes, Neon and Clerk stay where they are. Nothing here is needed for Bryce's signup.

## Troy's steps (about 5 minutes, Hetzner Cloud Console)
1. Create a project named **Helmian**.
2. **Security → SSH keys → Add SSH key**, paste the public key Helmian gives you (starts `ssh-ed25519 … helmian-hetzner`). It's safe to share; it is not a password.
3. **Security → API tokens → Generate**, Read & Write, name `helmian-box`. Don't paste it in chat; it goes in via the secure secret request.
4. Tell Helmian **"go"**. Only then is the server created (cheapest Cost-Optimized CX, Ubuntu 24.04, IPv4, this folder's `cloud-init.yaml` as Cloud config). Billing starts at that point.
5. Approve two DNS A records pointing at the server IP: `voice.helmian.cloud`, `relay.helmian.cloud`.

## What Helmian does after "go"
```bash
ssh -i ~/.ssh/helmian_hetzner root@<ip>
cd /opt/helmian/deploy/hetzner && nano .env          # fill VOICE_TOKEN, HELMION_DATABASE_URL
docker compose up -d --build                          # caddy + kokoro + worker
# docker compose --profile relay up -d               # once a relay image exists
curl -s -H "Authorization: Bearer $VOICE_TOKEN" https://voice.helmian.cloud/v1/models
```
Firewall: 22/80/443 only, key login only (cloud-init). Also add a Hetzner Cloud Firewall with the same three ports.

## Notes
- Kokoro is behind a bearer token in Caddy so the voice endpoint isn't open to the internet.
- There is no standalone relay server in the repo yet; the `relay` service is opt-in via `RELAY_IMAGE`.
- No Fly. No secrets in git.
