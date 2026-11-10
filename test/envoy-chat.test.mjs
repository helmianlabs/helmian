import test from 'node:test';
import assert from 'node:assert/strict';
import { assertEnvoyMembership, attachChannelLinks, normalizeEnvoyChannel, normalizeEnvoyMessage } from '../src/cloud/envoy-chat.mjs';
import { parseConfig, serializeConfig } from '../src/cloud/envoy-agents.mjs';

test('normalizes bounded tenant channel definitions', () => {
  assert.deepEqual(normalizeEnvoyChannel({ slug: 'Ops-Room', title: 'Operations', kind: 'team' }), {
    slug: 'ops-room', title: 'Operations', kind: 'team'
  });
  assert.throws(() => normalizeEnvoyChannel({ slug: 'bad path', title: 'x' }), /slug/);
});

test('normalizes bounded messages and rejects unsupported authors', () => {
  assert.equal(normalizeEnvoyMessage({ channelId: 'c1', authorSubject: 'u1', authorKind: 'human', body: 'hello' }).body, 'hello');
  assert.throws(() => normalizeEnvoyMessage({ channelId: 'c1', authorSubject: 'u1', authorKind: 'tool', body: 'x' }), /author kind/);
});

test('requires live membership and explicit Envoy policy enablement', () => {
  assert.equal(assertEnvoyMembership({ tenantId: 't1', subject: 'u1', role: 'admin', canUseEnvoy: true }), true);
  assert.throws(() => assertEnvoyMembership({ tenantId: 't1', subject: 'u1', role: 'admin', canUseEnvoy: false }), /not enabled/);
  assert.throws(() => assertEnvoyMembership({ tenantId: 't1', subject: 'u1', role: 'driver', canUseEnvoy: true }), /unsupported/);
});

test('message metadata: attachments normalize, junk refuses, absence stays absent', () => {
  const withMeta = normalizeEnvoyMessage({ channelId: 'c1', authorSubject: 'u1', authorKind: 'human', body: 'hi', metadata: { attachments: [{ kind: 'connector', key: 'Slack' }], webSearch: false } });
  assert.equal(withMeta.metadata.attachments[0].key, 'slack');
  assert.equal(withMeta.metadata.webSearch, false);
  const bare = normalizeEnvoyMessage({ channelId: 'c1', authorSubject: 'u1', authorKind: 'human', body: 'hi' });
  assert.equal('metadata' in bare, false, 'the pre-picker shape is unchanged');
  const arrayShape = normalizeEnvoyMessage({ channelId: 'c1', authorSubject: 'u1', authorKind: 'human', body: 'hi', attachments: [{ kind: 'plugin', name: 'calcplug' }] });
  assert.equal(arrayShape.metadata.attachments[0].name, 'calcplug');
  assert.throws(() => normalizeEnvoyMessage({ channelId: 'c1', authorSubject: 'u1', authorKind: 'human', body: 'hi', metadata: { attachments: [{ kind: 'wormhole', name: 'x' }] } }), /unsupported/);
});

test('channels list carries each channel its own Discord/Slack link (bite 2)', () => {
  // Config rows as stored (serializeConfig) and re-read (parseConfig),
  // exactly the round trip listChannels performs against the database.
  const linked = parseConfig(serializeConfig({
    agents: [], joined: {},
    discord: { guildId: '1563445314692718645', channelId: '1563445315237974069', channelName: 'general', guildName: 'HELMIAN', linkedAt: null },
    slack: null, pendingLink: null,
  }));
  const channels = [
    { id: 'team-1', slug: 'team', title: 'Team', kind: 'team' },
    { id: 'room-1', slug: 'troy', title: 'troy', kind: 'agent' },
    { id: 'bare-1', slug: 'ops', title: 'Ops', kind: 'team' },
  ];
  const out = attachChannelLinks(channels, new Map([['room-1', linked]]));
  assert.equal(out[0].discord, null, 'an unlinked channel says null, not a guess');
  assert.equal(out[1].discord.channelName, 'general', 'the linked room carries its Discord link in the list payload');
  assert.equal(out[1].discord.channelId, '1563445315237974069');
  assert.equal(out[1].slack, null);
  assert.equal(out[2].discord, null, 'a channel with no config row at all reads unlinked');
});

