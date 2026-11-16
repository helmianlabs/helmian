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
import { resolveOutboundDestination } from '../src/cloud/connector-destinations.mjs';

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

// ---------------------------------------------------------------------
// Bite F: per-tenant routing against the real worker and real SQL.
// The resolver is injected (or is the real resolver over a fake
// credential client); delivery is the recording seam. Assertions stay
// scoped to each test's own tenants, as above.

async function rowsFor(pool, tenantId) {
  const result = await pool.query(
    'select status, attempts, receipt, text from helmion.connector_outbound_messages where tenant_id=$1 order by id',
    [tenantId],
  );
  return result.rows;
}

test('outbox: two tenants interleaved in one drain each receive only their own destination', { skip: pgSkip }, async () => {
  const { default: pg } = await import('pg');
  const pool = new pg.Pool({ connectionString: pgUrl });
  const tenantA = `t-${randomUUID().slice(0, 8)}`;
  const tenantB = `t-${randomUUID().slice(0, 8)}`;
  try {
    await seedTenant(pool, tenantA);
    await seedTenant(pool, tenantB);
    const urlA = 'https://discord.com/api/webhooks/pg-tenant-a';
    const urlB = 'https://discord.com/api/webhooks/pg-tenant-b';
    for (const [tenantId, text] of [[tenantA, 'pg-a1'], [tenantB, 'pg-b1'], [tenantA, 'pg-a2'], [tenantB, 'pg-b2']]) {
      await enqueueConnectorMessage({ pool, tenantId, provider: 'discord', text });
    }
    const posted = [];
    const resolveCalls = [];
    const worker = createConnectorOutboundWorker({
      pool, workerId: 'worker:pg-test', env: {},
      resolveDestination: async ({ tenantId, provider }) => {
        resolveCalls.push(`${tenantId} ${provider}`);
        if (tenantId === tenantA) return { kind: 'tenant', webhookUrl: urlA };
        if (tenantId === tenantB) return { kind: 'tenant', webhookUrl: urlB };
        return { kind: 'none' };
      },
      postMessage: async ({ text, webhookUrl }) => { posted.push({ text, webhookUrl }); return { delivered: true, status: 204 }; },
      log: () => {},
    });
    await worker.runOnce();
    const own = posted.filter((p) => ['pg-a1', 'pg-a2', 'pg-b1', 'pg-b2'].includes(p.text));
    assert.equal(own.length, 4, 'each interleaved message is delivered exactly once');
    const byText = Object.fromEntries(own.map((p) => [p.text, p.webhookUrl]));
    assert.equal(byText['pg-a1'], urlA);
    assert.equal(byText['pg-a2'], urlA);
    assert.equal(byText['pg-b1'], urlB);
    assert.equal(byText['pg-b2'], urlB);
    assert.equal(resolveCalls.filter((c) => c === `${tenantA} discord`).length, 1, 'tenant A resolved once for the whole group');
    assert.equal(resolveCalls.filter((c) => c === `${tenantB} discord`).length, 1, 'tenant B resolved once for the whole group');
    for (const tenantId of [tenantA, tenantB]) {
      const rows = await rowsFor(pool, tenantId);
      assert.equal(rows.length, 2);
      assert.ok(rows.every((r) => r.status === 'sent'), 'both tenants rows settle sent');
    }
  } finally {
    await cleanup(pool, tenantA);
    await cleanup(pool, tenantB);
    await pool.end();
  }
});

test('outbox: one tenant failing destination does not block the other tenant in the same drain', { skip: pgSkip }, async () => {
  const { default: pg } = await import('pg');
  const pool = new pg.Pool({ connectionString: pgUrl });
  const tenantA = `t-${randomUUID().slice(0, 8)}`;
  const tenantB = `t-${randomUUID().slice(0, 8)}`;
  try {
    await seedTenant(pool, tenantA);
    await seedTenant(pool, tenantB);
    await enqueueConnectorMessage({ pool, tenantId: tenantA, provider: 'discord', text: 'pg-ok' });
    await enqueueConnectorMessage({ pool, tenantId: tenantB, provider: 'discord', text: 'pg-dead' });
    const urlB = 'https://discord.com/api/webhooks/pg-dead-tenant';
    const worker = createConnectorOutboundWorker({
      pool, workerId: 'worker:pg-test', env: {},
      resolveDestination: async ({ tenantId }) => (tenantId === tenantB
        ? { kind: 'tenant', webhookUrl: urlB }
        : { kind: 'tenant', webhookUrl: 'https://discord.com/api/webhooks/pg-ok-tenant' }),
      postMessage: async ({ webhookUrl }) => {
        if (webhookUrl === urlB) throw new Error('410 Gone');
        return { delivered: true, status: 204 };
      },
      log: () => {},
    });
    await worker.runOnce();
    const [rowA] = await rowsFor(pool, tenantA);
    assert.equal(rowA.status, 'sent');
    const [rowB] = await rowsFor(pool, tenantB);
    assert.equal(rowB.status, 'queued', 'the failing tenant row stays queued for a later drain');
    assert.equal(rowB.attempts, 1);
  } finally {
    await cleanup(pool, tenantA);
    await cleanup(pool, tenantB);
    await pool.end();
  }
});

