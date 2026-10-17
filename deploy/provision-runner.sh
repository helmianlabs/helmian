#!/usr/bin/env bash
# Provision a Helmian runner box (Hetzner or any Ubuntu 24.04 Linux).
# Run as root: curl -fsSL https://raw.githubusercontent.com/helmianlabs/helmian/main/deploy/provision-runner.sh | bash
#
# Does what the manual Hetzner setup did:
#   - Node 24, git, unattended-upgrades
#   - Non-root `helmian` user (base tenant; extra tenants via bin/provision-tenant.mjs)
#   - Repo cloned to /opt/helmian
#   - systemd unit helmian-bridge.service (single-tenant base; template unit
#     helmian-bridge@.service covers additional tenants)
#   - Root-only /etc/helmian/bridge.env (0600)
#
# After this: deploy the web app (see docs/self-host-hetzner.md), run the
# migrations, then pair the base tenant and store its provider key.
# Read this script before piping it to bash.

set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then
  echo "Run as root." >&2
  exit 1
fi

echo "==> Installing Node 24, git, upgrades..."
apt-get update -qq
apt-get install -y -qq ca-certificates curl gnupg git unattended-upgrades > /dev/null
mkdir -p /etc/apt/keyrings
curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key \
  | gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg
echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_24.x nodistro main" \
  > /etc/apt/sources.list.d/nodesource.list
apt-get update -qq
apt-get install -y -qq nodejs > /dev/null
node --version

echo "==> Creating helmian user..."
if ! id helmian > /dev/null 2>&1; then
  useradd --create-home --home-dir /home/helmian --shell /bin/bash helmian
  echo "Created user helmian."
else
  echo "User helmian already exists."
fi

echo "==> Cloning repo to /opt/helmian..."
if [ ! -d /opt/helmian/.git ]; then
  git clone --depth 1 https://github.com/helmianlabs/helmian.git /opt/helmian
else
  echo "/opt/helmian already cloned; pulling latest."
  git -C /opt/helmian pull --ff-only || true
fi
chown -R helmian:helmian /opt/helmian

echo "==> Installing base bridge dependencies..."
sudo -u helmian bash -c 'cd /opt/helmian && npm ci --omit=dev 2>&1 | tail -2 || npm install --omit=dev 2>&1 | tail -2'
# The ably package must be present for push transport (prod dep, but verify).
sudo -u helmian bash -c 'cd /opt/helmian && node -e "import(\"ably\").then(() => console.log(\"ably OK\")).catch(() => { console.log(\"installing ably...\"); })"'
if ! sudo -u helmian bash -c 'cd /opt/helmian && node -e "import(\"ably\")"' 2>/dev/null; then
  sudo -u helmian bash -c 'cd /opt/helmian && npm install ably --no-save'
fi

echo "==> Writing /etc/helmian/bridge.env (root-only)..."
mkdir -p /etc/helmian
if [ ! -f /etc/helmian/bridge.env ]; then
  cat > /etc/helmian/bridge.env << 'EOF'
# Helmian bridge env (base tenant). Root-only, 0600.
# Provider keys do NOT go here; they go in the per-user vault via bin/runner-vault.mjs.
HELMION_BRIDGE_PROVIDER=gemini
# One-time: set to pair headless, then remove after the first successful start.
# HELMION_BRIDGE_PAIRING_CODE=
EOF
  chmod 600 /etc/helmian/bridge.env
  echo "Wrote /etc/helmian/bridge.env (edit provider as needed)."
else
  echo "/etc/helmian/bridge.env already exists; leaving it."
fi

echo "==> Installing systemd units..."
cp /opt/helmian/deploy/helmian-bridge.service /etc/systemd/system/helmian-bridge.service
cp /opt/helmian/deploy/helmian-bridge@.service /etc/systemd/system/helmian-bridge@.service
systemctl daemon-reload
systemctl enable helmian-bridge.service
echo "Units installed. The bridge is NOT started yet (pair first)."

echo ""
echo "Done. Next steps:"
echo "  1. Deploy the web app and run migrations (docs/self-host-hetzner.md)."
echo "  2. Pair: set HELMION_BRIDGE_PAIRING_CODE in /etc/helmian/bridge.env,"
echo "     then: systemctl start helmian-bridge.service"
echo "  3. Store provider key: sudo -u helmian node /opt/helmian/bin/runner-vault.mjs store gemini"
echo "  4. Check: journalctl -u helmian-bridge -n 20"
echo "  5. Extra tenants: node /opt/helmian/bin/provision-tenant.mjs --slug <slug> --tenant-id <id>"
