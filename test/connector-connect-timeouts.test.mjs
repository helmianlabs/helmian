// Connect-start fetch bounds (2026-11-10 defect fix) — the panel
// defect: clicking Connect on the registration-held entries
// (GitHub, Slack, Asana, HubSpot, Gmail, Google Calendar, Google
// Drive, Canva, Dropbox) and on Gamma produced NO redirect, NO
// form and NO message. The start roads fetched provider metadata
// with no timeout in front of the answer:
//
//   · the fixed-provider class falls to the consent boundary
//     (connector-library-write-route.mjs consentBoundary), whose
//     two sequential metadata fetches were unbounded — and whose
//     answer, the plain note naming the provider and the
//     unplaced registration, never depended on them;
//   · the DCR class discovers the authorization server through
//     fetchJson (connector-oauth-dcr.mjs) — up to four sequential
//     fetches, also unbounded.
//
// A stalled provider endpoint therefore held the click's answer
// hostage indefinitely. These tests pin the bounds with a fetch
// that NEVER answers on its own and settles only when its abort
// signal fires — so a pass is proof the signal is wired, not
// that a fast stub happened to return. On the pre-fix code
// consentBoundary is not exported (the file fails outright) and
// the discovery call carries no signal (its test times out).

import test from 'node:test';
import assert from 'node:assert/strict';

import { consentBoundary, CONSENT_BOUNDARY_FETCH_BUDGET_MS } from '../src/cloud/connector-library-write-route.mjs';
import { discoverAuthorizationServer, ConnectorOAuthDcrError, DCR_DISCOVERY_BUDGET_MS } from '../src/cloud/connector-oauth-dcr.mjs';

// A fetch that hangs forever unless its abort signal fires.
const hangingFetch = (url, init = {}) => new Promise((resolve, reject) => {
  const signal = init?.signal;
  if (!signal) return; // never settles — the pre-fix shape
  if (signal.aborted) { reject(signal.reason ?? new Error('The operation was aborted')); return; }
  signal.addEventListener('abort', () => reject(signal.reason ?? new Error('The operation was aborted')), { once: true });
});

const githubEntry = {
  seatId: 'claude', id: 'github', kind: 'catalog', brokerMode: 'helmian',
  authMode: 'oauth', mcpEndpointUrl: 'https://api.githubcopilot.com/mcp/',
};

test('consent boundary: a stalled provider endpoint cannot hold the answer hostage', { timeout: 30_000 }, async () => {
  const started = Date.now();
  const answer = await consentBoundary(githubEntry, hangingFetch);
  const elapsed = Date.now() - started;
  assert.ok(elapsed < CONSENT_BOUNDARY_FETCH_BUDGET_MS + 2_000, `the boundary answered inside its budget (took ${elapsed}ms)`);
  assert.equal(answer.status, 'consent-boundary');
  assert.equal(answer.authorizationEndpoint, null, 'nothing was read, so no endpoint is claimed');
  assert.match(answer.note, /GitHub/, 'the note still names the provider');
  assert.match(answer.note, /has not been placed yet/, 'the note still names the true blocker in plain words');
});

test('consent boundary: a readable provider still names its consent endpoint (behaviour preserved)', async () => {
  const fetchImpl = async (url) => {
    if (String(url).includes('oauth-protected-resource')) {
      return { ok: true, json: async () => ({ authorization_servers: ['https://auth.example.com'] }) };
    }
    if (String(url).includes('oauth-authorization-server')) {
      return { ok: true, json: async () => ({ authorization_endpoint: 'https://auth.example.com/authorize' }) };
    }
    throw new Error(`unexpected fetch: ${url}`);
  };
  const answer = await consentBoundary(githubEntry, fetchImpl);
  assert.equal(answer.status, 'consent-boundary');
  assert.equal(answer.authorizationEndpoint, 'https://auth.example.com/authorize', 'the metadata the lookup exists for still lands');
  assert.match(answer.note, /GitHub/);
});

test('DCR discovery: a stalled metadata endpoint fails as the named network-failure, in bounded time', { timeout: 30_000 }, async () => {
  const started = Date.now();
  await assert.rejects(
    () => discoverAuthorizationServer('https://mcp.example.com/mcp', { fetchImpl: hangingFetch }),
    (error) => {
      assert.ok(error instanceof ConnectorOAuthDcrError, 'the failure is the road’s named error');
      assert.equal(error.code, 'network-failure');
      return true;
    },
  );
  const elapsed = Date.now() - started;
  assert.ok(elapsed < DCR_DISCOVERY_BUDGET_MS + 4_000, `discovery failed inside its budget (took ${elapsed}ms)`);
});
