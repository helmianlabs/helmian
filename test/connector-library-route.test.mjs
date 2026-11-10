// Connector library — SPEC §1.1/§3.4, build bite 3: the read routes'
// scoping. The delegate is exercised with a fake actor and a fake
// read that records its arguments and serves per-person data:
//
//   - the tenant comes from the actor's membership and the person
//     from the actor's subject — never from the request: a request
//     naming another tenant or another person is refused (400), and
//     even an unrefused read is always called with the actor's own
//     tenant + subject;
//   - one person's library never answers another person: the reads
//     the route returns are exactly the reads the fake was called
//     with the caller's identity for;
//   - the seats read returns only seats that hold entries, with the
//     caller's connected counts;
//   - non-GET is 405, a missing seat is 400, a membership failure is
//     403, and other paths are not the route's (it returns false).

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CONNECTOR_LIBRARY_PATH,
  CONNECTOR_LIBRARY_SEATS_PATH,
  handleConnectorLibraryRoute,
} from '../src/cloud/connector-library-read-route.mjs';

class TenantAuthorizationError extends Error {}

const ACTOR = { subject: 'user:troy', tenantId: 'tenant-a', role: 'owner' };

// A fake Bite 2 read: records every call, and serves rows whose
// content depends on WHO is asking — so a scoping leak shows up as
// the wrong person's rows in the response, not just a wrong argument.
function fakeRead() {
  const calls = [];
  return {
    calls,
    async readSeatLibrary(tenantId, { personId, seatId }) {
      calls.push({ tenantId, personId, seatId });
      if (seatId === 'claude') {
        const rows = personId === 'user:troy'
          ? [{ entryId: 'helmian-github', seatId, name: 'GitHub', state: 'connected', accountIdentity: 'helmianlabs' }]
          : [{ entryId: 'helmian-github', seatId, name: 'GitHub', state: 'not-connected', accountIdentity: null }];
        return { seatId, personId, connectedCount: personId === 'user:troy' ? 1 : 0, rows };
      }
      return { seatId, personId, connectedCount: 0, rows: [] };
    },
  };
}

function throwingRead(error) {
  return {
    calls: [],
    async readSeatLibrary() { throw error; },
  };
}

function harness({ actor = ACTOR, read = fakeRead(), actorError = null } = {}) {
  const sent = [];
  return {
    read,
    sent,
    async run(path, { method = 'GET' } = {}) {
      const requestUrl = new URL(path, 'http://local');
      const handled = await handleConnectorLibraryRoute({
        request: { method },
        response: {},
        requestUrl,
        activeTenantActor: async () => { if (actorError) throw actorError; return actor; },
        send: (response, status, body) => { sent.push({ status, body: JSON.parse(body) }); },
        TenantAuthorizationError,
        read,
      });
      return handled;
    },
  };
}

test('library read: scoped to the actor\'s tenant and subject', async () => {
  const h = harness();
  const handled = await h.run(`${CONNECTOR_LIBRARY_PATH}?seat=claude`);
  assert.equal(handled, true);
  assert.equal(h.sent[0].status, 200);
  assert.equal(h.sent[0].body.valid, true);
  assert.equal(h.sent[0].body.connectedCount, 1);
  assert.equal(h.sent[0].body.rows[0].accountIdentity, 'helmianlabs');
  // The read was called with the actor's identity — and the response
  // does not hand the person id back to the client.
  assert.deepEqual(h.read.calls, [{ tenantId: 'tenant-a', personId: 'user:troy', seatId: 'claude' }]);
  assert.equal('personId' in h.sent[0].body, false);
});

test('library read: another actor gets their own library, never Troy\'s', async () => {
  const h = harness({ actor: { subject: 'user:someone-else', tenantId: 'tenant-a', role: 'member' } });
  await h.run(`${CONNECTOR_LIBRARY_PATH}?seat=claude`);
  assert.equal(h.sent[0].body.connectedCount, 0);
  assert.equal(h.sent[0].body.rows[0].state, 'not-connected');
  assert.deepEqual(h.read.calls, [{ tenantId: 'tenant-a', personId: 'user:someone-else', seatId: 'claude' }]);
});

