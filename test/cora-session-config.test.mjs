import assert from 'node:assert/strict';
import test from 'node:test';
import { startCoraClm } from '../src/cora/clm-server.mjs';
import { resolvePublishedCoraSessionConfig } from '../src/cora/session-config-resolver.mjs';

const signedContext = { verified: true, tenantId: 'org-a', subjectId: 'user-a', role: 'member', sessionId: 'session-a', receiptId: 'receipt-a' };
const config = { style: 'professional_brief', maxSpokenChars: 900, interruptMode: 'barge_in', turnMode: 'concise', voiceProfiles: ['cora-professional'], routingPolicy: { format: 'cora.routing-policy.v1', version: 4, entries: [] } };
const repository = { async readPublishedConfig(actor) { assert.equal(actor.tenantId, 'org-a'); assert.equal(actor.subject, 'user-a'); return { status: 'published', config: { id: 'config-4', organizationId: 'org-a', configVersion: 4, lifecycle: 'published', isCurrent: true, config } }; } };

test('published Cora session resolver pins Organization config and server-owned hashes', async () => {
  const result = await resolvePublishedCoraSessionConfig({ repository, signedContext });
  assert.equal(result.configVersion, 4);
  assert.equal(result.voiceProfile, 'cora-professional');
  assert.equal(result.professionalBehavior.style, 'professional_brief');
  assert.match(result.toolManifestHash, /^[a-f0-9]{64}$/u);
  assert.match(result.routingPolicyHash, /^[a-f0-9]{64}$/u);
  assert.equal(result.providerInvocation, 'not_performed');
  assert.equal(result.humeMutation, 'not_performed');
  const driverResult = await resolvePublishedCoraSessionConfig({ repository, signedContext: { ...signedContext, role: 'driver' } });
  assert.equal(driverResult.configVersion, 4);
});

test('published Cora session resolver fails closed for untrusted, ambiguous, and mismatched state', async () => {
  await assert.rejects(() => resolvePublishedCoraSessionConfig({ repository, signedContext: { ...signedContext, verified: false } }), /signed Organization context/u);
  await assert.rejects(() => resolvePublishedCoraSessionConfig({ repository: { async readPublishedConfig() { return { status: 'ambiguous', config: null }; } }, signedContext }), /multiple current/u);
  await assert.rejects(() => resolvePublishedCoraSessionConfig({ repository: { async readPublishedConfig() { return { status: 'published', config: { organizationId: 'org-b', configVersion: 4, lifecycle: 'published', isCurrent: true, config } }; } }, signedContext }), /does not match/u);
  await assert.rejects(() => resolvePublishedCoraSessionConfig({ repository: { async readPublishedConfig() { return { status: 'published', config: { organizationId: 'org-a', configVersion: 4, lifecycle: 'published', isCurrent: true, config: { ...config, voiceProfiles: ['a', 'b'] } } }; } }, signedContext }), /exactly one/u);
});

test('CLM health reports Organization session config resolution separately from process Hume readiness', async (t) => {
  const server = await startCoraClm({ host: '127.0.0.1', port: 0, runTurn: async () => ({ text: 'ok', model: 'test' }), notifyBackgroundAgents: false, publishedConfigResolver: async () => ({ configVersion: 4 }) });
  t.after(server.close);
  const response = await fetch(server.healthUrl);
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.hume.configured, false);
  assert.equal(body.hume.sessionConfigResolution, 'organization_published_at_session_time');
});
