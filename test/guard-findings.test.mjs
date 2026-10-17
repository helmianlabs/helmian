import assert from 'node:assert/strict';
import test from 'node:test';
import { createGuardStore, normalizeGuardFinding } from '../src/cloud/guard-findings.mjs';

function fakePool() {
  const findings = new Map(); // `${tenantId}:${fingerprint}` -> row
  const acks = new Map(); // `${tenantId}:${fingerprint}` -> { ackedBySubject }
  const auditEvents = [];
  const client = {
    async query(sql, params = []) {
      const q = String(sql).replace(/\s+/g, ' ').trim().toLowerCase();
      if (['begin', 'commit', 'rollback'].includes(q)) return { rows: [], rowCount: 0 };
      if (q.startsWith('select set_config')) return { rows: [], rowCount: 0 };
      if (q.includes('from helmion.tenant_memberships')) {
        return params[1] === 'member-1' ? { rowCount: 1, rows: [{ role: 'owner' }] } : { rowCount: 0, rows: [] };
      }
      if (q.startsWith('insert into helmion.guard_findings')) {
        const [tenantId, fingerprint, source, severity, title, detail, pageRef] = params;
        const key = `${tenantId}:${fingerprint}`;
        const existing = findings.get(key);
        if (existing) {
          existing.sighting_count += 1;
          existing.severity = severity;
          existing.title = title;
          existing.detail = JSON.parse(detail);
          existing.page_ref = pageRef;
          existing.last_seen_at = new Date().toISOString();
          return { rowCount: 1, rows: [{ ...existing, inserted: false }] };
        }
        const row = {
          id: findings.size + 1, fingerprint, source, severity, title,
          detail: JSON.parse(detail), page_ref: pageRef,
          first_seen_at: new Date().toISOString(), last_seen_at: new Date().toISOString(),
          sighting_count: 1, inserted: true,
        };
        findings.set(key, row);
        return { rowCount: 1, rows: [{ ...row }] };
      }
      if (q.startsWith('delete from helmion.guard_finding_acks')) {
        const key = `${params[0]}:${params[1]}`;
        const had = acks.delete(key);
        return { rowCount: had ? 1 : 0, rows: [] };
      }
      if (q.includes('from helmion.guard_findings f')) {
        const tenantId = params[0];
        const rows = [...findings.entries()]
          .filter(([key]) => key.startsWith(`${tenantId}:`))
          .map(([, row]) => ({ ...row, acked_by_subject: acks.get(`${tenantId}:${row.fingerprint}`)?.ackedBySubject ?? null }));
        return { rowCount: rows.length, rows };
      }
      if (q.includes('from helmion.guard_findings where tenant_id=$1 and fingerprint=$2')) {
        const row = findings.get(`${params[0]}:${params[1]}`);
        return row ? { rowCount: 1, rows: [{ fingerprint: row.fingerprint, severity: row.severity, title: row.title }] } : { rowCount: 0, rows: [] };
      }
      if (q.startsWith('insert into helmion.guard_finding_acks')) {
        const key = `${params[0]}:${params[1]}`;
        if (acks.has(key)) return { rowCount: 0, rows: [] };
        acks.set(key, { ackedBySubject: params[2] });
        return { rowCount: 1, rows: [{ acked_by_subject: params[2], acked_at: new Date().toISOString() }] };
      }
      if (q.startsWith('insert into helmion.audit_events')) {
        auditEvents.push({ actionType: params[5] });
        return { rowCount: 1, rows: [{ id: auditEvents.length }] };
      }
      throw new Error(`unexpected ${q}`);
    },
    release() {},
  };
  return { pool: { connect: async () => client }, findings, acks, auditEvents };
}

const finding = {
  fingerprint: 'finding-fingerprint-0001',
  source: 'browser-extension',
  severity: 'warning',
  title: 'Unsourced claim flagged',
  detail: { kind: 'unsourced-claim' },
  pageRef: 'https://example.com/chat',
};

test('normalizeGuardFinding rejects invalid bodies', () => {
  assert.throws(() => normalizeGuardFinding({}), /fingerprint/);
  assert.throws(() => normalizeGuardFinding({ ...finding, fingerprint: 'short' }), /too short/);
  assert.throws(() => normalizeGuardFinding({ ...finding, source: 'nope' }), /source is unsupported/);
  assert.throws(() => normalizeGuardFinding({ ...finding, severity: 'nope' }), /severity is unsupported/);
  assert.throws(() => normalizeGuardFinding({ ...finding, title: '' }), /title/);
  assert.throws(() => normalizeGuardFinding({ ...finding, detail: 'nope' }), /detail must be an object/);
  const normalized = normalizeGuardFinding(finding);
  assert.equal(normalized.severity, 'warning');
});

test('normalizeGuardFinding drops raw page content from detail', () => {
  const normalized = normalizeGuardFinding({
    ...finding,
    detail: { kind: 'x', pageContent: 'a'.repeat(10000), rawHtml: '<html>' },
  });
  assert.ok(!('pageContent' in normalized.detail));
  assert.ok(!('rawHtml' in normalized.detail));
  assert.equal(normalized.detail.kind, 'x');
  assert.ok(JSON.stringify(normalized.detail).length <= 4096);
});

test('ingestion upserts and a re-sighting clears the ack', async () => {
  const { pool, acks } = fakePool();
  const store = createGuardStore(pool);
  const actor = { tenantId: 't-1', subject: 'member-1' };

  const first = await store.ingestFinding(actor, finding);
  assert.equal(first.inserted, true);
  assert.equal(first.ackCleared, false);
  assert.equal(first.finding.sightingCount, 1);

  const acked = await store.ackFinding({ ...actor, role: 'owner', sessionId: 's', requestId: 'r' }, finding.fingerprint);
  assert.equal(acked.acked, true);
  assert.equal(acked.alreadyAcked, false);
  assert.ok(acks.has('t-1:finding-fingerprint-0001'));

  const listed = await store.listFindings({ ...actor, role: 'owner', sessionId: 's', requestId: 'r' });
  assert.equal(listed.findings.length, 1);
  assert.equal(listed.findings[0].acked, true);

  // Re-sighting: sighting count goes up and the ack is cleared.
  const second = await store.ingestFinding(actor, finding);
  assert.equal(second.inserted, false);
  assert.equal(second.ackCleared, true);
  assert.equal(second.finding.sightingCount, 2);
  assert.ok(!acks.has('t-1:finding-fingerprint-0001'));
});

test('ack is idempotent and unknown fingerprints throw', async () => {
  const { pool, auditEvents } = fakePool();
  const store = createGuardStore(pool);
  const actor = { tenantId: 't-1', subject: 'member-1', role: 'owner', sessionId: 's', requestId: 'r' };
  await store.ingestFinding({ tenantId: 't-1', subject: 'member-1' }, finding);

  const first = await store.ackFinding(actor, finding.fingerprint);
  const second = await store.ackFinding(actor, finding.fingerprint);
  assert.equal(second.alreadyAcked, true);
  assert.equal(auditEvents.filter((e) => e.actionType === 'guard.finding.acknowledged').length, 1);

  await assert.rejects(
    store.ackFinding(actor, 'finding-fingerprint-9999'),
    /not found/,
  );
});

test('ingestion rejects device identities without membership', async () => {
  const { pool } = fakePool();
  const store = createGuardStore(pool);
  await assert.rejects(
    store.ingestFinding({ tenantId: 't-1', subject: 'stranger' }, finding),
    /not an active member/,
  );
});
