# Self-hosting Helmian Cloud admin on one VPS (no Fly, no Neon)

Target: Hetzner CX22-class box (2 vCPU, 4 GB RAM, 40 GB disk, Ubuntu 24.04). Plenty for prototyping:
Postgres + the Node control plane idle at well under 1 GB.

What runs: the same server Fly runs today (`bin/helmion-cora.mjs`), which mounts the live admin
(`/admin`, `/api/admin/*`, OIDC login) and the Cora CLM socket (`/llm`). Database is a local
Postgres container instead of Neon. The DB target is still pinned (`self-hosted:<host>/<db>`), so a
wrong URL refuses to connect, same as the Neon `ep-` pin.

## 1. Server prep (once)
```bash
apt update && apt install -y docker.io docker-compose-v2 git ufw
ufw allow OpenSSH && ufw allow 80 && ufw allow 443 && ufw enable
git clone https://github.com/helmianlabs/helmian.git /opt/helmian && cd /opt/helmian/deploy/vps
cp .env.example .env && chmod 600 .env   # fill in values
```
Point DNS: `A admin.helmian.cloud -> <VPS IPv4>` (Caddy gets the TLS cert automatically).

## 2. Database + first admin
```bash
docker compose up -d db
docker compose --profile tools run --rm migrate          # applies sql/0xx_*.sql, idempotent, checksummed
docker compose run --rm --entrypoint node app bin/helmion-admin-bootstrap.mjs \
  --tenant-id <tenant> --display-name "Troy" --subject <your OIDC subject, e.g. Clerk user_...> --confirm
```

## 3. Start
```bash
docker compose up -d --build
curl -I https://admin.helmian.cloud/admin/      # 200
curl https://admin.helmian.cloud/api/admin/session   # 403 ADMIN_MEMBERSHIP_REQUIRED until you sign in
```

## 4. Make helmian.cloud/admin use it (later, Troy's call)
`web/marketing/vercel.json` rewrites `/admin` and `/api/admin/*` to `helmian-cloud.fly.dev`. To cut over,
change those three destinations to `https://admin.helmian.cloud/...` and set `HELMION_ADMIN_ORIGIN`
to `https://helmian.cloud` (the origin the browser sees), and the OIDC redirect URI to
`https://helmian.cloud/admin/auth/callback`. Not done in this PR; Fly keeps serving until then.

## Updates / backups
```bash
cd /opt/helmian && git pull && cd deploy/vps && docker compose --profile tools run --rm migrate && docker compose up -d --build
docker compose exec db pg_dump -U helmian_app helmion | gzip > ~/helmion-$(date +%F).sql.gz
```

## systemd alternative
`helmian-cloud.service` runs the same command without Docker (Node 20+, distro Postgres 16+,
Caddy/nginx in front). Migrate with
`HELMION_DATABASE_URL=... node bin/helmion.mjs migrate --expect-endpoint self-hosted:127.0.0.1/helmion`.

## Verified locally
Against Postgres 17 with `self-hosted:127.0.0.1/helmion`: migrate applied 001–034;
`/admin/` 200, `/admin/assets/app.js` 200, `/api/admin/session` 403 (membership required, same as
production), `/admin/auth/login` 503 only because the smoke used a fake issuer.
