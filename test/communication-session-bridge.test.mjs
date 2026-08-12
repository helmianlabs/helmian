import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CONNECTOR_SESSION_MARKER,
  createConnectorSessionBridge,
  mintConnectorSession,
  toHelmianTenantContext,
  verifyConnectorSession,
} from '../src/cloud/communication-session-bridge.mjs';

const SECRET = 'connector-test-secret-012345678901234567890';
const NOW = new Date('2026-08-12T12:00:00.000Z');
const binding = Object.freeze({
  provider: 'discord', eventId: 'evt-1', externalUserId: 'discord-user-1',
  channelId: 'channel-1', subject: 'subject-1', tenantId: 'tenant-a', role: 'admin',
  sessionIssuer: 'signed-session-required', attributes: { department: 'dispatch' },
});

test('connector sessions are signed, bounded, and carry no raw provider secret', () => {
  const issued = mintConnectorSession(binding, { secret: SECRET, now: NOW, sessionId: 's-1', receiptId: 'r-1' });
  assert.ok(issued.token.startsWith(CONNECTOR_SESSION_MARKER));
  assert.equal(issued.context.tenantId, 'tenant-a');
  assert.equal(issued.context.provider, 'discord');
  assert.equal(issued.context.attributes.department, 'dispatch');
  assert.equal(verifyConnectorSession(issued.token, { secret: SECRET, now: NOW }).ok, true);
  assert.equal(issued.token.includes(SECRET), false);
});

test('verified connector context maps to the existing tenant transaction context', () => {
  const issued = mintConnectorSession(binding, { secret: SECRET, now: NOW, sessionId: 's-context', receiptId: 'r-context' });
  const result = verifyConnectorSession(issued.token, { secret: SECRET, now: NOW });
  const context = toHelmianTenantContext(result.context, { requestId: 'request-context' });
  assert.deepEqual(context, {
    tenantId: 'tenant-a', actorSubject: 'subject-1', actorRole: 'admin',
    sessionId: 's-context', requestId: 'request-context',
  });
});

test('tampering, wrong secret, future, and expired tokens fail closed', () => {
  const issued = mintConnectorSession(binding, { secret: SECRET, now: NOW, lifetimeSeconds: 60, sessionId: 's-2', receiptId: 'r-2' });
  const altered = `${issued.token.slice(0, -1)}${issued.token.endsWith('a') ? 'b' : 'a'}`;
  assert.equal(verifyConnectorSession(altered, { secret: SECRET, now: NOW }).ok, false);
  assert.equal(verifyConnectorSession(issued.token, { secret: 'wrong-secret-012345678901234567890123' , now: NOW }).ok, false);
  assert.equal(verifyConnectorSession(issued.token, { secret: SECRET, now: new Date('2026-08-12T12:02:00Z'), clockSkewSeconds: 0 }).reason, 'connector session has expired');
  const future = mintConnectorSession(binding, { secret: SECRET, now: new Date('2026-08-12T13:00:00Z'), sessionId: 's-3', receiptId: 'r-3' });
  assert.match(verifyConnectorSession(future.token, { secret: SECRET, now: NOW }).reason, /not valid yet/);
});

test('bridge requires policy, audit, and a bounded runtime adapter', () => {
  assert.throws(() => createConnectorSessionBridge({ secret: SECRET }), /policyResolver/);
  assert.throws(() => createConnectorSessionBridge({ secret: SECRET, policyResolver: async () => ({}) }), /auditSink/);
  assert.throws(() => createConnectorSessionBridge({ secret: SECRET, policyResolver: async () => ({}) , auditSink: async () => {} }), /runtimeFactory/);
});

test('open and turn refresh policy, audit both outcomes, and run exactly once', async () => {
  const audit = [];
  const policies = [];
  const runs = [];
  const bridge = createConnectorSessionBridge({
    secret: SECRET,
    now: () => NOW,
    policyResolver: async (context) => {
      policies.push(context);
      return { allowed: true, enabledActions: ['board.summary'] };
    },
    auditSink: async (event) => { audit.push(event); },
    runtimeFactory: async ({ context, policy, bounded }) => ({
      async runTurn(input) {
        runs.push({ context, policy, bounded, text: input.text });
        return { answer: `ok:${input.text}` };
      },
    }),
  });
  const opened = await bridge.open({ binding, connectionId: 'conn-1', sessionId: 's-4', receiptId: 'r-4' });
  const result = await bridge.turn({ token: opened.token, connectionId: 'conn-1', eventId: 'evt-turn-1', text: 'status?' });
  assert.deepEqual(result, { answer: 'ok:status?' });
  assert.equal(policies.length, 2, 'policy is checked at open and turn');
  assert.equal(runs.length, 1);
  assert.equal(runs[0].bounded, true);
  assert.equal(audit.map((event) => event.event).join(','), 'connector_session_opened,connector_turn_started,connector_turn_completed');
  assert.equal('token' in audit[0], false);
  await assert.rejects(() => bridge.turn({ token: opened.token, connectionId: 'conn-1', eventId: 'evt-turn-1', text: 'replay' }), /already processed/);
});

test('bridge refuses a different connection, policy denial, and invalid runtime', async () => {
  const bridge = createConnectorSessionBridge({
    secret: SECRET,
    now: () => NOW,
    policyResolver: async () => ({ allowed: true }),
    auditSink: async () => {},
    runtimeFactory: async () => ({ runTurn: async () => 'ok' }),
  });
  const opened = await bridge.open({ binding, connectionId: 'conn-1', sessionId: 's-5', receiptId: 'r-5' });
  await assert.rejects(() => bridge.turn({ token: opened.token, connectionId: 'conn-2', eventId: 'evt-2', text: 'hello' }), /another connection/);

  const denied = createConnectorSessionBridge({
    secret: SECRET, now: () => NOW,
    policyResolver: async () => ({ allowed: false }), auditSink: async () => {}, runtimeFactory: async () => ({ runTurn: async () => 'no' }),
  });
  await assert.rejects(() => denied.open({ binding, connectionId: 'conn-1' }), /policy denied/);

  const invalid = createConnectorSessionBridge({
    secret: SECRET, now: () => NOW,
    policyResolver: async () => ({ allowed: true }), auditSink: async () => {}, runtimeFactory: async () => ({}),
  });
  const invalidOpen = await invalid.open({ binding, connectionId: 'conn-1' });
  await assert.rejects(() => invalid.turn({ token: invalidOpen.token, connectionId: 'conn-1', eventId: 'evt-3', text: 'hello' }), /runtime adapter/);
});

test('audit failure fails closed before a runtime turn can run', async () => {
  let runs = 0;
  const bridge = createConnectorSessionBridge({
    secret: SECRET, now: () => NOW,
    policyResolver: async () => ({ allowed: true }),
    auditSink: async (event) => event.event === 'connector_session_opened',
    runtimeFactory: async () => ({ runTurn: async () => { runs += 1; return 'bad'; } }),
  });
  const opened = await bridge.open({ binding, connectionId: 'conn-1' });
  await assert.rejects(() => bridge.turn({ token: opened.token, connectionId: 'conn-1', eventId: 'evt-4', text: 'hello' }), /audit sink refused/);
  assert.equal(runs, 0);
});
