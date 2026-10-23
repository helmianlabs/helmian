#!/usr/bin/env node
// Helmian hands: PC spoke.
//   node bin/hands-spoke.mjs pair [--url https://hands.5-78-222-178.sslip.io] [--roots "E:\Helmion;D:\work"]
//       asks for the hands passphrase (the same one as the memory connector) and saves
//       %APPDATA%\Helmian\hands-spoke.json. Run once. The passphrase is never stored.
//   node bin/hands-spoke.mjs pin-guard <ed25519 x>
//       pins the Executive Guard public key. Until this is done every mutating job is refused.
//   node bin/hands-spoke.mjs request-root <absolute folder> --reason "why"
//       writes a root-request record (grants nothing) to send to the hub for a human
//       approval. See docs/hands/ROOT_GRANTS.md.
//   node bin/hands-spoke.mjs add-root-grant <grant.json>
//       verifies a signed root-grant envelope against the pinned Guard key and stores
//       it in %APPDATA%\Helmian\roots.grants.json. The folder becomes READ-ONLY hands
//       access for this PC only; mutating tools still refuse under it.
//   node bin/hands-spoke.mjs list-root-grants
//       lists the grants that currently verify (and any that were rejected, with why).
//   node bin/hands-spoke.mjs revoke-root-grant <grantId | absolute folder>
//       removes a grant. Access closes immediately; no restart needed.
//   node bin/hands-spoke.mjs            run in the foreground (the HelmianBridge service runs it for you)
import { readFile, stat, writeFile } from 'node:fs/promises';
import { readHidden } from '../src/hands/hidden-input.mjs';
import { DEFAULT_HANDS_URL, defaultConfigPath, defaultRootGrantsPath, defaultSpokeDeviceId, pairSpoke, readSpokeConfig, startSpoke } from '../src/hands/pc-spoke.mjs';
import { activateRootGrant, createRootRequest, loadRootGrants, revokeRootGrant, saveRootRequest } from '../src/hands/root-grants.mjs';
import { verifyRootGrant } from '../hands-mcp/src/shared/protocol.mjs';

function flag(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
}

async function pairedConfig() {
  const cfg = await readSpokeConfig();
  if (!cfg) { console.error('Pair first: node bin/hands-spoke.mjs pair'); process.exit(2); }
  return cfg;
}

