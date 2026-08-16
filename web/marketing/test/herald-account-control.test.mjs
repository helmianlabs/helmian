import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  CLERK_CONFIGURATION_STATES, createClerkAccountVerifier, readClerkConfiguration,
} from '../api/_herald-clerk.js';
import {
  controlCookie, hashEnrollmentCode, normalizeDesktopPresence,
  parseControlCookie, publicDesktopRegistry, validateEnrollmentRequest,
} from '../api/_herald-account-core.js';
import {
  createAccountIdentityResolver, requireVerifiedAccount,
} from '../api/_herald-identity.js';
import { createHeraldEnrollmentHandler } from '../api/herald-enrollment.js';
import { createHeraldDesktopHandler } from '../api/herald-desktop.js';
import { createHeraldDesktopsHandler } from '../api/herald-desktops.js';
import { createHeraldControlHandler } from '../api/herald-control.js';

const ACCOUNT = Object.freeze({
  state: 'verified', provider: 'clerk', subject: 'user_troy123', displayName: null,
});
const ACCOUNT_RESOLVER = createAccountIdentityResolver({
  verifyAccount: async () => ({ provider: 'clerk', subject: 'user_troy123' }),
});
const ENROLLMENT_ID = `enroll_${'e'.repeat(24)}`;
const PROOF_SECRET = 'p'.repeat(43);
const DESKTOP_ID = `desktop_${'d'.repeat(24)}`;
const CONTROL_ID = `control_${'c'.repeat(24)}`;
const CONTROL_TOKEN = 't'.repeat(43);
const HTTP_NONCE = 'desktop-nonce-1234567890123456';

test('Clerk configuration is explicit, complete, and origin-allowlisted', async () => {
  assert.deepEqual(readClerkConfiguration({}), {
    state: 'unconfigured', configured: false,
    publishableKey: null, authorizedParties: [],
  });
  assert.equal(readClerkConfiguration({ CLERK_PUBLISHABLE_KEY: 'pk_live_incomplete' }).state,
    CLERK_CONFIGURATION_STATES.MISCONFIGURED);
  assert.equal(readClerkConfiguration({
    CLERK_PUBLISHABLE_KEY: 'pk_live_abcdefghijk',
    CLERK_SECRET_KEY: 'sk_live_abcdefghijk',
    HELMION_HERALD_CLERK_AUTHORIZED_PARTIES: 'https://helmian.cloud/path',
  }).state, CLERK_CONFIGURATION_STATES.MISCONFIGURED);

  let verifiedRequest;
  const verifier = createClerkAccountVerifier({
    environment: {
      CLERK_PUBLISHABLE_KEY: 'pk_live_abcdefghijk',
      CLERK_SECRET_KEY: 'sk_live_abcdefghijk',
      HELMION_HERALD_CLERK_AUTHORIZED_PARTIES: 'https://helmian.cloud',
    },
    authenticateRequest: async (request) => {
      verifiedRequest = request;
      return { isAuthenticated: true, toAuth: () => ({ userId: 'user_troy123' }) };
    },
  });
  assert.equal(verifier.configured, true);
  assert.equal(verifier.secretKey, undefined);
  assert.doesNotMatch(JSON.stringify(verifier), /sk_live_/);
  assert.deepEqual(await verifier.verify({
    method: 'POST', url: '/api/herald-enrollment',
    headers: { host: 'helmian.cloud', cookie: '__session=redacted' },
  }), { provider: 'clerk', subject: 'user_troy123', displayName: null });
  assert.equal(new URL(verifiedRequest.url).origin, 'https://helmian.cloud');
});

test('account control routes never fall back to pairing identity', async () => {
  await assert.rejects(
    () => requireVerifiedAccount(createAccountIdentityResolver(), { headers: {} }),
    (error) => error.status === 503 && error.code === 'account_not_configured',
  );
  const signedOut = createAccountIdentityResolver({ verifyAccount: async () => null });
  await assert.rejects(
    () => requireVerifiedAccount(signedOut, { headers: {} }),
    (error) => error.status === 401 && error.code === 'account_denied',
  );
});

