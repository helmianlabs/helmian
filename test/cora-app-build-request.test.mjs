import assert from 'node:assert/strict';
import test from 'node:test';
import { buildAppBuildRequestReceipt, normalizeAppBuildRequest } from '../src/cora/app-build-intent.mjs';
import { createAppBuildRepository } from '../src/cora/app-build-repository.mjs';

const request = Object.freeze({
  intent: 'draft', title: 'Driver self onboarding', department: 'hr', route: '/hr/self-onboarding',
  description: 'Collect and review a new driver onboarding draft.',
  components: [
    { type: 'heading', text: 'Driver self onboarding' },
    { type: 'field', label: 'Driver email', fieldType: 'email', required: true },
    { type: 'button', label: 'Save draft', action: 'save_draft' },
  ], idempotencyKey: 'app-build-0001',
});

function fakePool() {
  const rows = []; const memberships = { member: { tenant_id: 'org-a', role: 'member' } };
  const client = { async query(sql, values = []) {
    const q = String(sql).replace(/\s+/g, ' ').trim().toLowerCase();
    if (['begin', 'commit', 'rollback'].includes(q) || q.startsWith('select set_config')) return { rowCount: 0, rows: [] };
    if (q.startsWith('select role from helmion.tenant_memberships')) { const member = memberships[values[1]]; return member?.tenant_id === values[0] ? { rowCount: 1, rows: [{ role: member.role }] } : { rowCount: 0, rows: [] }; }
    if (q.startsWith('insert into helmion.cora_app_build_requests')) { const existing = rows.find((row) => row.tenant_id === values[0] && row.idempotency_key === values[8]); if (existing) return { rowCount: 0, rows: [] }; const row = { id: rows.length + 1, tenant_id: values[0], actor_subject: values[1], title: values[2], department: values[3], route: values[4], description: values[5], components: JSON.parse(values[6]), receipt_id: values[7], idempotency_key: values[8], created_at: 'now' }; rows.push(row); return { rowCount: 1, rows: [row] }; }
    if (q.startsWith('select id, title, department, route, description, components, receipt_id, idempotency_key, created_at from helmion.cora_app_build_requests where tenant_id=$1 and idempotency_key=$2')) { const row = rows.find((candidate) => candidate.tenant_id === values[0] && candidate.idempotency_key === values[1]); return row ? { rowCount: 1, rows: [row] } : { rowCount: 0, rows: [] }; }
    if (q.startsWith('select id, title, department, route, description, components, receipt_id, idempotency_key, created_at from helmion.cora_app_build_requests where tenant_id=$1 order by')) return { rowCount: rows.length, rows: rows.filter((row) => row.tenant_id === values[0]) };
    throw new Error(`Unexpected query: ${q}`);
  }, release() {} };
  return { connect: async () => client };
}

test('Cora app-build request accepts a bounded declarative HR page and records no execution channel', () => {
  const normalized = normalizeAppBuildRequest(request);
  const receipt = buildAppBuildRequestReceipt({ request: normalized, receiptId: 'receipt-0001' });
  assert.equal(receipt.status, 'draft-recorded');
  assert.equal(receipt.components[1].fieldType, 'email');
  assert.equal(receipt.execution, 'not_performed');
  assert.equal(receipt.filesystemMutation, 'not_performed');
  assert.equal(receipt.publication, 'not_performed');
});

test('Cora app-build request rejects tenant injection, raw markup, arbitrary action, and unsafe routes', () => {
  assert.throws(() => normalizeAppBuildRequest({ ...request, tenantId: 'org-b' }), /cannot select tenant/);
  assert.throws(() => normalizeAppBuildRequest({ ...request, components: [{ type: 'html', text: '<script>' }] }), /unsupported/);
  assert.throws(() => normalizeAppBuildRequest({ ...request, components: [{ type: 'button', label: 'Deploy', action: 'deploy' }] }), /unsupported/);
  assert.throws(() => normalizeAppBuildRequest({ ...request, route: '/hr/../secrets' }), /unsupported/);
});

test('repository derives tenant from membership and returns a durable idempotent draft receipt', async () => {
  const repo = createAppBuildRepository(fakePool());
  const actor = { tenantId: 'org-a', subject: 'member', role: 'member', sessionId: 'session-1', requestId: 'request-1' };
  const first = await repo.append(actor, request);
  const replay = await repo.append(actor, request);
  assert.equal(first.durability, 'committed'); assert.equal(first.durable, true); assert.equal(first.route, '/hr/self-onboarding');
  assert.equal(replay.replayed, true); assert.equal(replay.receiptId, first.receiptId);
  const listed = await repo.list(actor); assert.equal(listed.receipts.length, 1);
});
