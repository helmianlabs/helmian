#!/usr/bin/env node
// Helmian credential service — production entrypoint (cloud-connect bite 1).
// STAGED: installing and starting this on the Hetzner box is a fire step
// for the main agent, sequenced in the bite report. Nothing here runs in
// the general cloud app: this process is the only one that holds the vault
// master key.
//
// Env (server-side only):
//   HELMION_DATABASE_URL             Neon pool (vault tables, migration 063)
//   HELMION_CREDENTIAL_VAULT_KEY     base64url 32-byte master key
//                                    (falls back to HELMION_OAUTH_VAULT_KEY)
//   HELMION_CREDENTIAL_SERVICE_TOKEN bearer the cloud app presents
//   HELMION_CREDENTIAL_AUDIT_PATH    append-only chained audit JSONL
//                                    (default /var/lib/helmian-credential-service/audit.jsonl)
//   HELMION_GUARD_URL                Executive Guard base URL (gate, optional;
//   HELMION_GUARD_DEVICE_TOKEN       without it, password resolves and
//                                    credential replacements are refused)
//   HELMION_CREDENTIAL_SERVICE_PORT  default 8891
//   HELMION_CREDENTIAL_SERVICE_HOST  default 127.0.0.1 (internal network only)

import { createServer } from 'node:http';
import { Pool } from 'pg';
import { createCredentialServiceAuditLog, createCredentialServiceFromParts, createGuardApprovalGate } from '../src/cloud/credential-service.mjs';

const env = process.env;
const masterKey = String(env.HELMION_CREDENTIAL_VAULT_KEY ?? env.HELMION_OAUTH_VAULT_KEY ?? '').trim();
const serviceToken = String(env.HELMION_CREDENTIAL_SERVICE_TOKEN ?? '').trim();
const connectionString = String(env.HELMION_DATABASE_URL ?? '').trim();
if (!connectionString || !masterKey || !serviceToken) {
  console.error('credential service requires HELMION_DATABASE_URL, HELMION_CREDENTIAL_VAULT_KEY (or HELMION_OAUTH_VAULT_KEY), and HELMION_CREDENTIAL_SERVICE_TOKEN');
  process.exit(2);
}

const pool = new Pool({ connectionString, ssl: connectionString.includes('sslmode=disable') ? false : undefined, max: 3, idleTimeoutMillis: 10_000 });
const auditLog = createCredentialServiceAuditLog({ path: String(env.HELMION_CREDENTIAL_AUDIT_PATH ?? '/var/lib/helmian-credential-service/audit.jsonl') });
const guardGate = env.HELMION_GUARD_URL && env.HELMION_GUARD_DEVICE_TOKEN
  ? createGuardApprovalGate({ guardUrl: env.HELMION_GUARD_URL, deviceToken: env.HELMION_GUARD_DEVICE_TOKEN })
  : null;
const service = createCredentialServiceFromParts({ pool, masterKey, serviceToken, auditLog, guardGate });

const port = Number(env.HELMION_CREDENTIAL_SERVICE_PORT ?? 8891);
const host = String(env.HELMION_CREDENTIAL_SERVICE_HOST ?? '127.0.0.1');
const server = createServer(async (request, response) => {
  let body = '';
  for await (const chunk of request) { body += chunk; if (body.length > 128 * 1024) { response.writeHead(413, { 'content-type': 'application/json' }); response.end(JSON.stringify({ status: 'request_too_large' })); return; } }
  const url = new URL(request.url ?? '/', 'http://localhost');
  const result = await service.handle({ method: request.method, path: url.pathname, headers: request.headers, body });
  response.writeHead(result.status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  response.end(JSON.stringify(result.body));
});
server.listen(port, host, () => { console.log(`helmian-credential-service listening on ${host}:${port}`); });
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