// ---------- the empty-desk answer (polish P1, 2026-11-09) ----------
// A human message in a workspace with no AI connected is answered
// in the channel by Maestro himself — the fix for the fresh-signup
// walk's headline finding (a first message met a dispatch line and
// then silence). These tests run the real store against a scripted
// pool: the state reader is the production tenantAgentStateOn, so
// the decision chain exercised here is the one production runs;
// only the database is fake. The live-database exercise stays with
// the HELMIAN_TEST_PG_URL suites.
import {
  createEnvoyStore,
  emptyDeskAnswerDecision,
  postEmptyDeskAnswerIfNeeded,
  EMPTY_DESK_SUBJECT,
  EMPTY_DESK_ANSWER_BODY,
  EMPTY_DESK_KEY_PREFIX,
} from '../src/cloud/envoy-chat.mjs';
import { tenantAgentStateOn } from '../src/cloud/tenant-agent-state.mjs';

const ED_TENANT = '11111111-1111-4111-8111-111111111111';
const ED_CHANNEL = '33333333-3333-4333-8333-333333333333';
const edOwner = { tenantId: ED_TENANT, subject: 'user_owner', role: 'owner', sessionId: 's1', requestId: 'r1' };

// A pool whose envoy_messages table lives in memory, with the
// idempotency conflict the store relies on, plus the three reads
// tenantAgentStateOn makes (desktop links, presence, connections).
function emptyDeskFakePool({ connections = [] } = {}) {
  const messages = [];
  let nextId = 1;
  const client = {
    async query(text, vals = []) {
      const sql = String(text).replace(/\s+/g, ' ').trim();
      if (/^(begin|commit|rollback)/i.test(sql)) return { rows: [], rowCount: 0 };
      if (sql.includes('set_config')) return { rows: [], rowCount: 0 };
      if (sql.includes('from helmion.tenant_memberships')) return { rows: [{ role: 'owner' }], rowCount: 1 };
      if (sql.includes('from helmion.desktop_links')) return { rows: [{ n: 0 }], rowCount: 1 };
      if (sql.includes('from helmion.runner_provider_presence')) return { rows: [], rowCount: 0 };
      if (sql.includes('from helmion.provider_connections')) return { rows: connections, rowCount: connections.length };
      if (sql.includes('from helmion.user_profiles')) return { rows: [], rowCount: 0 };
      if (/^insert into helmion\.envoy_messages/i.test(sql)) {
        const helperShape = sql.includes(`'agent'`);
        const [tenantId, channelId, subject, a, b, c] = vals;
        const kind = helperShape ? 'agent' : a;
        const body = helperShape ? a : b;
        const key = helperShape ? b : c;
        const dupe = messages.find((m) => m.tenant_id === tenantId && m.channel_id === channelId && m.author_subject === subject && m.idempotency_key === key);
        if (dupe) return { rows: [], rowCount: 0 };
        const row = { id: nextId++, tenant_id: tenantId, channel_id: channelId, author_subject: subject, author_kind: kind, body, idempotency_key: key, created_at: new Date().toISOString(), metadata: null };
        messages.push(row);
        return { rows: [row], rowCount: 1 };
      }
      if (sql.includes('from helmion.envoy_messages') && sql.includes('order by id desc')) {
        const [tenantId, channelId, notSubject, notId] = vals;
        const rows = messages
          .filter((m) => m.tenant_id === tenantId && m.channel_id === channelId && m.author_subject !== notSubject && m.id !== Number(notId))
          .sort((x, y) => y.id - x.id).slice(0, 1);
        return { rows, rowCount: rows.length };
      }
      if (sql.includes('from helmion.envoy_messages')) {
        const [tenantId, channelId, subject, key] = vals;
        const rows = messages.filter((m) => m.tenant_id === tenantId && m.channel_id === channelId && m.author_subject === subject && m.idempotency_key === key);
        return { rows, rowCount: rows.length };
      }
      throw new Error(`unexpected query: ${sql.slice(0, 90)}`);
    },
    release() {},
  };
  return { pool: { async connect() { return client; } }, messages };
}

test('empty-desk decision: answers only a zero-provider workspace whose last word is not the answer', () => {
  assert.equal(emptyDeskAnswerDecision({ connectedProviders: [], previousSubject: 'user_owner', previousKey: 'k1' }), true);
  assert.equal(emptyDeskAnswerDecision({ connectedProviders: [], previousSubject: null, previousKey: null }), true);
  assert.equal(emptyDeskAnswerDecision({ connectedProviders: ['claude'], previousSubject: 'user_owner', previousKey: 'k1' }), false);
  assert.equal(emptyDeskAnswerDecision({ connectedProviders: [], previousSubject: EMPTY_DESK_SUBJECT, previousKey: `${EMPTY_DESK_KEY_PREFIX}7` }), false);
  // A Maestro message that is not this answer (e.g. the activation
  // notice's own key shape) does not suppress the answer.
  assert.equal(emptyDeskAnswerDecision({ connectedProviders: [], previousSubject: EMPTY_DESK_SUBJECT, previousKey: 'maestro-activation:x' }), true);
  // Unknown state stays quiet: the answer never fires on a guess.
  assert.equal(emptyDeskAnswerDecision({ connectedProviders: undefined, previousSubject: 'user_owner', previousKey: 'k1' }), false);
});

