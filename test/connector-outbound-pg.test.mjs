// Connector outbox against a real database. The fake-pool suite
// (connector-outbound.test.mjs) cannot enforce the schema or row
// locks, which is how two defects shipped together: the settle's
// audit insert carried actorRole 'worker', which the
// audit_events_actor_role_check constraint rejects, so the failed
// insert rolled the status update back with it and no row could ever
// settle; and claimBatch committed its claim before delivery, dropping
// the FOR UPDATE locks, so two drainers could deliver the same row.
// This suite runs the real worker against the real migrations when
// HELMIAN_TEST_PG_URL points at a scratch database with the repo's
// sql/ migrations applied, and skips cleanly without one (the
// envoy-findings.test.mjs pattern).
import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { createConnectorOutboundWorker, enqueueConnectorMessage } from '../src/cora/connector-outbound-worker.mjs';

const pgUrl = process.env.HELMIAN_TEST_PG_URL;
const pgSkip = pgUrl ? false : 'HELMIAN_TEST_PG_URL is not set';
const ENV = { HELMION_DISCORD_WEBHOOK_URL: 'https://discord.com/api/webhooks/pg-test' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function seedTenant(pool, tenantId) {
  await pool.query('insert into helmion.tenants(tenant_id, display_name) values ($1,$2)', [tenantId, 'Connector Outbound PG Test']);
}
async function cleanup(pool, tenantId) {
  await pool.query('delete from helmion.audit_outbox where tenant_id=$1', [tenantId]).catch(() => {});
  await pool.query('delete from helmion.audit_events where tenant_id=$1', [tenantId]).catch(() => {});
  await pool.query('delete from helmion.connector_outbound_messages where tenant_id=$1', [tenantId]).catch(() => {});
  await pool.query('delete from helmion.tenants where tenant_id=$1', [tenantId]).catch(() => {});
}
async function onlyRow(pool, tenantId) {
  const rows = await pool.query('select status, attempts from helmion.connector_outbound_messages where tenant_id=$1 order by id', [tenantId]);
  assert.equal(rows.rowCount, 1);
  return rows.rows[0];
}
async function auditRows(pool, tenantId) {
  const rows = await pool.query('select action_type, actor_role, decision from helmion.audit_events where tenant_id=$1 order by id', [tenantId]);
  return rows.rows;
}

test('outbox: one drain delivers once, settles, and audits with a lawful actor role', { skip: pgSkip }, async () => {
  const { default: pg } = await import('pg');
  const pool = new pg.Pool({ connectionString: pgUrl });
  const tenantId = `t-${randomUUID().slice(0, 8)}`;
  try {
    await seedTenant(pool, tenantId);
    const deliveries = [];
    const enqueued = await enqueueConnectorMessage({ pool, tenantId, provider: 'discord', channelLabel: 'approvals', text: 'pg test a' });
    const worker = createConnectorOutboundWorker({
      pool, workerId: 'worker:pg-test', env: ENV,
      postMessage: async ({ text }) => { deliveries.push(text); return { delivered: true, status: 204 }; },
      log: () => {},
    });
    // The worker drains the whole queue, not one tenant, so on a
    // shared scratch database other tenants' rows may ride along;
    // every assertion here is scoped to this test's own message.
    const done = await worker.runOnce();
    assert.equal(done.filter((d) => String(d.messageId) === String(enqueued.messageId)).length, 1, 'this drain settles the test row');
    assert.equal(deliveries.filter((t) => t === 'pg test a').length, 1, 'exactly one delivery of the test message');
    const row = await onlyRow(pool, tenantId);
    assert.equal(row.status, 'sent', 'the row settles');
    const audit = await auditRows(pool, tenantId);
    assert.equal(audit.length, 1);
    assert.equal(audit[0].action_type, 'connector.outbound.sent');
    assert.equal(audit[0].actor_role, 'member', 'audit events carry the membership-shaped system role');
    await worker.runOnce();
    assert.equal(deliveries.filter((t) => t === 'pg test a').length, 1, 'a settled row is never re-delivered');
  } finally {
    await cleanup(pool, tenantId);
    await pool.end();
  }
});

test('outbox: two concurrent drains deliver the same row exactly once', { skip: pgSkip }, async () => {
  const { default: pg } = await import('pg');
  const pool = new pg.Pool({ connectionString: pgUrl, max: 10 });
  const tenantId = `t-${randomUUID().slice(0, 8)}`;
  try {
    await seedTenant(pool, tenantId);
    const deliveries = [];
    await enqueueConnectorMessage({ pool, tenantId, provider: 'discord', channelLabel: 'approvals', text: 'pg test b' });
    const postMessage = async ({ text }) => { await sleep(2500); deliveries.push(text); return { delivered: true, status: 204 }; };
    const w1 = createConnectorOutboundWorker({ pool, workerId: 'worker:pg-test-1', env: ENV, postMessage, log: () => {} });
    const w2 = createConnectorOutboundWorker({ pool, workerId: 'worker:pg-test-2', env: ENV, postMessage, log: () => {} });
    const [r1, r2] = await Promise.all([w1.runOnce(), w2.runOnce()]);
    assert.equal(deliveries.filter((t) => t === 'pg test b').length, 1, 'exactly one delivery of the test message across both drainers');
    assert.ok(r1.length + r2.length >= 1, 'at least one drainer reports the settle');
    const row = await onlyRow(pool, tenantId);
    assert.equal(row.status, 'sent');
    assert.equal((await auditRows(pool, tenantId)).length, 1, 'exactly one audit row');
  } finally {
    await cleanup(pool, tenantId);
    await pool.end();
  }
});

test('outbox: a failing delivery ends failed at the cap, audited, not stuck or lost', { skip: pgSkip }, async () => {
  const { default: pg } = await import('pg');
  const pool = new pg.Pool({ connectionString: pgUrl });
  const tenantId = `t-${randomUUID().slice(0, 8)}`;
  try {
    await seedTenant(pool, tenantId);
    await enqueueConnectorMessage({ pool, tenantId, provider: 'discord', channelLabel: 'approvals', text: 'pg test c' });
    const worker = createConnectorOutboundWorker({
      pool, workerId: 'worker:pg-test', env: ENV,
      postMessage: async () => { throw new Error('pg test delivery failure'); },
      log: () => {},
    });
    await worker.runOnce();
    let row = await onlyRow(pool, tenantId);
    assert.equal(row.status, 'queued', 'still queued after the first failure');
    assert.equal(row.attempts, 1, 'the attempt count is recorded, not lost');
    await worker.runOnce();
    await worker.runOnce();
    row = await onlyRow(pool, tenantId);
    assert.equal(row.status, 'failed', 'terminal failed at the attempt cap');
    assert.equal(row.attempts, 3);
    const audit = await auditRows(pool, tenantId);
    assert.equal(audit.length, 1);
    assert.equal(audit[0].action_type, 'connector.outbound.failed');
    assert.equal(audit[0].actor_role, 'member');
    assert.equal(audit[0].decision, 'DENY');
  } finally {
    await cleanup(pool, tenantId);
    await pool.end();
  }
});
