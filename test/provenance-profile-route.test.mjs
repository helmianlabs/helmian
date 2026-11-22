// Bite 4 (Scribe 1154): the provenance profile route + repository + the
// settings surface module. The route is tenant-derived and authenticated
// like the workspace layout route; the repository validates the sync
// payload as a unit; the browser module's slider descriptors are pinned
// to the core contract so the surface cannot drift from the guardrails.

import test from 'node:test';
import assert from 'node:assert/strict';

import { startCoraClm } from '../src/cora/clm-server.mjs';
import { createLiveHelmianCloudAdminHandler, LIVE_ADMIN_PROVENANCE_PROFILE_PATH } from '../src/cloud/live-admin.mjs';
import { createProvenanceProfileRepository } from '../src/cloud/provenance-profile-repository.mjs';
import { createProvenanceSyncPayload, validateProvenanceSyncPayload } from '../src/core/provenance-profile-sync.mjs';
import { WEIGHTING_SLIDERS as CORE_SLIDERS } from '../src/core/provenance-profile-sync.mjs';
import { WEIGHTING_SLIDERS as VIEW_SLIDERS, slidersHtml, badgeChipHtml, badgeLegendHtml } from '../web/marketing/app/provenance-view.mjs';

const env = { HELMION_CLOUD_ENVIRONMENT: 'staging', HELMION_DATABASE_URL: 'postgresql://app:x@ep-silent-rain-a1b2c3d4.us-east-2.aws.neon.tech/neondb?sslmode=require', HELMION_EXPECTED_ENDPOINT_ID: 'ep-silent-rain-a1b2c3d4', HELMION_ADMIN_ISSUER: 'https://identity.example.com', HELMION_ADMIN_CLIENT_ID: 'helmian', HELMION_ADMIN_REDIRECT_URI: 'https://helmian.example.com/admin/auth/callback' };
function identity() { return { getSession: (id) => (id === 'active-session' ? { subject: 'user-1' } : null) }; }
function membershipPool(role = 'member') {
  const client = { async query(sql) { const q = String(sql).replace(/\s+/g, ' ').trim().toLowerCase(); if (['begin', 'commit', 'rollback'].includes(q) || q.startsWith('select set_config')) return { rowCount: 0, rows: [] }; if (q.includes('from helmion.tenant_memberships')) return { rowCount: 1, rows: [{ tenant_id: 'customer-a', role }] }; throw new Error(`unexpected query ${q}`); }, release() {} };
  return { connect: async () => client };
}

test('route: read returns the repository payload, save is tenant-scoped, selectors are refused', async (t) => {
  const calls = [];
  const payload = createProvenanceSyncPayload({ provenanceWeight: 0.5 }, { source: 'helmian-settings' });
  const repository = {
    async read(actor) { calls.push(['read', actor]); return { source: 'default', payload: createProvenanceSyncPayload({}, { source: 'default' }) }; },
    async save(actor, input) { calls.push(['save', actor, input]); return { source: 'saved', payload }; },
  };
  const admin = await createLiveHelmianCloudAdminHandler({ env, pool: membershipPool(), identity: identity(), page: '<p>test</p>', script: 'void 0;', expectedMigrations: [], provenanceProfileRepository: repository });
  const clm = await startCoraClm({ host: '127.0.0.1', port: 0, runTurn: async () => ({ text: 'ok', model: 'test' }), notifyBackgroundAgents: false, httpRequestHandler: admin.handler });
  t.after(async () => { await clm.close(); await admin.close(); });
  const base = clm.healthUrl.replace('/healthz', '');
  const headers = { cookie: 'helmion_admin_session=active-session' };

  const read = await fetch(`${base}${LIVE_ADMIN_PROVENANCE_PROFILE_PATH}`, { headers });
  assert.equal(read.status, 200);
  assert.equal((await read.json()).source, 'default');

  const save = await fetch(`${base}${LIVE_ADMIN_PROVENANCE_PROFILE_PATH}`, { method: 'PUT', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify({ profile: { provenanceWeight: 0.5 } }) });
  assert.equal(save.status, 200);
  assert.equal((await save.json()).payload.profile.provenanceWeight, 0.5);
  assert.equal(calls[1][1].tenantId, 'customer-a');
  assert.equal(calls[1][1].subject, 'user-1');

  assert.equal((await fetch(`${base}${LIVE_ADMIN_PROVENANCE_PROFILE_PATH}?tenant_id=customer-b`, { headers })).status, 400);
  const extra = await fetch(`${base}${LIVE_ADMIN_PROVENANCE_PROFILE_PATH}`, { method: 'PUT', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify({ profile: {}, tenantId: 'customer-b' }) });
  assert.equal(extra.status, 400, 'a body carrying its own tenant selector is refused');
  const anon = await fetch(`${base}${LIVE_ADMIN_PROVENANCE_PROFILE_PATH}`);
  assert.equal(anon.status, 403);
});