test('zero-seat message: Maestro answers in the channel with the one fix', async () => {
  const { pool, messages } = emptyDeskFakePool();
  const store = createEnvoyStore(pool);
  const out = await store.appendMessage(edOwner, { channelId: ED_CHANNEL, body: 'hello, anyone here?', idempotencyKey: 'send-1' });
  assert.equal(out.receipt.replayed, false);
  const answers = messages.filter((m) => m.author_subject === EMPTY_DESK_SUBJECT);
  assert.equal(answers.length, 1);
  assert.equal(answers[0].author_kind, 'agent');
  assert.equal(answers[0].body, EMPTY_DESK_ANSWER_BODY);
  assert.equal(answers[0].idempotency_key, `${EMPTY_DESK_KEY_PREFIX}${out.receipt.message.id}`);
  assert.match(answers[0].body, /Agents tab/);
  assert.match(answers[0].body, /Connect/);
});

test('zero-seat follow-up: the answer does not stack — a second send waits for a connection', async () => {
  const { pool, messages } = emptyDeskFakePool();
  const store = createEnvoyStore(pool);
  await store.appendMessage(edOwner, { channelId: ED_CHANNEL, body: 'first', idempotencyKey: 'send-1' });
  await store.appendMessage(edOwner, { channelId: ED_CHANNEL, body: 'second', idempotencyKey: 'send-2' });
  assert.equal(messages.filter((m) => m.author_subject === EMPTY_DESK_SUBJECT).length, 1);
  assert.equal(messages.filter((m) => m.author_kind === 'human').length, 2);
});

test('zero-seat replay: an idempotent retry of the same send adds no second answer', async () => {
  const { pool, messages } = emptyDeskFakePool();
  const store = createEnvoyStore(pool);
  await store.appendMessage(edOwner, { channelId: ED_CHANNEL, body: 'hello', idempotencyKey: 'send-1' });
  const retry = await store.appendMessage(edOwner, { channelId: ED_CHANNEL, body: 'hello', idempotencyKey: 'send-1' });
  assert.equal(retry.receipt.replayed, true);
  assert.equal(messages.filter((m) => m.author_subject === EMPTY_DESK_SUBJECT).length, 1);
});

test('connected workspace: no empty-desk answer once a provider is connected', async () => {
  const { pool, messages } = emptyDeskFakePool({ connections: [{ provider_id: 'claude', credential_reference: 'vault://seat-credential' }] });
  const store = createEnvoyStore(pool);
  await store.appendMessage(edOwner, { channelId: ED_CHANNEL, body: 'hello', idempotencyKey: 'send-1' });
  assert.equal(messages.filter((m) => m.author_subject === EMPTY_DESK_SUBJECT).length, 0);
});

test('bridge send: agent-authored posts never trigger the answer', async () => {
  const { pool, messages } = emptyDeskFakePool();
  const store = createEnvoyStore(pool);
  const bridge = { ...edOwner, subject: 'device-1', viaDeviceToken: true };
  await store.appendMessage(bridge, { channelId: ED_CHANNEL, body: 'agent reply', idempotencyKey: 'bridge-1' });
  assert.equal(messages.filter((m) => m.author_subject === EMPTY_DESK_SUBJECT).length, 0);
});

test('postEmptyDeskAnswerIfNeeded: reports the outcome and keys the answer to the human message', async () => {
  const { pool, messages } = emptyDeskFakePool();
  messages.push({ id: 41, tenant_id: ED_TENANT, channel_id: ED_CHANNEL, author_subject: 'user_owner', author_kind: 'human', body: 'hi', idempotency_key: 'send-x', created_at: new Date().toISOString(), metadata: null });
  const first = await postEmptyDeskAnswerIfNeeded({ pool, tenantId: ED_TENANT, channelId: ED_CHANNEL, messageId: '41', stateOn: tenantAgentStateOn });
  assert.equal(first.answered, true);
  const second = await postEmptyDeskAnswerIfNeeded({ pool, tenantId: ED_TENANT, channelId: ED_CHANNEL, messageId: '41', stateOn: tenantAgentStateOn });
  assert.equal(second.answered, false);
  assert.equal(messages.filter((m) => m.author_subject === EMPTY_DESK_SUBJECT).length, 1);
});