const cmd = process.argv[2];
if (cmd === 'pair') {
  const url = (flag('url') || DEFAULT_HANDS_URL).replace(/\/+$/, '');
  const roots = (flag('roots') || process.env.HELMIAN_ROOT || process.cwd()).split(';').map((s) => s.trim()).filter(Boolean);
  const passphrase = process.env.HELMIAN_HANDS_PASSPHRASE || (await readHidden('Hands passphrase: ')).trim();
  const r = await pairSpoke({ url, passphrase, roots });
  console.log(`Paired as ${r.deviceId}. Workspace roots: ${r.roots.join(', ')}. Saved ${r.configPath}. Restart the HelmianBridge service (or run this without "pair").`);
} else if (cmd === 'pin-guard') {
  const x = process.argv[3];
  if (!/^[A-Za-z0-9_-]{43}$/.test(x || '')) { console.error('Usage: pin-guard <43-char base64url Ed25519 x from Guard GET /v1/keys>'); process.exit(2); }
  const cfg = await readSpokeConfig();
  if (!cfg) { console.error('Pair first: node bin/hands-spoke.mjs pair'); process.exit(2); }
  await writeFile(defaultConfigPath(), JSON.stringify({ ...cfg, guardPublicKeyX: x }, null, 2), { mode: 0o600 });
  console.log('Executive Guard key pinned. Mutating actions now need a human Guard approval that this PC verifies.');
} else if (cmd === 'request-root') {
  const rootPath = process.argv[3];
  const reason = flag('reason');
  if (!rootPath || !reason) { console.error('Usage: request-root <absolute folder> --reason "why this folder"'); process.exit(2); }
  const cfg = await pairedConfig();
  const st = await stat(rootPath).catch(() => null);
  if (!st?.isDirectory()) { console.error(`Not a folder: ${rootPath}`); process.exit(2); }
  const deviceId = cfg.deviceId || defaultSpokeDeviceId();
  const request = createRootRequest({ rootPath, reason, requester: deviceId, spokeDeviceId: deviceId });
  const path = await saveRootRequest({ request });
  console.log(`Root request ${request.requestId} saved to ${path}.`);
  console.log('It grants nothing by itself. Send the request to the hub; after a human approves it there, bring the signed grant back and run: node bin\\hands-spoke.mjs add-root-grant <grant.json>');
} else if (cmd === 'add-root-grant') {
  const grantFile = process.argv[3];
  if (!grantFile) { console.error('Usage: add-root-grant <grant.json>'); process.exit(2); }
  const cfg = await pairedConfig();
  if (!cfg.guardPublicKeyX) { console.error('Pin the Guard key first: node bin/hands-spoke.mjs pin-guard <x>'); process.exit(2); }
  const parsed = JSON.parse(await readFile(grantFile, 'utf8'));
  const envelope = parsed?.envelope || parsed;
  const deviceId = cfg.deviceId || defaultSpokeDeviceId();
  const v = verifyRootGrant({ publicKeyX: cfg.guardPublicKeyX, envelope, spokeDeviceId: deviceId });
  if (!v.ok) { console.error(`Root grant refused: ${v.error}. Nothing was stored.`); process.exit(2); }
  const st = await stat(v.claims.rootPath).catch(() => null);
  if (!st?.isDirectory()) { console.error(`Granted folder not found on this PC: ${v.claims.rootPath}. Nothing was stored.`); process.exit(2); }
  const grantsPath = cfg.rootGrantsPath || defaultRootGrantsPath();
  const claims = await activateRootGrant({ path: grantsPath, envelope, publicKeyX: cfg.guardPublicKeyX, spokeDeviceId: deviceId });
  console.log(`Root grant ${claims.grantId} active: ${claims.rootPath} is now a READ-ONLY hands root for this PC (${claims.exp ? `until ${new Date(claims.exp * 1000).toISOString()}` : 'until revoked'}). Mutating tools still refuse under it. Grants file: ${grantsPath}. Restart the HelmianBridge service (or the spoke) if it is already running and you need the new root in its startup log; access itself is reloaded per call.`);
} else if (cmd === 'list-root-grants') {
  const cfg = await pairedConfig();
  const grantsPath = cfg.rootGrantsPath || defaultRootGrantsPath();
  const { grants, rejected } = await loadRootGrants({ path: grantsPath, publicKeyX: cfg.guardPublicKeyX || null, spokeDeviceId: cfg.deviceId || defaultSpokeDeviceId() });
  if (!grants.length) console.log('No active root grants.');
  for (const g of grants) console.log(`${g.grantId}  ${g.rootPath}  read-only  ${g.expiresAt ? `expires ${g.expiresAt}` : 'until revoked'}  (approved by ${g.decidedBy})`);
  for (const r of rejected) console.log(`REJECTED  ${r.grantId || '(unknown)'}  ${r.rootPath || ''}  ${r.error}`);
} else if (cmd === 'revoke-root-grant') {
  const selector = process.argv[3];
  if (!selector) { console.error('Usage: revoke-root-grant <grantId | absolute folder>'); process.exit(2); }
  const cfg = await pairedConfig();
  const grantsPath = cfg.rootGrantsPath || defaultRootGrantsPath();
  const r = await revokeRootGrant({ path: grantsPath, selector });
  if (!r.removed) { console.error(`No grant matched "${selector}". Nothing changed.`); process.exit(2); }
  console.log(`Revoked ${r.removed} grant(s). Access to that folder is closed now; ${r.remaining} grant(s) remain.`);
} else {
  const config = await readSpokeConfig();
  if (!config) { console.error('Not paired. Run: node bin/hands-spoke.mjs pair'); process.exit(2); }
  const handle = startSpoke({ config });
  const stop = () => { handle.stop(); process.exit(0); };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}
