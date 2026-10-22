#!/usr/bin/env node
// Runs the Executive Guard verification server locally.
//
//   EXEC_GUARD_PORT          default 8787
//   EXEC_GUARD_HOST          default 127.0.0.1 (loopback only)
//   EXEC_GUARD_DATA_DIR      default ./.executive-guard  (signing key + audit.jsonl)
//   EXEC_GUARD_DEVICE_TOKENS deviceId=token,deviceId=token   (tokens >= 24 chars)
//   EXEC_GUARD_APPROVER_TOKENS approverId=token,...
//   EXEC_GUARD_POLICY        optional path to a policy JSON file
//   EXEC_GUARD_SERVICE_TOKENS serviceId=token,...  (the hands MCP server, PR #52)
//   EXEC_GUARD_HANDS_ROOTS_PC / EXEC_GUARD_HANDS_ROOTS_RUNNER  workspace roots, ';'-separated
//   EXEC_GUARD_HANDS_COMMANDS  allow-listed PowerShell command ids, ','-separated
//   EXEC_GUARD_HANDS_ALLOW_HOSTS hosts hands.open_url may open without approval
//
// The signing key is generated on first run and written with mode 0600. This is
// a local/dev runner; it does not deploy anything.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileAudit } from '../src/audit.mjs';
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
const keyPath = join(dataDir, 'signing-key.pem');
if (!existsSync(keyPath)) writeFileSync(keyPath, generateSigningKey(), { mode: 0o600 });
const key = loadSigningKey(readFileSync(keyPath, 'utf8'));
const policy = process.env.EXEC_GUARD_POLICY ? JSON.parse(readFileSync(process.env.EXEC_GUARD_POLICY, 'utf8')) : DEFAULT_POLICY;
const deviceTokens = parseTokens(process.env.EXEC_GUARD_DEVICE_TOKENS);
const approverTokens = parseTokens(process.env.EXEC_GUARD_APPROVER_TOKENS);
const serviceTokens = parseTokens(process.env.EXEC_GUARD_SERVICE_TOKENS);
if ((!Object.keys(deviceTokens).length && !Object.keys(serviceTokens).length) || !Object.keys(approverTokens).length) {
  console.error('Set EXEC_GUARD_APPROVER_TOKENS and EXEC_GUARD_DEVICE_TOKENS and/or EXEC_GUARD_SERVICE_TOKENS (id=token, tokens at least 24 characters).');
  process.exit(2);
}
const list = (v, sep) => String(v || '').split(sep).map((s) => s.trim()).filter(Boolean);
const hands = {
  roots: { pc: list(process.env.EXEC_GUARD_HANDS_ROOTS_PC, ';'), runner: list(process.env.EXEC_GUARD_HANDS_ROOTS_RUNNER, ';') },
  commands: list(process.env.EXEC_GUARD_HANDS_COMMANDS, ','),
  allowHosts: list(process.env.EXEC_GUARD_HANDS_ALLOW_HOSTS, ',').map((h) => h.toLowerCase()),
};
const { server } = createExecutiveGuard({ key, audit: fileAudit(join(dataDir, 'audit.jsonl')), deviceTokens, approverTokens, serviceTokens, hands, policy });
const port = Number(process.env.EXEC_GUARD_PORT || 8787);
const host = process.env.EXEC_GUARD_HOST || '127.0.0.1';
server.listen(port, host, () => {
  console.log(JSON.stringify({ service: 'executive-guard', url: `http://${host}:${port}`, keyId: key.keyId, devices: Object.keys(deviceTokens), approvers: Object.keys(approverTokens), services: Object.keys(serviceTokens) }));
});