test('outbox: a tenant with no destination fails named on first drain, with zero delivery attempts', { skip: pgSkip }, async () => {
  const { default: pg } = await import('pg');
  const pool = new pg.Pool({ connectionString: pgUrl });
  const tenantId = `t-${randomUUID().slice(0, 8)}`;
  try {
    await seedTenant(pool, tenantId);
    await enqueueConnectorMessage({ pool, tenantId, provider: 'discord', text: 'pg-nodest' });
    const posted = [];
    const worker = createConnectorOutboundWorker({
      pool, workerId: 'worker:pg-test',
      env: { HELMION_DISCORD_WEBHOOK_URL: 'https://discord.com/api/webhooks/pg-env' },
      resolveDestination: async () => ({ kind: 'none' }),
      postMessage: async (args) => { posted.push(args); return { delivered: true, status: 204 }; },
      log: () => {},
    });
    await worker.runOnce();
    const [row] = await rowsFor(pool, tenantId);
    assert.equal(row.status, 'failed');
    assert.equal(row.attempts, 3, 'terminal on the first drain, like webhook_not_configured');
    assert.equal(row.receipt.reason, 'tenant_destination_not_configured');
    assert.equal(posted.filter((p) => p.text === 'pg-nodest').length, 0, 'no delivery is attempted without a destination');
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

test('outbox: the operator tenant falls back to the env webhook; a non-operator tenant does not', { skip: pgSkip }, async () => {
  const { default: pg } = await import('pg');
  const pool = new pg.Pool({ connectionString: pgUrl });
  const operator = `t-${randomUUID().slice(0, 8)}`;
  const other = `t-${randomUUID().slice(0, 8)}`;
  try {
    await seedTenant(pool, operator);
    await seedTenant(pool, other);
    await enqueueConnectorMessage({ pool, tenantId: operator, provider: 'discord', text: 'pg-op' });
    await enqueueConnectorMessage({ pool, tenantId: other, provider: 'discord', text: 'pg-other' });
    const envUrl = 'https://discord.com/api/webhooks/pg-env-fallback';
    const opEnv = { HELMION_OPERATOR_TENANT_ID: operator, HELMION_DISCORD_WEBHOOK_URL: envUrl };
    const posted = [];
    const worker = createConnectorOutboundWorker({
      pool, workerId: 'worker:pg-test', env: opEnv,
      resolveDestination: ({ tenantId, provider }) => resolveOutboundDestination({ credentials: null, tenantId, provider, env: opEnv, actorContext: null }),
      postMessage: async (args) => { posted.push(args); return { delivered: true, status: 204 }; },
      log: () => {},
    });
    await worker.runOnce();
    const [opRow] = await rowsFor(pool, operator);
    assert.equal(opRow.status, 'sent');
    assert.equal(posted.find((p) => p.text === 'pg-op')?.webhookUrl, envUrl, 'the operator row is delivered to the env webhook');
    const [otherRow] = await rowsFor(pool, other);
    assert.equal(otherRow.status, 'failed');
    assert.equal(otherRow.receipt.reason, 'tenant_destination_not_configured');
    assert.equal(posted.filter((p) => p.text === 'pg-other').length, 0);
  } finally {
    await cleanup(pool, operator);
    await cleanup(pool, other);
    await pool.end();
  }
});

test('outbox: a stored tenant destination wins over the env fallback', { skip: pgSkip }, async () => {
  const { default: pg } = await import('pg');
  const pool = new pg.Pool({ connectionString: pgUrl });
  const operator = `t-${randomUUID().slice(0, 8)}`;
  try {
    await seedTenant(pool, operator);
    await enqueueConnectorMessage({ pool, tenantId: operator, provider: 'discord', text: 'pg-op-tenant' });
    const envUrl = 'https://discord.com/api/webhooks/pg-env-loses';
    const tenantUrl = 'https://discord.com/api/webhooks/pg-tenant-wins';
    const opEnv = { HELMION_OPERATOR_TENANT_ID: operator, HELMION_DISCORD_WEBHOOK_URL: envUrl };
    const credentials = {
      async resolveVaultCredential(input) {
        return input.providerId === 'discord-outbound'
          ? { accepted: true, credential: tenantUrl }
          : { accepted: false, status: 'credential_not_available' };
      },
    };
    const actorContext = { actorSubject: 'worker:pg-test', actorRole: 'member', sessionId: 'sess-pg', requestId: 'req-pg' };
    const posted = [];
    const worker = createConnectorOutboundWorker({
      pool, workerId: 'worker:pg-test', env: opEnv,
      resolveDestination: ({ tenantId, provider }) => resolveOutboundDestination({ credentials, tenantId, provider, env: opEnv, actorContext }),
      postMessage: async (args) => { posted.push(args); return { delivered: true, status: 204 }; },
      log: () => {},
    });
    await worker.runOnce();
    const [row] = await rowsFor(pool, operator);
    assert.equal(row.status, 'sent');
    assert.equal(posted.find((p) => p.text === 'pg-op-tenant')?.webhookUrl, tenantUrl);
  } finally {
    await cleanup(pool, operator);
    await pool.end();
  }
});
