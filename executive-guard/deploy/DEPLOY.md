# Self-hosting Executive Guard on a Hetzner box behind Caddy

This is a recipe. Nothing in this repository deploys anything. It assumes a fresh Hetzner Cloud server (Ubuntu 24.04, 1 vCPU and 2 GB are plenty), a DNS name pointing at it (here `guard.example.com`), and SSH access as a sudo user.

## What runs where

- **Caddy** runs on the host. It takes 80 and 443, handles TLS, and proxies to `127.0.0.1:8787`.
- **The container** listens on `127.0.0.1:8787` only. It runs as uid 10001, not root.
- **Two named volumes:**
  - `eg-keys` holds `/var/lib/executive-guard/keys/signing-key.pem`. The Ed25519 key is created on first start with mode 0600. Losing it means every client has to pin a new key from `/v1/keys`.
  - `eg-audit` holds two files:
    - `/var/lib/executive-guard/audit/audit.jsonl`, the hash-chained audit. The server refuses to start if the chain doesn't verify.
    - `/var/lib/executive-guard/audit/state.jsonl`, the restart state (mode 0600). It holds pending approvals, the one signed decision issued for each approval, and used nonces (stored as SHA-256). Its location can be overridden with `EXEC_GUARD_STATE_PATH`.
- **What survives a restart:**
  - A pending approval can still be listed, polled and approved, and its decision binds the original nonce.
  - A decision already issued for an approval is returned unchanged.
  - Used nonces and recorded outcomes stay used.
  - Approvals that expired while the server was down are marked expired and audited on start.
- **How it's kept consistent:**
  - Every change is written to the state file first, with fsync, and then to the audit. The audit is the source of truth for an approval's status.
  - If a crash leaves an approval approved in the state file but the audit doesn't confirm it, it stays pending. If a decision was signed but its audit line is missing, the audit line is written again and marked `recovered`.
  - If the state file is lost, approvals the audit still shows as pending are closed (`approval.expired`, reason `state-unavailable-after-restart`). The device asks again; nothing becomes approvable by accident.
  - On start the state file is compacted: expired nonces and finished approvals older than 24 h are dropped.
- **Back up `state.jsonl` together with `audit.jsonl`.** It contains the device nonces and the redacted action summaries of pending approvals.

## 1. Host

```sh
sudo apt-get update && sudo apt-get install -y docker.io caddy ufw
sudo ufw allow OpenSSH && sudo ufw allow 80,443/tcp && sudo ufw enable
```

Docker's published ports bypass ufw, so the `127.0.0.1:` prefix on `-p` below matters.

## 2. Image

From a checkout of this repository, at the repo root:

```sh
docker build -f executive-guard/deploy/Dockerfile -t executive-guard:$(git rev-parse --short HEAD) .
```

## 3. Secrets

```sh
sudo install -d -m 700 /etc/executive-guard
sudo install -m 600 executive-guard/deploy/executive-guard.env.example /etc/executive-guard/executive-guard.env
sudoedit /etc/executive-guard/executive-guard.env   # replace every CHANGE_ME
```

Generate each token with `openssl rand -base64 33 | tr '+/' '-_' | tr -d '='`. Never commit the filled-in file.

## 4. Run

```sh
docker volume create eg-keys
docker volume create eg-audit
docker run -d --name executive-guard --restart unless-stopped \
  --env-file /etc/executive-guard/executive-guard.env \
  -p 127.0.0.1:8787:8787 \
  -v eg-keys:/var/lib/executive-guard/keys \
  -v eg-audit:/var/lib/executive-guard/audit \
  --read-only --tmpfs /tmp --cap-drop ALL --security-opt no-new-privileges \
  executive-guard:<tag>
docker inspect --format '{{.State.Health.Status}}' executive-guard   # "healthy" after ~10 s
curl -s http://127.0.0.1:8787/v1/keys                                 # note keyId and publicKeyJwk.x
```

## 5. Caddy

Add `executive-guard/deploy/Caddyfile.snippet` to `/etc/caddy/Caddyfile`, set the hostname, then:

```sh
sudo caddy validate --config /etc/caddy/Caddyfile && sudo systemctl reload caddy
curl -s https://guard.example.com/healthz     # {"ok":true,"service":"executive-guard"}
```

## 6. Point clients at it

- **Hands connector:** set `GUARD_URL=https://guard.example.com`, `GUARD_DEVICE_TOKEN` (its token from the env file), `GUARD_DEVICE_ID=hands-mcp`, and `GUARD_PUBLIC_KEY_X` (the `publicKeyJwk.x` from step 4, read over the local port, not copied from a page). It can report results to `POST /v1/audit/outcomes` (see `../docs/OUTCOMES.md`).
- **Guard extension:** in the popup, set the Executive Guard URL and its device token.

## Backups and key rotation

- Back up both volumes, for example with `docker run --rm -v eg-audit:/a -v $PWD:/b alpine tar czf /b/eg-audit-$(date +%F).tgz -C /a .`, and the same for `eg-keys`. Store the key backup encrypted.
- Check the chain at any time: `curl -H "Authorization: Bearer <approver token>" https://guard.example.com/v1/audit/verify`.
- **Key rotation:** stop the container, move `signing-key.pem` aside inside the volume, and start again. A new key is generated. Clients must re-pin; the old audit stays valid.

## Upgrade

Build the new tag, then `docker stop executive-guard && docker rm executive-guard`, then repeat the `docker run` from step 4 with the new tag. The volumes carry the key, the audit and the restart state across, so pending approvals stay approvable. Docker sends SIGTERM and the server closes cleanly. A client polling during the gap sees connection errors for a few seconds; hands fails closed for that call and the approval is still there when it polls again.