test('Desktop enrollment validates high-entropy proof and never stores its raw code', async () => {
  assert.throws(() => validateEnrollmentRequest({
    enrollmentId: ENROLLMENT_ID, proofSecret: 'short', confirmationCode: '12345678',
  }), /proof secret/i);
  const pepper = 'z'.repeat(32);
  assert.notEqual(hashEnrollmentCode('12345678', pepper), '12345678');

  let created;
  const handler = createHeraldEnrollmentHandler({
    accountResolver: ACCOUNT_RESOLVER,
    enrollmentPepper: () => pepper,
    now: () => 1_800_000_000_000,
    store: {
      create: async (value) => { created = value; },
      cleanup: async () => {},
      confirm: async () => { throw new Error('not used'); },
      redeem: async () => { throw new Error('not used'); },
    },
  });
  const response = responseFixture();
  await handler(jsonRequest({
    action: 'request', enrollmentId: ENROLLMENT_ID, proofSecret: PROOF_SECRET,
    confirmationCode: '12345678', displayName: 'Troy desktop',
  }), response);
  assert.equal(response.statusCode, 201);
  assert.equal(response.body.pending, true);
  assert.equal(created.enrollmentId, ENROLLMENT_ID);
  assert.notEqual(created.proofHash, PROOF_SECRET);
  assert.notEqual(created.confirmationCodeHash, '12345678');
  assert.doesNotMatch(JSON.stringify(created), new RegExp(PROOF_SECRET));
  assert.doesNotMatch(JSON.stringify(response.body), /12345678/);
});

test('only a verified account confirms enrollment; Desktop redeems the credential once', async () => {
  const calls = [];
  const random = (bytes) => bytes === 18 ? 'd'.repeat(24) : 'r'.repeat(43);
  const handler = createHeraldEnrollmentHandler({
    accountResolver: ACCOUNT_RESOLVER,
    enrollmentPepper: () => 'z'.repeat(32),
    now: () => 1_800_000_000_000,
    random,
    store: {
      cleanup: async () => {}, create: async () => {},
      consumeAccountNonce: async () => {},
      confirm: async (value) => {
        calls.push({ kind: 'confirm', value });
        return {
          enrollment_id: ENROLLMENT_ID, desktop_display_name: 'Troy desktop',
          expires_at: new Date(1_800_000_300_000),
        };
      },
      redeem: async (value) => {
        calls.push({ kind: 'redeem', value });
        return {
          desktop_id: value.desktopId, display_name: 'Troy desktop',
          credential_expires_at: value.credentialExpiresAt,
        };
      },
    },
  });
  const confirmed = responseFixture();
  await handler(jsonRequest({ action: 'confirm', confirmationCode: '12345678' }, {
    'x-helmian-nonce': HTTP_NONCE,
  }), confirmed);
  assert.equal(confirmed.statusCode, 200);
  assert.deepEqual(calls[0].value.account, ACCOUNT);

  const redeemed = responseFixture();
  await handler(jsonRequest({
    action: 'redeem', enrollmentId: ENROLLMENT_ID, proofSecret: PROOF_SECRET,
  }), redeemed);
  assert.equal(redeemed.statusCode, 201);
  assert.equal(redeemed.body.desktopId, DESKTOP_ID);
  assert.equal(redeemed.body.registrationToken, 'r'.repeat(43));
  assert.notEqual(calls[1].value.registrationTokenHash, redeemed.body.registrationToken);
  assert.doesNotMatch(JSON.stringify(redeemed.body), /user_troy123/);
});

test('Desktop heartbeat publishes only bounded source-backed session presence after authorization', async () => {
  const calls = [];
  const handler = createHeraldDesktopHandler({
    accountResolver: ACCOUNT_RESOLVER,
    now: () => 1_800_000_000_000,
    newChannel: () => `herald_${'h'.repeat(24)}`,
    store: {
      authorize: async (value) => {
        calls.push({ kind: 'authorize', value });
        return { credential_expires_at: new Date(1_900_000_000_000) };
      },
      upsertSession: async (value) => {
        calls.push({ kind: 'presence', value });
        return presenceRow(value);
      },
      stopSession: async () => {},
    },
  });
  const response = responseFixture();
  await handler(jsonRequest({
    action: 'heartbeat', desktopId: DESKTOP_ID,
    session: presenceFixture(),
  }, {
    authorization: `Bearer ${'r'.repeat(43)}`,
    'x-helmian-nonce': HTTP_NONCE,
  }), response);
  assert.equal(response.statusCode, 200);
  assert.equal(calls[0].kind, 'authorize');
  assert.equal(calls[1].kind, 'presence');
  assert.equal(response.body.session.project.name, 'Helmion');
  assert.doesNotMatch(JSON.stringify(response.body), /token|workspace|E:\\/i);

  let presenceWritten = false;
  const denied = createHeraldDesktopHandler({
    accountResolver: ACCOUNT_RESOLVER,
    store: {
      authorize: async () => { throw Object.assign(new Error('denied'), { status: 401, code: 'desktop_denied' }); },
      upsertSession: async () => { presenceWritten = true; }, stopSession: async () => {},
    },
  });
  const rejected = responseFixture();
  await denied(jsonRequest({
    action: 'heartbeat', desktopId: DESKTOP_ID, session: presenceFixture(),
  }, { authorization: 'Bearer invalid', 'x-helmian-nonce': HTTP_NONCE }), rejected);
  assert.equal(rejected.statusCode, 401);
  assert.equal(presenceWritten, false);

  const status = responseFixture();
  await handler(jsonRequest({ action: 'status', desktopId: DESKTOP_ID }, {
    authorization: `Bearer ${'r'.repeat(43)}`,
    'x-helmian-nonce': 'desktop-status-1234567890123456',
  }), status);
  assert.equal(status.statusCode, 200);
  assert.equal(status.body.registered, true);
  assert.equal(status.body.desktopId, DESKTOP_ID);
});

