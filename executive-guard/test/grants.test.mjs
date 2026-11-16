// Standing action grants (bite 2): the Guard mints a grant when — and only
// when — a grant-issuance action is APPROVED through the normal decide path.
// Fetch is device-authenticated and bound to the caller's deviceId; revoke
// is approver-authenticated. The store is the audit trail (grant.issued /
// grant.revoked), rebuilt on start like issuedDecisions.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, verify as edVerify } from 'node:crypto';
import { canonicalJson } from '../src/canonical.mjs';
import { fileAudit } from '../src/audit.mjs';
import { fileState } from '../src/state.mjs';
import { generateSigningKey, loadSigningKey } from '../src/signing.mjs';
import { startGuard, action, nonce, DEVICE_TOKEN, OTHER_DEVICE_TOKEN, APPROVER_TOKEN } from '../test-support/helpers.mjs';

const ACTIONS = [
  { tool: 'write_file', scope: 'jobs-prompt' },
  { tool: 'run_powershell', scope: 'seat-call' },
  { tool: 'run_powershell', scope: 'salvage-mkdir' },
  { tool: 'write_file', scope: 'salvage-file' },
];

// Built exactly the way buildActionGrantAction (hands shared protocol,
// bite 1) builds it: spec bound by the contentHash, spelled in the summary.
function grantAction({ deviceId = 'troy-laptop', spokeDeviceId = 'pc-troy', actions = ACTIONS, contentHash } = {}) {
  const hash = contentHash || createHash('sha256').update(canonicalJson({ grant: { deviceId, spokeDeviceId, actions } })).digest('hex');
  return {
    kind: 'agent.tool',
    site: 'hands.helmian',
    contentHash: hash,
    riskSignals: ['action-grant', 'destructive-intent', 'hands.act'],
    summary: `hands grant standing actions (${actions.map((a) => `${a.tool}:${a.scope}`).join(', ')}) for ${spokeDeviceId}`,
  };
}

async function ask(guard, act) {
  const res = await guard.call('POST', '/v1/decisions', { token: DEVICE_TOKEN, body: { action: act, nonce: nonce() } });
  assert.equal(res.status, 202, JSON.stringify(res.body));
  assert.equal(res.body.verdict, 'ask');
  return res.body.approvalId;
}

const decide = (guard, id, approve) => guard.call('POST', `/v1/approvals/${id}/decide`, { token: APPROVER_TOKEN, body: { approve } });
const fetchGrants = (guard, token) => (token ? guard.call('GET', '/v1/grants', { token }) : guard.call('GET', '/v1/grants'));

// Every claim bite 1's verifyActionGrant requires, asserted field by field,
// plus a real Ed25519 signature check against the Guard's public key — the
// same checks verifyActionGrant performs, replicated here because the hands
// protocol module lives in a different tree on this box.
function assertGrantEnvelope(guard, envelope, approvalId) {
  assert.equal(typeof envelope.payload, 'string');
  assert.equal(typeof envelope.signature, 'string');
  assert.equal(envelope.keyId, guard.key.keyId);
  const good = edVerify(null, Buffer.from(envelope.payload, 'utf8'), guard.key.publicKey, Buffer.from(envelope.signature, 'base64url'));
  assert.equal(good, true, 'grant signature must verify against the Guard key');
  const claims = JSON.parse(Buffer.from(envelope.payload, 'base64url').toString('utf8'));
  assert.equal(claims.aud, 'helmian-executive-guard-action-grant-v1');
  assert.equal(claims.grantType, 'action');
  assert.equal(typeof claims.grantId, 'string');
  assert.ok(claims.grantId.length > 0);
  assert.equal(claims.verdict, 'allow');
  assert.equal(claims.approvalId, approvalId, 'grant binds the approval that minted it');
  assert.equal(claims.decidedBy, 'troy', 'grant binds the human who decided');
  assert.equal(claims.deviceId, 'troy-laptop');
  assert.equal(claims.spokeDeviceId, 'pc-troy');
  assert.deepEqual(claims.actions, ACTIONS);
  assert.equal(typeof claims.iat, 'number');
  assert.equal(claims.exp, undefined, 'no exp: an action grant lasts until revoked');
  return claims;
}

test('approve a grant action -> grant minted, returned to the decider, fetchable by its device', async () => {
  const guard = await startGuard();
  try {
    const approvalId = await ask(guard, grantAction());
    const decided = await decide(guard, approvalId, true);
    assert.equal(decided.status, 200);
    const envelope = decided.body.approval.grant;
    assert.ok(envelope, 'the decide response carries the minted grant');
    const claims = assertGrantEnvelope(guard, envelope, approvalId);

    const fetched = await fetchGrants(guard, DEVICE_TOKEN);
    assert.equal(fetched.status, 200);
    assert.equal(fetched.body.grants.length, 1);
    assert.deepEqual(fetched.body.grants[0], envelope);

    const issued = guard.audit.all().find((e) => e.event === 'grant.issued');
    assert.ok(issued, 'grant.issued is on the audit trail');
    assert.equal(issued.grantId, claims.grantId);
    assert.equal(issued.approvalId, approvalId);
    assert.equal(guard.audit.verify().ok, true);
  } finally { await guard.close(); }
});