test('authority selectors are refused, tenant and person alike', async () => {
  for (const path of [
    `${CONNECTOR_LIBRARY_PATH}?seat=claude&tenant_id=tenant-b`,
    `${CONNECTOR_LIBRARY_PATH}?seat=claude&personId=user:someone-else`,
    `${CONNECTOR_LIBRARY_PATH}?seat=claude&person_id=user:someone-else`,
    `${CONNECTOR_LIBRARY_SEATS_PATH}?subject=user:someone-else`,
  ]) {
    const h = harness();
    await h.run(path);
    assert.equal(h.sent[0].status, 400, path);
    assert.equal(h.sent[0].body.code, 'CONNECTOR_LIBRARY_SELECTOR_INVALID');
    // A refused request never reaches the read at all.
    assert.deepEqual(h.read.calls, []);
  }
});

test('seats read: only seats holding entries, with the caller\'s counts', async () => {
  const h = harness();
  await h.run(CONNECTOR_LIBRARY_SEATS_PATH);
  assert.equal(h.sent[0].status, 200);
  assert.deepEqual(h.sent[0].body.seats, [{ seatId: 'claude', connectedCount: 1, entryCount: 1 }]);
  // Every read behind it was scoped to the actor.
  assert.ok(h.read.calls.length > 1);
  assert.ok(h.read.calls.every((c) => c.tenantId === 'tenant-a' && c.personId === 'user:troy'));
});

test('route shape: method, seat, membership, and foreign paths', async () => {
  const post = harness();
  await post.run(CONNECTOR_LIBRARY_PATH, { method: 'POST' });
  assert.equal(post.sent[0].status, 405);

  const noSeat = harness();
  await noSeat.run(CONNECTOR_LIBRARY_PATH);
  assert.equal(noSeat.sent[0].status, 400);
  assert.equal(noSeat.sent[0].body.code, 'CONNECTOR_LIBRARY_SEAT_REQUIRED');

  const denied = harness({ actorError: Object.assign(new Error('membership required'), { status: 403 }) });
  await denied.run(`${CONNECTOR_LIBRARY_PATH}?seat=claude`);
  assert.equal(denied.sent[0].status, 403);
  assert.equal(denied.sent[0].body.code, 'CONNECTOR_LIBRARY_MEMBERSHIP_REQUIRED');

  const foreign = harness();
  const handled = await foreign.run('/api/admin/tool-connections');
  assert.equal(handled, false);
  assert.deepEqual(foreign.sent, []);
});

// Membership mapping scope (2026-11-10): the membership code is a
// statement about the CALLER, so it may only answer an actor-leg
// refusal. The 2026-11-10 owner walk painted
// CONNECTOR_LIBRARY_MEMBERSHIP_REQUIRED to the workspace OWNER —
// the actor leg had not refused him; an authorization-flavoured
// error from inside the read was re-labelled by the shared catch.
// These tests pin the split: actor leg → membership; read leg →
// the read mapping, whatever flavour the read's error carries.
test('membership: an actor-leg TenantAuthorizationError is 403 membership', async () => {
  const denied = harness({ actorError: new TenantAuthorizationError('tenant membership is not active') });
  await denied.run(`${CONNECTOR_LIBRARY_PATH}?seat=claude`);
  assert.equal(denied.sent[0].status, 403);
  assert.equal(denied.sent[0].body.code, 'CONNECTOR_LIBRARY_MEMBERSHIP_REQUIRED');
});

test('membership: a TenantAuthorizationError from inside the read is NOT re-labelled membership', async () => {
  const h = harness({ read: throwingRead(new TenantAuthorizationError('tenant membership is not active')) });
  await h.run(`${CONNECTOR_LIBRARY_PATH}?seat=claude`);
  assert.equal(h.sent[0].status, 503);
  assert.equal(h.sent[0].body.code, 'CONNECTOR_LIBRARY_READ_FAILED');
});

test('membership: a bare 403 from inside the read is NOT re-labelled membership', async () => {
  const h = harness({ read: throwingRead(Object.assign(new Error('forbidden downstream'), { status: 403 })) });
  await h.run(`${CONNECTOR_LIBRARY_PATH}?seat=claude`);
  assert.equal(h.sent[0].status, 503);
  assert.equal(h.sent[0].body.code, 'CONNECTOR_LIBRARY_READ_FAILED');
});

test('read errors carrying their own status and code pass through with their words', async () => {
  const h = harness({ read: throwingRead(Object.assign(new Error('upstream refused'), { status: 502, code: 'CONNECTOR_GITHUB_UPSTREAM' })) });
  await h.run(`${CONNECTOR_LIBRARY_PATH}?seat=claude`);
  assert.equal(h.sent[0].status, 502);
  assert.equal(h.sent[0].body.code, 'CONNECTOR_GITHUB_UPSTREAM');
  assert.equal(h.sent[0].body.error, 'upstream refused');
});