test('account list is empty until real presence exists and selection creates no live transport claim', async () => {
  const calls = [];
  const handler = createHeraldDesktopsHandler({
    accountResolver: ACCOUNT_RESOLVER,
    now: () => 1_800_000_000_000,
    newGrant: () => ({ grantId: CONTROL_ID, token: CONTROL_TOKEN }),
    store: {
      list: async (account) => { calls.push({ kind: 'list', account }); return []; },
      consumeAccountNonce: async (value) => { calls.push({ kind: 'nonce', value }); },
      createGrant: async (value) => {
        calls.push({ kind: 'select', value });
        return {
          desktop_id: value.desktopId, session_id: value.sessionId,
          expires_at: value.expiresAt,
        };
      },
      revoke: async (value) => { calls.push({ kind: 'revoke', value }); },
    },
  });
  const empty = responseFixture();
  await handler(jsonRequest(null, {}, 'GET'), empty);
  assert.deepEqual(empty.body, { desktops: [] });
  assert.deepEqual(calls[0].account, ACCOUNT);

  const selected = responseFixture();
  await handler(jsonRequest({
    action: 'select', desktopId: DESKTOP_ID, sessionId: 'session-1',
  }, { 'x-helmian-nonce': HTTP_NONCE }), selected);
  assert.equal(selected.statusCode, 201);
  assert.equal(selected.body.transport, 'unavailable');
  assert.doesNotMatch(JSON.stringify(selected.body), new RegExp(CONTROL_TOKEN));
  assert.match(selected.headers['set-cookie'], /^helmian_herald_control=/);
  assert.equal(calls[1].value.account.subject, 'user_troy123');
  assert.equal(calls[2].value.account.subject, 'user_troy123');
  assert.notEqual(calls[2].value.tokenHash, CONTROL_TOKEN);

  const revoked = responseFixture();
  await handler(jsonRequest({
    action: 'revoke', desktopId: DESKTOP_ID, confirmed: true,
  }, { 'x-helmian-nonce': 'account-revoke-1234567890123456' }), revoked);
  assert.equal(revoked.body.revoked, true);
  assert.equal(calls[4].value.account.subject, 'user_troy123');
});

test('selected session is authorized by both Clerk account and HttpOnly control grant', async () => {
  const cookie = controlCookie(CONTROL_ID, CONTROL_TOKEN, 600);
  const parsed = parseControlCookie({ headers: { cookie: cookie.split(';')[0] } });
  assert.deepEqual(parsed, { grantId: CONTROL_ID, token: CONTROL_TOKEN });
  let authorization;
  const handler = createHeraldControlHandler({
    accountResolver: ACCOUNT_RESOLVER,
    store: {
      authorize: async (value) => {
        authorization = value;
        return {
          desktop_id: DESKTOP_ID, display_name: 'Troy desktop',
          project_id: 'project-1', project_name: 'Helmion',
          session_id: 'session-1', session_name: 'Build', session_state: 'ready',
          agent_id: 'claude', agent_name: 'Claude', agent_state: 'idle',
          guard_state: 'quiet', guard_detail: 'No pending review.',
          session_last_seen_at: new Date(1_800_000_000_000),
        };
      },
      consumeAccountNonce: async () => {},
      revoke: async () => true,
    },
  });
  const response = responseFixture();
  await handler(jsonRequest(null, { cookie: cookie.split(';')[0] }, 'GET'), response);
  assert.equal(response.statusCode, 200);
  assert.equal(response.body.session.transport, 'unavailable');
  assert.equal(authorization.account.subject, 'user_troy123');
  assert.equal(authorization.token, CONTROL_TOKEN);
});

