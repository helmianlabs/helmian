#!/usr/bin/env node
// Provision a tenant sandbox on a Helmian runner box (Hetzner or any Linux).
// Run as root: node bin/provision-tenant.mjs --slug <slug> --tenant-id <id> [--provider gemini]
//
// Creates:
//   - Linux user helmian-t-<slug> (no password, no sudo)
//   - /home/helmian-t-<slug>/{AppData/Roaming/Helmian,.helmian,workspace}
//   - /etc/helmian/tenants/<slug>.json (registry entry, root-only)
//   - /etc/helmian/tenants/<slug>.env (per-tenant bridge env, root-only)
//   - Enables + starts helmian-bridge@<slug>.service (systemd template unit)
//
// The tenant then pairs via the /app Settings link button (one pairing code),
// and stores provider keys with: sudo -u helmian-t-<slug> node bin/runner-vault.mjs store <provider>
// The bridge reads token + vault from the tenant user's own home directory,
// so tenants cannot see each other's credentials or files.

import { execFile } from 'node:child_process';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { promisify } from 'node:util';

const exec = promisify(execFile);

const args = process.argv.slice(2);
const get = (flag) => {
  const i = args.indexOf(flag);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : null;
};

const slug = get('--slug');
const tenantId = get('--tenant-id');
const provider = get('--provider') || 'gemini';

if (!slug || !/^[a-z0-9-]{1,32}$/.test(slug)) {
  console.error('Usage: node bin/provision-tenant.mjs --slug <slug> --tenant-id <id> [--provider gemini]');
  console.error('  slug: lowercase letters, digits, hyphens, max 32 chars');
  process.exit(1);
}
if (!tenantId) {
  console.error('Missing --tenant-id (the tenant UUID from your Helmian cloud).');
  process.exit(1);
}
if (process.getuid?.() !== 0) {
  console.error('This script must run as root (it creates system users).');
  process.exit(1);
}

const user = `helmian-t-${slug}`;
const home = `/home/${user}`;
const tenantsDir = '/etc/helmian/tenants';

const run = async (cmd, cmdArgs) => {
  try {
    const { stdout } = await exec(cmd, cmdArgs);
    return stdout.trim();
  } catch (error) {
    throw new Error(`${cmd} ${cmdArgs.join(' ')} failed: ${error.message}`);
  }
};

console.log(`Provisioning tenant '${slug}' as system user '${user}'...`);

// 1. Create the user (idempotent: skip if exists).
try {
  await exec('id', [user]);
  console.log(`User ${user} already exists, reusing.`);
} catch {
  await run('useradd', ['--create-home', '--home-dir', home, '--shell', '/bin/bash', user]);
  console.log(`Created user ${user}.`);
}

// 2. Tenant directories.
for (const dir of [
  `${home}/AppData/Roaming/Helmian`,
  `${home}/.helmian`,
  `${home}/workspace`,
]) {
  await mkdir(dir, { recursive: true });
  await run('chown', [`${user}:${user}`, dir]);
  await run('chmod', ['700', dir]);
}
console.log('Tenant directories ready.');

// 3. Registry entry (root-only).
await mkdir(tenantsDir, { recursive: true });
const registryPath = `${tenantsDir}/${slug}.json`;
const entry = {
  slug,
  tenantId,
  user,
  home,
  provider,
  createdAt: new Date().toISOString(),
};
await writeFile(registryPath, JSON.stringify(entry, null, 2) + '\n', { mode: 0o600 });
console.log(`Registry entry written: ${registryPath}`);

// 4. Per-tenant bridge env (root-only). The pairing code is consumed on first
// start; afterwards the persisted device token in the tenant's home takes over.
const envPath = `${tenantsDir}/${slug}.env`;
const envContent =
  `# Helmian bridge env for tenant '${slug}' (root-only, 0600)\n` +
  `HELMION_BRIDGE_PROVIDER=${provider}\n` +
  `HELMION_BRIDGE_TENANT_SLUG=${slug}\n` +
  `# One-time: uncomment and set to pair headless, then remove after first start.\n` +
  `# HELMION_BRIDGE_PAIRING_CODE=\n`;
await writeFile(envPath, envContent, { mode: 0o600 });
console.log(`Bridge env written: ${envPath}`);

// 5. Enable + start the per-tenant bridge instance.
await run('systemctl', ['daemon-reload']);
await run('systemctl', ['enable', `helmian-bridge@${slug}.service`]);
await run('systemctl', ['restart', `helmian-bridge@${slug}.service`]);
console.log(`Bridge instance helmian-bridge@${slug}.service started.`);

console.log('');
console.log('Done. Next steps for this tenant:');
console.log(`  1. Pair: generate a pairing code in /app Settings and either`);
console.log(`     - set HELMION_BRIDGE_PAIRING_CODE in ${envPath}, then`);
console.log(`       systemctl restart helmian-bridge@${slug}.service`);
console.log(`     - or run the bridge once interactively as ${user} and paste the code.`);
console.log(`  2. Store provider key: sudo -u ${user} node /opt/helmian/bin/runner-vault.mjs store ${provider}`);
console.log(`  3. Check status: journalctl -u helmian-bridge@${slug} -n 20`);
console.log('');
console.log(`To remove this tenant later: systemctl disable --now helmian-bridge@${slug}.service && userdel -r ${user} && rm ${registryPath} ${envPath}`);
