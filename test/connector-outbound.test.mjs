import assert from 'node:assert/strict';
import test from 'node:test';
import { createConnectorOutboundWorker, enqueueConnectorMessage, CONNECTOR_OUTBOUND_MAX_ATTEMPTS } from '../src/cora/connector-outbound-worker.mjs';
import { handleConnectorOutboundRoute, CONNECTOR_OUTBOX_TEST_PATH, CONNECTOR_OUTBOX_DESTINATION_PATH } from '../src/cloud/connector-outbound.mjs';
import { verifyGitHubRepo } from '../src/cloud/workspace-project-repository.mjs';
import { TenantAuthorizationError } from '../src/core/tenant-context.mjs';

function fakeOutboxPool({ messages = [], throwOn = null } = {}) {
  const rows = messages.map((m, i) => ({ id: i + 1, status: 'queued', attempts: 0, receipt: {}, channel_label: null, ...m }));
  const audits = [];
  const client = {
    async query(sql, params = []) {
      const q = String(sql).replace(/\s+/g, ' ').trim().toLowerCase();
      if (['begin', 'commit', 'rollback'].includes(q)) return { rows: [] };
      // The settle's audit insert rides behind a savepoint; the fake
      // models savepoint statements as no-ops (its audit insert never
      // fails, so the rollback-to-savepoint path is not exercised here;
      // the real-database test covers the settle itself).
      if (q.startsWith('savepoint') || q.startsWith('release savepoint') || q.startsWith('rollback to savepoint')) return { rows: [] };
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

test('verifyGitHubRepo: 404 means not found, rate limits degrade, network errors degrade', async () => {  const notFound = await verifyGitHubRepo({ owner: 'nope', name: 'nope', fetchImpl: async () => ({ status: 404, ok: false }) });
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

// ---------------------------------------------------------------------
// Bite F: per-tenant routing. The tests above construct the worker
// with no resolver and pin the historical env behaviour; the tests
// below construct it with a destination resolver (injected, or built
// from a credential client) and pin the per-tenant contract.

test('worker routes each tenant group to its own destination, resolving once per group', async () => {
  const { pool, rows, audits } = fakeOutboxPool({ messages: [
    { tenant_id: 't-a', provider: 'discord', text: 'a1' },
    { tenant_id: 't-b', provider: 'discord', text: 'b1' },
    { tenant_id: 't-a', provider: 'discord', text: 'a2' },
    { tenant_id: 't-b', provider: 'slack', text: 'b2' },
  ] });
  const destinations = new Map([
    ['t-a discord', 'https://discord.com/api/webhooks/tenant-a'],
    ['t-b discord', 'https://discord.com/api/webhooks/tenant-b'],
    ['t-b slack', 'https://hooks.slack.com/services/tenant-b'],
  ]);
  const resolveCalls = [];
  const posted = [];
  const worker = createConnectorOutboundWorker({
    pool,
    env: {},
    resolveDestination: async ({ tenantId, provider }) => {
      resolveCalls.push(`${tenantId} ${provider}`);
      const webhookUrl = destinations.get(`${tenantId} ${provider}`);
      return webhookUrl ? { kind: 'tenant', webhookUrl } : { kind: 'none' };
    },
    postMessage: async ({ provider, text, webhookUrl }) => { posted.push({ provider, text, webhookUrl }); return { provider, delivered: true, status: 204 }; },
    log: () => {},
  });
  const done = await worker.runOnce();
  assert.equal(done.length, 4);
  assert.deepEqual([...resolveCalls].sort(), ['t-a discord', 't-b discord', 't-b slack'], 'one resolution per (tenant, provider) group per drain');
  const byText = Object.fromEntries(posted.map((p) => [p.text, p.webhookUrl]));
  assert.equal(byText.a1, 'https://discord.com/api/webhooks/tenant-a');
  assert.equal(byText.a2, 'https://discord.com/api/webhooks/tenant-a');
  assert.equal(byText.b1, 'https://discord.com/api/webhooks/tenant-b');
  assert.equal(byText.b2, 'https://hooks.slack.com/services/tenant-b');
  assert.ok(rows.every((r) => r.status === 'sent'));
  assert.equal(audits.length, 4);
});

test('one tenant destination failing does not block other tenants in the same drain', async () => {
  const { pool, rows } = fakeOutboxPool({ messages: [
    { tenant_id: 't-a', provider: 'discord', text: 'a1' },
    { tenant_id: 't-b', provider: 'discord', text: 'b1' },
  ] });
  const worker = createConnectorOutboundWorker({
    pool,
    env: {},
    resolveDestination: async ({ tenantId }) => ({ kind: 'tenant', webhookUrl: `https://discord.com/api/webhooks/${tenantId}` }),
    postMessage: async ({ webhookUrl }) => {
      if (webhookUrl.endsWith('t-b')) throw new Error('tenant b webhook is dead');
      return { delivered: true, status: 204 };
    },
    log: () => {},
  });
  await worker.runOnce();
  assert.equal(rows.find((r) => r.text === 'a1').status, 'sent');
  const b = rows.find((r) => r.text === 'b1');
  assert.equal(b.status, 'queued', 'the failing tenant row stays queued for retry');
  assert.equal(b.attempts, 1);
});

test('a tenant with no destination fails with tenant_destination_not_configured and no delivery attempt', async () => {
  const { pool, rows, audits } = fakeOutboxPool({ messages: [
    { tenant_id: 't-a', provider: 'discord', text: 'a1' },
    { tenant_id: 't-b', provider: 'discord', text: 'b1' },
  ] });
  const posted = [];
  const worker = createConnectorOutboundWorker({
    pool,
    env: { HELMION_DISCORD_WEBHOOK_URL: 'https://discord.com/api/webhooks/env' },
    resolveDestination: async ({ tenantId }) => (tenantId === 't-a'
      ? { kind: 'tenant', webhookUrl: 'https://discord.com/api/webhooks/tenant-a' }
      : { kind: 'none' }),
    postMessage: async (args) => { posted.push(args); return { delivered: true, status: 204 }; },
    log: () => {},
  });
  await worker.runOnce();
  const b = rows.find((r) => r.text === 'b1');
  assert.equal(b.status, 'failed');
  assert.equal(b.receipt.reason, 'tenant_destination_not_configured');
  assert.equal(b.attempts, CONNECTOR_OUTBOUND_MAX_ATTEMPTS);
  assert.equal(posted.length, 1, 'only the tenant with a destination is posted; the env URL is not a fallback');
  assert.equal(posted[0].text, 'a1');
  const actions = audits.map((a) => String(a[5]));
  assert.ok(actions.some((a) => a.includes('connector.outbound.failed')), 'the named failure is audited');
});

test('a destination resolution error leaves that group queued and other groups proceed', async () => {
  const { pool, rows } = fakeOutboxPool({ messages: [
    { tenant_id: 't-a', provider: 'discord', text: 'a1' },
    { tenant_id: 't-b', provider: 'discord', text: 'b1' },
  ] });
  const logs = [];
  const worker = createConnectorOutboundWorker({
    pool,
    env: {},
    resolveDestination: async ({ tenantId }) => {
      if (tenantId === 't-b') throw new Error('vault unreachable');
      return { kind: 'tenant', webhookUrl: 'https://discord.com/api/webhooks/tenant-a' };
    },
    postMessage: async () => ({ delivered: true, status: 204 }),
    log: (line) => logs.push(line),
  });
  await worker.runOnce();
  assert.equal(rows.find((r) => r.text === 'a1').status, 'sent');
  const b = rows.find((r) => r.text === 'b1');
  assert.equal(b.status, 'queued');
  assert.equal(b.attempts, 0, 'no delivery was attempted for the unresolved group');
  assert.ok(logs.some((l) => l.includes('destination resolution failed')), 'the resolution failure is logged');
});

function fakeVaultCredentials(records = {}) {
  return {
    async resolveVaultCredential(input) {
      const url = records[input.providerId];
      return url ? { accepted: true, credential: url } : { accepted: false, status: 'credential_not_available' };
    },
  };
}

test('worker built from a credential client: operator falls back to env, other tenants fail named', async () => {
  const { pool, rows } = fakeOutboxPool({ messages: [
    { tenant_id: 't-op', provider: 'discord', text: 'op1' },
    { tenant_id: 't-other', provider: 'discord', text: 'other1' },
  ] });
  const posted = [];
  const worker = createConnectorOutboundWorker({
    pool,
    env: { HELMION_OPERATOR_TENANT_ID: 't-op', HELMION_DISCORD_WEBHOOK_URL: 'https://discord.com/api/webhooks/env' },
    credentials: fakeVaultCredentials(),
    postMessage: async (args) => { posted.push(args); return { delivered: true, status: 204 }; },
    log: () => {},
  });
  await worker.runOnce();
  assert.equal(rows.find((r) => r.text === 'op1').status, 'sent');
  assert.equal(posted.find((p) => p.text === 'op1').webhookUrl, 'https://discord.com/api/webhooks/env');
  const other = rows.find((r) => r.text === 'other1');
  assert.equal(other.status, 'failed');
  assert.equal(other.receipt.reason, 'tenant_destination_not_configured');
  assert.equal(posted.length, 1);
});

test('worker built from a credential client: a stored tenant destination wins over the env fallback', async () => {
  const { pool, rows } = fakeOutboxPool({ messages: [{ tenant_id: 't-op', provider: 'discord', text: 'op1' }] });
  const posted = [];
  const worker = createConnectorOutboundWorker({
    pool,
    env: { HELMION_OPERATOR_TENANT_ID: 't-op', HELMION_DISCORD_WEBHOOK_URL: 'https://discord.com/api/webhooks/env' },
    credentials: fakeVaultCredentials({ 'discord-outbound': 'https://discord.com/api/webhooks/tenant-op' }),
    postMessage: async (args) => { posted.push(args); return { delivered: true, status: 204 }; },
    log: () => {},
  });
  await worker.runOnce();
  assert.equal(rows[0].status, 'sent');
  assert.equal(posted[0].webhookUrl, 'https://discord.com/api/webhooks/tenant-op');
});

// ---------------------------------------------------------------------
// Bite F: the destination save/read surface beside the test button.

function fakeRouteCredentials({ records = {}, storeAnswer = { accepted: true, status: 'stored_in_credential_vault' } } = {}) {
  const stores = [];
  const resolves = [];
  return {
    stores,
    resolves,
    async storeCredential(input) { stores.push(input); return storeAnswer; },
    async resolveVaultCredential(input) {
      resolves.push(input);
      const url = records[input.providerId];
      return url ? { accepted: true, credential: url } : { accepted: false, status: 'credential_not_available' };
    },
  };
}

function fakeDestinationRoute({ role = 'owner', method = 'POST', body = { provider: 'discord', webhookUrl: 'https://discord.com/api/webhooks/owner' }, credentials } = {}) {
  const sent = [];
  return {
    sent,
    args: {
      request: { method, url: CONNECTOR_OUTBOX_DESTINATION_PATH },
      response: {},
      requestUrl: new URL(`http://local${CONNECTOR_OUTBOX_DESTINATION_PATH}`),
      pool: fakeOutboxPool().pool,
      activeActor: async () => ({ tenantId: 't-1', subject: 'u-1', role, sessionId: 's-1', requestId: 'r-1' }),
      send: (res, status, payload) => { sent.push({ status, body: JSON.parse(payload) }); },
      readJsonObject: async () => body,
      exactKeys: (value, keys) => {
        const actual = Object.keys(value ?? {});
        if (actual.length !== keys.length || !keys.every((k) => actual.includes(k))) throw new Error('unexpected keys');
      },
      TenantAuthorizationError,
      credentials,
    },
  };
}

test('destination endpoint stores the caller tenant webhook for owners, and never echoes it', async () => {
  const credentials = fakeRouteCredentials();
  const route = fakeDestinationRoute({ credentials });
  assert.equal(await handleConnectorOutboundRoute(route.args), true);
  assert.equal(route.sent[0].status, 200);
  assert.equal(route.sent[0].body.configured, true);
  assert.doesNotMatch(JSON.stringify(route.sent[0].body), /webhooks\/owner/, 'the stored URL is never read back');
  assert.equal(credentials.stores.length, 1);
  const input = credentials.stores[0];
  assert.equal(input.tenantId, 't-1');
  assert.equal(input.providerId, 'discord-outbound');
  assert.equal(input.credentialReference, 'vault://tenant/t-1/discord-outbound/webhook');
  assert.equal(input.credentialKind, 'api_key');
  assert.equal(input.apiKey, 'https://discord.com/api/webhooks/owner');
  assert.equal(input.actorSubject, 'u-1');
  assert.equal(input.actorRole, 'owner');
});

test('destination endpoint rejects members, bad hosts, and a missing credential service', async () => {
  const memberCreds = fakeRouteCredentials();
  const member = fakeDestinationRoute({ role: 'member', credentials: memberCreds });
  await handleConnectorOutboundRoute(member.args);
  assert.equal(member.sent[0].status, 403);
  assert.equal(member.sent[0].body.code, 'CONNECTOR_OUTBOX_ADMIN_REQUIRED');
  assert.equal(memberCreds.stores.length, 0);

  const badCreds = fakeRouteCredentials();
  const bad = fakeDestinationRoute({ credentials: badCreds, body: { provider: 'discord', webhookUrl: 'https://example.com/api/webhooks/x' } });
  await handleConnectorOutboundRoute(bad.args);
  assert.equal(bad.sent[0].status, 400);
  assert.equal(bad.sent[0].body.code, 'CONNECTOR_DESTINATION_INVALID');
  assert.equal(badCreds.stores.length, 0, 'an off-allowlist URL is never stored');

  const unconfigured = fakeDestinationRoute({ credentials: undefined });
  await handleConnectorOutboundRoute(unconfigured.args);
  assert.equal(unconfigured.sent[0].status, 503);
  assert.equal(unconfigured.sent[0].body.code, 'CONNECTOR_DESTINATION_UNAVAILABLE');
});

test('destination endpoint surfaces a Guard replacement refusal without touching the stored value', async () => {
  const credentials = fakeRouteCredentials({ storeAnswer: { accepted: false, status: 'guard_approval_required' } });
  const route = fakeDestinationRoute({ credentials });
  await handleConnectorOutboundRoute(route.args);
  assert.equal(route.sent[0].status, 409);
  assert.equal(route.sent[0].body.code, 'GUARD_APPROVAL_REQUIRED');
});

test('destination endpoint reads back configured state only, never the URL', async () => {
  const credentials = fakeRouteCredentials({ records: { 'discord-outbound': 'https://discord.com/api/webhooks/owner' } });
  const route = fakeDestinationRoute({ method: 'GET', body: {}, credentials });
  assert.equal(await handleConnectorOutboundRoute(route.args), true);
  assert.equal(route.sent[0].status, 200);
  assert.deepEqual(route.sent[0].body.destinations, { discord: { configured: true }, slack: { configured: false } });
  assert.doesNotMatch(JSON.stringify(route.sent[0].body), /webhooks\/owner/);
});
