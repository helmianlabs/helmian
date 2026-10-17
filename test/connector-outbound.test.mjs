import assert from 'node:assert/strict';
import test from 'node:test';
import { createConnectorOutboundWorker, enqueueConnectorMessage, CONNECTOR_OUTBOUND_MAX_ATTEMPTS } from '../src/cora/connector-outbound-worker.mjs';
import { handleConnectorOutboundRoute, CONNECTOR_OUTBOX_TEST_PATH } from '../src/cloud/connector-outbound.mjs';
import { verifyGitHubRepo } from '../src/cloud/workspace-project-repository.mjs';
import { TenantAuthorizationError } from '../src/core/tenant-context.mjs';

function fakeOutboxPool({ messages = [], throwOn = null } = {}) {
  const rows = messages.map((m, i) => ({ id: i + 1, status: 'queued', attempts: 0, receipt: {}, channel_label: null, ...m }));
  const audits = [];
  const client = {
    async query(sql, params = []) {
      const q = String(sql).replace(/\s+/g, ' ').trim().toLowerCase();
      if (['begin', 'commit', 'rollback'].includes(q)) return { rows: [] };
      if (throwOn && q.includes(throwOn)) { const error = new Error('relation "helmion.connector_outbound_messages" does not exist'); error.code = '42P01'; throw error; }
      if (q.startsWith('insert into helmion.connector_outbound_messages')) {
        const row = { id: rows.length + 1, tenant_id: params[0], provider: params[1], channel_label: params[2], text: params[3], status: 'queued', attempts: 0, receipt: {} };
        rows.push(row);
        return { rows: [{ id: row.id }], rowCount: 1 };
      }
      if (q.includes('from helmion.connector_outbound_messages') && q.includes('for update skip locked')) {
        const cap = params[0];
        return { rows: rows.filter((r) => r.status === 'queued' && r.attempts < cap).slice(0, params[1]) };
      }
      if (q.startsWith('update helmion.connector_outbound_messages')) {
        const row = rows.find((r) => r.id === params[0] && r.status === 'queued');
        if (!row) return { rowCount: 0, rows: [] };
        // settle form: set status=$2, attempts=$3, receipt=$4 ; retry form: set attempts=$2
        if (q.includes('status = $2')) { row.status = params[1]; row.attempts = params[2]; row.receipt = JSON.parse(params[3]); }
        else { row.attempts = params[1]; }
        return { rowCount: 1, rows: [] };
      }
      if (q.startsWith('insert into helmion.audit_events')) { audits.push(params); return { rowCount: 1, rows: [{ id: '9' }] }; }
      throw new Error(`unexpected query: ${q.slice(0, 80)}`);
    },
    release() {},
  };
  return { pool: { connect: async () => client }, rows, audits };
}

test('enqueue validates input and inserts a queued row', async () => {
  const { pool, rows } = fakeOutboxPool();
  const result = await enqueueConnectorMessage({ pool, tenantId: 't-1', provider: 'discord', channelLabel: 'approvals', text: 'hello' });
  assert.equal(result.queued, true);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].provider, 'discord');
  assert.equal(rows[0].status, 'queued');
  await assert.rejects(() => enqueueConnectorMessage({ pool, tenantId: 't-1', provider: 'sms', text: 'x' }), /unsupported/);
  await assert.rejects(() => enqueueConnectorMessage({ pool, tenantId: 't-1', provider: 'slack', text: '' }), /missing or too long/);
  await assert.rejects(() => enqueueConnectorMessage({ pool, tenantId: 't-1', provider: 'slack', text: 'x'.repeat(4001) }), /missing or too long/);
});

test('enqueue is a 42P01 no-op when migration 052 is not applied', async () => {
  const { pool } = fakeOutboxPool({ throwOn: 'helmion.connector_outbound_messages' });
  const result = await enqueueConnectorMessage({ pool, tenantId: 't-1', provider: 'slack', text: 'hello' });
  assert.deepEqual(result, { queued: false, reason: 'unavailable' });
});

test('worker delivers queued messages and audits the send', async () => {
  const { pool, rows, audits } = fakeOutboxPool({ messages: [{ tenant_id: 't-1', provider: 'discord', text: 'hi' }] });
  const posted = [];
  const worker = createConnectorOutboundWorker({
    pool,
    env: { HELMION_DISCORD_WEBHOOK_URL: 'https://discord.com/api/webhooks/x' },
    postMessage: async ({ provider, text }) => { posted.push({ provider, text }); return { provider, delivered: true, status: 204 }; },
    log: () => {},
  });
  const done = await worker.runOnce();
  assert.equal(done.length, 1);
  assert.equal(rows[0].status, 'sent');
  assert.equal(posted.length, 1);
  assert.equal(posted[0].text, 'hi');
  assert.equal(audits.length, 1);
  assert.match(String(audits[0][5]), /connector.outbound.sent/);
  assert.equal((await worker.runOnce()).length, 0, 'sent rows are not re-delivered');
});

