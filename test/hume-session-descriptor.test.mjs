import assert from 'node:assert/strict';
import test from 'node:test';
import { buildCoraHumeSessionPreflight, compileCoraHumeSessionDescriptor } from '../src/cora/hume-session-descriptor.mjs';

const signedContext = { verified: true, tenantId: 'org-a', subjectId: 'user-a', role: 'member', sessionId: 'session-a', receiptId: 'receipt-a' };
const publishedConfig = { style: 'professional_brief', maxSpokenChars: 900, interruptMode: 'barge_in', turnMode: 'concise', voiceProfiles: ['cora-professional'], routingPolicy: { format: 'cora.routing-policy.v1', version: 4, entries: [] } };
const repository = { async readPublishedConfig(actor) { assert.equal(actor.tenantId, 'org-a'); return { status: 'published', config: { id: 'config-4', organizationId: 'org-a', configVersion: 4, lifecycle: 'published', isCurrent: true, config: publishedConfig } }; } };

test('Hume descriptor is deterministic, bounded, server-secret-free, and truthful about acceptance', async () => {
  const descriptor = await buildCoraHumeSessionPreflight({ repository, signedContext, humeConfigId: 'hume-config-server', serverCredentialReady: true });
  assert.equal(descriptor.state, 'ready');
  assert.deepEqual(descriptor.organizationConfig, { id: 'config-4', version: 4 });
  assert.deepEqual(descriptor.hume, { configId: 'hume-config-server', credentialReady: true, acceptance: 'not_verified' });
  assert.equal(descriptor.voiceProfile, 'cora-professional');
  assert.equal(descriptor.turn.maxSpokenChars, 900);
  assert.match(descriptor.prompt, /professional and concise/iu);
  assert.equal(descriptor.providerInvocation, 'not_performed');
  assert.equal(descriptor.humeMutation, 'not_performed');
  assert.equal(JSON.stringify(descriptor).includes('apiKey'), false);
  assert.equal(JSON.stringify(descriptor).includes('secret'), false);
});

test('missing Hume process configuration is explicit unavailable, not a provider claim', async () => {
  const descriptor = await buildCoraHumeSessionPreflight({ repository, signedContext, serverCredentialReady: false });
  assert.equal(descriptor.state, 'unavailable');
  assert.equal(descriptor.hume.configId, null);
  assert.equal(descriptor.hume.credentialReady, false);
  assert.equal(descriptor.hume.acceptance, 'not_verified');
});

test('compiler requires explicit server readiness and rejects invalid published behavior', () => {
  const base = { format: 'cora.published-session-config.v1', tenantId: 'org-a', sessionId: 's', receiptId: 'r', configId: 'c1', configVersion: 1, voiceProfile: 'cora', professionalBehavior: { style: 'professional_brief', maxSpokenChars: 900, interruptMode: 'barge_in', turnMode: 'concise' }, configHash: 'a'.repeat(64), toolManifestHash: 'b'.repeat(64), routingPolicyHash: 'c'.repeat(64) };
  assert.throws(() => compileCoraHumeSessionDescriptor({ sessionConfig: base }), /readiness must be explicit/u);
  assert.throws(() => compileCoraHumeSessionDescriptor({ sessionConfig: { ...base, professionalBehavior: { ...base.professionalBehavior, style: 'chatty' } }, serverCredentialReady: false }), /professional behavior/u);
  assert.throws(() => compileCoraHumeSessionDescriptor({ sessionConfig: { ...base, configHash: 'not-a-hash' }, serverCredentialReady: false }), /config hash/u);
});

test('preflight fails closed for missing, ambiguous, or cross-Organization published config', async () => {
  await assert.rejects(() => buildCoraHumeSessionPreflight({ repository: { async readPublishedConfig() { return { status: 'unpublished', config: null }; } }, signedContext, serverCredentialReady: false }), /published Cora config is required/u);
  await assert.rejects(() => buildCoraHumeSessionPreflight({ repository: { async readPublishedConfig() { return { status: 'ambiguous', config: null }; } }, signedContext, serverCredentialReady: false }), /multiple current/u);
  await assert.rejects(() => buildCoraHumeSessionPreflight({ repository: { async readPublishedConfig() { return { status: 'published', config: { organizationId: 'org-b', lifecycle: 'published', isCurrent: true, config: publishedConfig } }; } }, signedContext, serverCredentialReady: false }), /does not match/u);
});