test('presence normalization and public registry cannot carry paths or credentials', () => {
  const presence = normalizeDesktopPresence(presenceFixture());
  assert.equal(presence.project.name, 'Helmion');
  assert.equal(presence.workspace, undefined);
  const registry = publicDesktopRegistry([{
    desktop_id: DESKTOP_ID, display_name: 'Troy desktop', desktop_online: true,
    desktop_last_seen_at: new Date(), credential_expires_at: new Date(),
    session_id: 'session-1', project_id: 'project-1', project_name: 'Helmion',
    session_name: 'Build', session_state: 'ready', agent_id: null,
    guard_state: 'quiet', session_last_seen_at: new Date(), token_hash: 'must-not-leak',
    workspace_path: 'E:\\private',
  }]);
  assert.equal(registry[0].sessions.length, 1);
  assert.doesNotMatch(JSON.stringify(registry), /must-not-leak|E:\\private/);
});

test('account-control migration binds every Desktop/session/grant to durable ownership', async () => {
  const sql = await readFile(new URL('../../../sql/herald-account-control.sql', import.meta.url), 'utf8');
  for (const table of [
    'herald_accounts', 'herald_desktop_enrollments', 'herald_registered_desktops',
    'herald_enrollment_confirmation_limits', 'herald_account_sessions',
    'herald_control_grants', 'herald_desktop_nonces', 'herald_account_nonces',
  ]) assert.match(sql, new RegExp(`create table if not exists ${table}`));
  assert.match(sql, /credential_hash text not null/);
  assert.match(sql, /foreign key \(account_provider, account_subject\)/);
  assert.match(sql, /revoked_at timestamptz/);
  assert.doesNotMatch(sql, /provider_key|workspace_path|instruction_text/i);
});

test('versioned Remote Control routes are aliases of one canonical implementation', async () => {
  const aliases = await Promise.all([
    import('../api/remote/v1/enrollment.js'),
    import('../api/remote/v1/desktop.js'),
    import('../api/remote/v1/desktops.js'),
    import('../api/remote/v1/control.js'),
    import('../api/remote/v1/control-token.js'),
    import('../api/remote/v1/desktop-token.js'),
  ]);
  assert.ok(aliases.every((value) => typeof value.default === 'function'));
  const contract = await readFile(new URL('../../../docs/herald/REMOTE_CONTROL_V1.md', import.meta.url), 'utf8');
  for (const route of [
    '/api/remote/v1/enrollment', '/api/remote/v1/desktop',
    '/api/remote/v1/desktops', '/api/remote/v1/control',
    '/api/remote/v1/control-token', '/api/remote/v1/desktop-token',
  ]) assert.match(contract, new RegExp(route.replaceAll('/', '\\/')));
  assert.match(contract, /401 desktop_denied/);
  assert.match(contract, /must immediately stop publishing\s+presence/);
});

function presenceFixture() {
  return {
    sessionId: 'session-1', sessionName: 'Build', state: 'ready',
    project: { id: 'project-1', name: 'Helmion' },
    agent: { id: 'claude', name: 'Claude', state: 'idle' },
    guard: { state: 'quiet', detail: 'No pending review.' },
    workspace: 'E:\\must-not-cross', providerKey: 'must-not-cross',
  };
}

function presenceRow(value) {
  return {
    desktop_id: value.desktopId, session_id: value.presence.sessionId,
    project_id: value.presence.project.id, project_name: value.presence.project.name,
    session_name: value.presence.sessionName, session_state: value.presence.state,
    agent_id: value.presence.agent.id, agent_name: value.presence.agent.name,
    agent_state: value.presence.agent.state, guard_state: value.presence.guard.state,
    guard_detail: value.presence.guard.detail, last_seen_at: new Date(1_800_000_000_000),
    expires_at: value.expiresAt,
  };
}

function jsonRequest(body, headers = {}, method = 'POST') {
  const input = body == null ? [] : [Buffer.from(JSON.stringify(body))];
  const request = Readable.from(input);
  request.method = method;
  request.url = '/api/test';
  request.headers = { host: 'helmian.cloud', ...headers };
  return request;
}

function responseFixture() {
  return {
    statusCode: 0, headers: {}, body: null,
    setHeader(name, value) { this.headers[name.toLowerCase()] = value; },
    end(value) { this.body = JSON.parse(value); },
  };
}