test('worker fails fast when no webhook URL is configured', async () => {
  const { pool, rows } = fakeOutboxPool({ messages: [{ tenant_id: 't-1', provider: 'slack', text: 'hi' }] });
  let posted = 0;
  const worker = createConnectorOutboundWorker({ pool, env: {}, postMessage: async () => { posted += 1; }, log: () => {} });
  await worker.runOnce();
  assert.equal(posted, 0, 'no HTTP attempt without a webhook URL');
  assert.equal(rows[0].status, 'failed');
  assert.equal(rows[0].receipt.reason, 'webhook_not_configured');
  assert.equal(rows[0].attempts, CONNECTOR_OUTBOUND_MAX_ATTEMPTS);
});

test('worker retries delivery failures up to the attempt cap', async () => {
  const { pool, rows } = fakeOutboxPool({ messages: [{ tenant_id: 't-1', provider: 'discord', text: 'hi' }] });
  const worker = createConnectorOutboundWorker({
    pool,
    env: { HELMION_DISCORD_WEBHOOK_URL: 'https://discord.com/api/webhooks/x' },
    postMessage: async () => { throw new Error('boom'); },
    log: () => {},
  });
  await worker.runOnce();
  assert.equal(rows[0].status, 'queued', 'still queued after first failure');
  assert.equal(rows[0].attempts, 1);
  await worker.runOnce();
  assert.equal(rows[0].attempts, 2);
  await worker.runOnce();
  assert.equal(rows[0].status, 'failed', 'terminal after the cap');
  assert.equal(rows[0].receipt.reason, 'delivery_failed');
});

test('worker is a 42P01 no-op when migration 052 is not applied', async () => {
  const { pool } = fakeOutboxPool({ throwOn: 'helmion.connector_outbound_messages' });
  const worker = createConnectorOutboundWorker({ pool, log: () => {} });
  assert.deepEqual(await worker.runOnce(), []);
});

function fakeRoute({ role = 'owner', body = { provider: 'discord' }, pool } = {}) {
  const sent = [];
  const request = { method: 'POST', url: CONNECTOR_OUTBOX_TEST_PATH };
  const requestUrl = new URL(`http://local${CONNECTOR_OUTBOX_TEST_PATH}`);
  const response = {};
  return {
    sent,
    args: {
      request,
      response,
      requestUrl,
      pool,
      activeActor: async () => ({ tenantId: 't-1', subject: 'u-1', role }),
      send: (res, status, payload) => { sent.push({ status, body: JSON.parse(payload) }); },
      readJsonObject: async () => body,
      exactKeys: (value, keys) => {
        const actual = Object.keys(value ?? {});
        if (actual.length !== keys.length || !keys.every((k) => actual.includes(k))) throw new Error('unexpected keys');
      },
      TenantAuthorizationError,
    },
  };
}

test('test-message endpoint enqueues for owners and rejects members', async () => {
  const { pool, rows } = fakeOutboxPool();
  const owner = fakeRoute({ role: 'owner', pool });
  assert.equal(await handleConnectorOutboundRoute(owner.args), true);
  assert.equal(owner.sent[0].status, 200);
  assert.equal(owner.sent[0].body.queued, true);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].channel_label, 'test');

  const member = fakeRoute({ role: 'member', pool });
  assert.equal(await handleConnectorOutboundRoute(member.args), true);
  assert.equal(member.sent[0].status, 403);
  assert.equal(member.sent[0].body.code, 'CONNECTOR_OUTBOX_ADMIN_REQUIRED');
  assert.equal(rows.length, 1, 'member request enqueues nothing');
});

test('test-message endpoint rejects unknown providers and non-test routes', async () => {
  const { pool } = fakeOutboxPool();
  const bad = fakeRoute({ role: 'owner', pool, body: { provider: 'sms' } });
  await handleConnectorOutboundRoute(bad.args);
  assert.equal(bad.sent[0].status, 400);

  const other = fakeRoute({ role: 'owner', pool });
  other.args.requestUrl = new URL('http://local/api/admin/cora/connectors');
  assert.equal(await handleConnectorOutboundRoute(other.args), false);
});

test('verifyGitHubRepo: 404 means not found, rate limits degrade, network errors degrade', async () => {
  const notFound = await verifyGitHubRepo({ owner: 'nope', name: 'nope', fetchImpl: async () => ({ status: 404, ok: false }) });
  assert.equal(notFound.notFound, true);
  assert.equal(notFound.verified, false);

  const rateLimited = await verifyGitHubRepo({ owner: 'o', name: 'n', fetchImpl: async () => ({ status: 429, ok: false }) });
  assert.equal(rateLimited.verified, false);
  assert.equal(rateLimited.notFound, undefined);

  const networkDown = await verifyGitHubRepo({ owner: 'o', name: 'n', fetchImpl: async () => { throw new Error('fetch failed'); } });
  assert.equal(networkDown.verified, false);

  const ok = await verifyGitHubRepo({ owner: 'o', name: 'n', fetchImpl: async (url, options) => {
    assert.match(url, /api.github.com\/repos\/o\/n/);
    assert.equal(options.headers['user-agent'], 'helmian-cloud');
    return { status: 200, ok: true };
  } });
  assert.equal(ok.verified, true);
});
