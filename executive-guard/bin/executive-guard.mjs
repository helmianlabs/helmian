#!/usr/bin/env node
// Runs the Executive Guard verification server locally.
//
//   EXEC_GUARD_PORT          default 8787
//   EXEC_GUARD_HOST          default 127.0.0.1 (loopback only)
//   EXEC_GUARD_DATA_DIR      default ./.executive-guard  (signing key + audit.jsonl)
//   EXEC_GUARD_KEY_PATH      optional, overrides <data dir>/signing-key.pem
//   EXEC_GUARD_AUDIT_PATH    optional, overrides <data dir>/audit.jsonl
//                            (separate paths let a container keep each on its own volume)
//   EXEC_GUARD_STATE_PATH    optional, default <audit dir>/state.jsonl: pending approvals
//                            and used nonces, so a restart keeps them (same volume as audit)
//   EXEC_GUARD_DEVICE_TOKENS deviceId=token,deviceId=token   (tokens >= 24 chars)
//   EXEC_GUARD_APPROVER_TOKENS approverId=token,...
//   EXEC_GUARD_POLICY        optional path to a policy JSON file
//
// The signing key is generated on first run and written with mode 0600. This is
// a local/dev runner; it does not deploy anything.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileAudit } from '../src/audit.mjs';
import { fileState } from '../src/state.mjs';
import { createExecutiveGuard } from '../src/server.mjs';
import { generateSigningKey, loadSigningKey } from '../src/signing.mjs';
import { DEFAULT_POLICY } from '../src/policy.mjs';

function parseTokens(text) {
  const out = {};
  for (const pair of String(text || '').split(',').map((s) => s.trim()).filter(Boolean)) {
    const at = pair.indexOf('=');
    if (at > 0) out[pair.slice(0, at)] = pair.slice(at + 1);
  }
  return out;
}

const dataDir = resolve(process.env.EXEC_GUARD_DATA_DIR || '.executive-guard');
mkdirSync(dataDir, { recursive: true, mode: 0o700 });
const keyPath = resolve(process.env.EXEC_GUARD_KEY_PATH || join(dataDir, 'signing-key.pem'));
const auditPath = resolve(process.env.EXEC_GUARD_AUDIT_PATH || join(dataDir, 'audit.jsonl'));
const statePath = resolve(process.env.EXEC_GUARD_STATE_PATH || join(dirname(auditPath), 'state.jsonl'));
mkdirSync(dirname(keyPath), { recursive: true, mode: 0o700 });
if (!existsSync(keyPath)) writeFileSync(keyPath, generateSigningKey(), { mode: 0o600, flag: 'wx' });
const key = loadSigningKey(readFileSync(keyPath, 'utf8'));
const policy = process.env.EXEC_GUARD_POLICY ? JSON.parse(readFileSync(process.env.EXEC_GUARD_POLICY, 'utf8')) : DEFAULT_POLICY;
const deviceTokens = parseTokens(process.env.EXEC_GUARD_DEVICE_TOKENS);
const approverTokens = parseTokens(process.env.EXEC_GUARD_APPROVER_TOKENS);
if (!Object.keys(deviceTokens).length || !Object.keys(approverTokens).length) {
  console.error('Set EXEC_GUARD_DEVICE_TOKENS and EXEC_GUARD_APPROVER_TOKENS (id=token, tokens at least 24 characters).');
  process.exit(2);
}
const { server } = createExecutiveGuard({ key, audit: fileAudit(auditPath), state: fileState(statePath), deviceTokens, approverTokens, policy, approvalTtlSeconds: Number(process.env.EXEC_GUARD_APPROVAL_TTL_SECONDS || 0) || undefined });
const port = Number(process.env.EXEC_GUARD_PORT || 8787);
const host = process.env.EXEC_GUARD_HOST || '127.0.0.1';
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
server.listen(port, host, () => {
  console.log(JSON.stringify({ service: 'executive-guard', url: `http://${host}:${port}`, keyId: key.keyId, devices: Object.keys(deviceTokens), approvers: Object.keys(approverTokens) }));
});