test('repository: no row reads as the named default; a save stores a validated payload; a tampered row fails closed', async () => {
  const store = new Map();
  const client = {
    async query(sql, params) {
      const q = String(sql).replace(/\s+/g, ' ').trim().toLowerCase();
      if (['begin', 'commit', 'rollback'].includes(q) || q.startsWith('select set_config')) return { rowCount: 0, rows: [] };
      if (q.includes('from helmion.tenant_memberships')) return { rowCount: 1, rows: [{ tenant_id: 'customer-a', role: 'owner' }] };
      if (q.startsWith('select payload')) {
        const row = store.get(params[0]);
        return row ? { rowCount: 1, rows: [row] } : { rowCount: 0, rows: [] };
      }
      if (q.startsWith('insert into helmion.provenance_weighting_profiles')) {
        const row = { payload: JSON.parse(params[1]), updated_by_subject: params[2], updated_at: new Date().toISOString() };
        store.set(params[0], row);
        return { rowCount: 1, rows: [row] };
      }
      throw new Error(`unexpected query ${q}`);
    },
    release() {},
  };
  const repo = createProvenanceProfileRepository({ connect: async () => client });
  const actor = { tenantId: 'customer-a', subject: 'user-1', role: 'owner', sessionId: 's1', requestId: 'r1' };

  const before = await repo.read(actor);
  assert.equal(before.source, 'default');
  assert.equal(before.payload.profile.provenanceWeight, 1);

  const saved = await repo.save(actor, { profile: { replicationWeight: 0.25 } });
  assert.equal(saved.source, 'saved');
  assert.equal(saved.payload.profile.replicationWeight, 0.25);
  assert.equal(validateProvenanceSyncPayload(saved.payload).valid, true);
  assert.equal(saved.payload.profile.replicationWeight, 0.25);

  await assert.rejects(() => repo.save(actor, { profile: { replicationWeight: 7 } }), /status: 400|replicationWeight/);

  const tampered = createProvenanceSyncPayload({ provenanceWeight: 0.5 });
  tampered.policy = { ...tampered.policy, defaultAction: 'allow' };
  store.set('customer-a', { payload: tampered, updated_by_subject: 'user-9', updated_at: new Date().toISOString() });
  await assert.rejects(() => repo.read(actor), /does not match the policy/, 'a stored payload whose policy disagrees with its profile is refused on read');
});

test('surface module: slider descriptors are the core contract, and the renderers emit the real controls', () => {
  assert.deepEqual(
    VIEW_SLIDERS.map((s) => [s.key, s.label, s.min, s.max, s.step]),
    CORE_SLIDERS.map((s) => [s.key, s.label, s.min, s.max, s.step]),
  );
  const html = slidersHtml({ provenanceWeight: 0.5 });
  assert.match(html, /data-prov-key="provenanceWeight"/);
  assert.match(html, /value="0.5"/);
  assert.equal((html.match(/class="prov-slider"/g) ?? []).length, 7);
  const chip = badgeChipHtml({ id: 'unverified-provenance', label: 'Unverified Provenance', tone: 'amber', detail: 'd' });
  assert.match(chip, /prov-badge-amber/);
  assert.match(chip, /Unverified Provenance/);
  assert.match(badgeLegendHtml(), /verified-provenance/);
  assert.match(badgeLegendHtml(), /blocked-integrity/);
});
