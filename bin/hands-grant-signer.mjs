#!/usr/bin/env node
// Helmian hands: root-grant signer (Executive Guard side — NOT for the PC).
//   node bin/hands-grant-signer.mjs sign <request.json> --key <guard-private-key file>
//       --key-id <id> --approval-id <id> --decided-by <name>
//       [--expires-at <ISO time>] [--out <grant.json>]
//
// Mints a signed root-grant envelope from a spoke root-request record
// (written by `hands-spoke.mjs request-root` on the PC) once a human has
// approved it. Without --approval-id and --decided-by it refuses: no recorded
// human approval, no grant. The Guard private key is read from the file
// named by --key (PKCS#8 PEM or JWK); it is never printed or copied anywhere.
// Take the resulting grant file to the PC and activate it there:
//   node bin\hands-spoke.mjs add-root-grant <grant.json>
// See docs/hands/ROOT_GRANTS.md.
import { readFile, writeFile } from 'node:fs/promises';
import { guardPublicKeyX, issueRootGrant, loadGuardPrivateKey } from '../src/hands/root-grant-signer.mjs';

function flag(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
}

const USAGE = 'Usage: sign <request.json> --key <guard-private-key file> --key-id <id> --approval-id <id> --decided-by <name> [--expires-at <ISO time>] [--out <grant.json>]';

const cmd = process.argv[2];
if (cmd !== 'sign') { console.error(USAGE); process.exit(2); }

const requestPath = process.argv[3];
const keyPath = flag('key');
const keyId = flag('key-id');
const approvalId = flag('approval-id');
const decidedBy = flag('decided-by');
if (!requestPath || !keyPath || !keyId || !approvalId || !decidedBy) { console.error(USAGE); process.exit(2); }

let expiresAt = null;
const expiresRaw = flag('expires-at');
if (expiresRaw) {
  const ms = /^\d+$/.test(expiresRaw) ? Number(expiresRaw) * 1000 : Date.parse(expiresRaw);
  if (!Number.isFinite(ms)) { console.error(`--expires-at is not a time: ${expiresRaw}`); process.exit(2); }
  expiresAt = Math.floor(ms / 1000);
}

let request;
try {
  request = JSON.parse(await readFile(requestPath, 'utf8'));
} catch (e) {
  console.error(`Could not read the root-request record ${requestPath}: ${e.message}`);
  process.exit(2);
}

try {
  const privateKey = await loadGuardPrivateKey(keyPath);
  const { envelope, claims } = issueRootGrant({
    request,
    approval: { approvalId, decidedBy },
    privateKey,
    keyId,
    expiresAt,
  });
  const out = flag('out') || `root-grant-${claims.grantId}.json`;
  await writeFile(out, `${JSON.stringify(envelope, null, 2)}\n`, { mode: 0o600 });
  console.log(`Root grant ${claims.grantId} signed: ${claims.rootPath} is READ-ONLY for spoke ${claims.spokeDeviceId} ${claims.exp ? `until ${new Date(claims.exp * 1000).toISOString()}` : 'until revoked'} (approved by ${claims.decidedBy}, approval ${claims.approvalId}).`);
  console.log(`Grant file: ${out}. Take it to the PC and run: node bin\\hands-spoke.mjs add-root-grant ${out}`);
  console.log(`Signed with Guard key ${keyId}; its public x is ${guardPublicKeyX(privateKey)} — the PC must have THIS x pinned (pin-guard) or it will refuse the grant.`);
} catch (e) {
  console.error(`Refused: ${e.message}`);
  process.exit(2);
}