test('deny a grant action -> nothing is minted', async () => {
  const guard = await startGuard();
  try {
    const approvalId = await ask(guard, grantAction());
    const decided = await decide(guard, approvalId, false);
    assert.equal(decided.status, 200);
    assert.equal(decided.body.approval.grant, undefined);
    assert.equal((await fetchGrants(guard, DEVICE_TOKEN)).body.grants.length, 0);
    assert.equal(guard.audit.all().some((e) => e.event === 'grant.issued'), false);
  } finally { await guard.close(); }
});

test('fetch is device-only and bound to the caller device', async () => {
  const guard = await startGuard();
  try {
    const approvalId = await ask(guard, grantAction());
    await decide(guard, approvalId, true);
    assert.equal((await fetchGrants(guard, null)).status, 401, 'no token');
    assert.equal((await fetchGrants(guard, APPROVER_TOKEN)).status, 401, 'an approver token must not fetch grants');
    const other = await fetchGrants(guard, OTHER_DEVICE_TOKEN);
    assert.equal(other.status, 200);
    assert.equal(other.body.grants.length, 0, 'another device sees none of this device\'s grants');
    assert.equal((await guard.call('POST', '/v1/grants', { token: DEVICE_TOKEN, body: {} })).status, 405);
  } finally { await guard.close(); }
});

test('revoke removes the grant, writes the audit event, and is approver-only', async () => {
  const guard = await startGuard();
  try {
    const approvalId = await ask(guard, grantAction());
    const decided = await decide(guard, approvalId, true);
    const claims = assertGrantEnvelope(guard, decided.body.approval.grant, approvalId);
    const url = `/v1/grants/${claims.grantId}/revoke`;

    assert.equal((await guard.call('POST', url, { token: DEVICE_TOKEN, body: {} })).status, 401, 'a device token must not revoke');
    const revoked = await guard.call('POST', url, { token: APPROVER_TOKEN, body: {} });
    assert.equal(revoked.status, 200);
    assert.deepEqual(revoked.body, { grantId: claims.grantId, revoked: true });

    assert.equal((await fetchGrants(guard, DEVICE_TOKEN)).body.grants.length, 0, 'fetch after revoke returns nothing');
    const event = guard.audit.all().find((e) => e.event === 'grant.revoked');
    assert.ok(event, 'grant.revoked is on the audit trail');
    assert.equal(event.grantId, claims.grantId);
    assert.equal(event.revokedBy, 'troy');
    assert.equal((await guard.call('POST', url, { token: APPROVER_TOKEN, body: {} })).status, 404, 'a second revoke finds nothing');
    assert.equal(guard.audit.verify().ok, true);
  } finally { await guard.close(); }
});

test('a normal (non-grant) approval still mints NO grant', async () => {
  const guard = await startGuard();
  try {
    const approvalId = await ask(guard, action({ kind: 'agent.tool', site: 'hands.helmian', riskSignals: ['destructive-intent'], summary: 'write_file' }));
    const decided = await decide(guard, approvalId, true);
    assert.equal(decided.status, 200);
    assert.equal(decided.body.approval.grant, undefined);
    assert.equal((await fetchGrants(guard, DEVICE_TOKEN)).body.grants.length, 0);
    assert.equal(guard.audit.all().some((e) => e.event === 'grant.issued'), false);
  } finally { await guard.close(); }
});

test('a grant-shaped action whose contentHash does not bind the summary spec mints nothing (fail closed)', async () => {
  const guard = await startGuard();
  try {
    const bogus = createHash('sha256').update('not the spec').digest('hex');
    const approvalId = await ask(guard, grantAction({ contentHash: bogus }));
    const decided = await decide(guard, approvalId, true);
    assert.equal(decided.status, 200);
    assert.equal(decided.body.approval.grant, undefined);
    assert.equal((await fetchGrants(guard, DEVICE_TOKEN)).body.grants.length, 0);
    assert.equal(guard.audit.all().some((e) => e.event === 'grant.issued'), false);
  } finally { await guard.close(); }
});

test('grants survive a restart (rebuilt from the audit trail); a revoked grant stays revoked', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'eg-grants-'));
  const pem = generateSigningKey();
  const paths = { audit: join(dir, 'audit', 'audit.jsonl'), state: join(dir, 'audit', 'state.jsonl') };
  const boot = () => startGuard({ key: loadSigningKey(pem), audit: fileAudit(paths.audit), state: fileState(paths.state) });
  try {
    const a = await boot();
    const approvalId = await ask(a, grantAction());
    const decided = await decide(a, approvalId, true);
    const claims = assertGrantEnvelope(a, decided.body.approval.grant, approvalId);
    await a.close();

    const b = await boot();
    const fetched = await fetchGrants(b, DEVICE_TOKEN);
    assert.equal(fetched.body.grants.length, 1, 'the grant is rebuilt from the audit trail after restart');
    assert.deepEqual(fetched.body.grants[0], decided.body.approval.grant);
    assert.equal((await b.call('POST', `/v1/grants/${claims.grantId}/revoke`, { token: APPROVER_TOKEN, body: {} })).status, 200);
    await b.close();

    const c = await boot();
    try {
      assert.equal((await fetchGrants(c, DEVICE_TOKEN)).body.grants.length, 0, 'the revocation also survives restart');
    } finally { await c.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
