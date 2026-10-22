#!/usr/bin/env bash
# Run ON the Hetzner box as root. Expects the Guard source at /opt/executive-guard/src
# (git archive of the Guard branch) and this folder at /opt/executive-guard/deploy.
# First run generates the device + approver tokens into /opt/executive-guard/guard.env (600)
# and wires hands (GUARD_URL, GUARD_DEVICE_TOKEN, GUARD_DEVICE_ID, GUARD_PUBLIC_KEY_X). Prints no secrets.
set -euo pipefail
G=/opt/executive-guard
H=/opt/helmian-hands-mcp/app.env
docker network inspect helmian-net >/dev/null 2>&1 || docker network create helmian-net >/dev/null
umask 077
if [ ! -f $G/guard.env ]; then
  DEV=$(openssl rand -base64 36 | tr -d '/+=\n' | cut -c1-40)
  APP=$(openssl rand -base64 36 | tr -d '/+=\n' | cut -c1-40)
  printf 'EXEC_GUARD_DEVICE_TOKENS=hands-mcp=%s\nEXEC_GUARD_APPROVER_TOKENS=troy=%s\n' "$DEV" "$APP" > $G/guard.env
  unset DEV APP
fi
mkdir -p $G/data && chown 1000:1000 $G/data && chmod 700 $G/data
cp $G/deploy/Dockerfile $G/src/Dockerfile.guard
TAG="executive-guard:$(date +%Y%m%d-%H%M%S)"
docker build -q -f $G/src/Dockerfile.guard -t "$TAG" $G/src >/dev/null
docker rm -f executive-guard >/dev/null 2>&1 || true
docker run -d --name executive-guard --restart unless-stopped --network helmian-net \
  --env-file $G/guard.env -v $G/data:/data -p 127.0.0.1:8787:8787 \
  --memory 128m --read-only --tmpfs /tmp --cap-drop ALL --security-opt no-new-privileges "$TAG" >/dev/null
echo "$TAG" > $G/current-tag
for i in $(seq 1 20); do curl -fs 127.0.0.1:8787/healthz >/dev/null && break; sleep 1; done
X=$(curl -fs 127.0.0.1:8787/v1/keys | python3 -c 'import sys,json;print(json.load(sys.stdin)["publicKeyJwk"]["x"])')
DEVTOK=$(sed -n 's/^EXEC_GUARD_DEVICE_TOKENS=hands-mcp=//p' $G/guard.env)
sed -i '/^GUARD_/d' $H
printf 'GUARD_URL=http://executive-guard:8787\nGUARD_DEVICE_ID=hands-mcp\nGUARD_DEVICE_TOKEN=%s\nGUARD_PUBLIC_KEY_X=%s\n' "$DEVTOK" "$X" >> $H
unset DEVTOK
echo "guard up: $TAG keyX=$X"
