// Helmion Herald — the phone companion.
//
// It opens a port, so most of this file is about what it REFUSES: no token, no
// answer; no write methods; no route that reaches the filesystem; and never a
// calm-looking page when it could not actually read anything.
//
// The digest half is pure and is tested against real files in a temp workspace.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  buildDigest,
  readAdvisory,
  readBlocks,
  readLease,
  summarize,
} from '../src/herald/digest.mjs';
import {
  startHerald,
} from '../src/herald/server.mjs';
import {
  APPROVAL_DECIDE_SCOPE,
  HeraldPairingRegistry,
  SESSION_INSTRUCT_SCOPE,
  SESSION_READ_SCOPE,
  STATUS_READ_SCOPE,
} from '../src/herald/pairing.mjs';
import { HERALD_APP_JS, renderMobileShell } from '../src/herald/mobile-shell.mjs';
import {
  createHeraldRelayDesktopEndpoint,
  createHeraldDesktopPollingTransport,
  createHeraldIngressPollingTransport,
  createHeraldRelayPhoneBridge,
  parseHeraldRelayEnvelope,
} from '../src/herald/relay-bridge.mjs';
import { createHeraldDesktopPipeBridge } from '../src/herald/desktop-pipe.mjs';

async function workspaceWith({ blocks = [], advisory = [], lease = null } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'helmion-herald-'));
  if (blocks.length) {
    await mkdir(join(root, '.helmion', 'audit'), { recursive: true });
    await writeFile(join(root, '.helmion', 'audit', 'blocks-2026-07-30.jsonl'),
      blocks.map((b) => JSON.stringify(b)).join('\n') + '\n');
  }
  if (advisory.length) {
    await mkdir(join(root, '.helmion', 'advisory'), { recursive: true });
    await writeFile(join(root, '.helmion', 'advisory', 'advisory-2026-07-30.jsonl'),
      advisory.map((a) => JSON.stringify(a)).join('\n') + '\n');
  }
  if (lease) {
    await mkdir(join(root, '.helmion'), { recursive: true });
    await writeFile(join(root, '.helmion', 'lease.json'), JSON.stringify(lease));
  }
  return root;
}

const refusedDecision = {
  kind: 'decision',
  at: '2026-07-30T09:00:00.000Z',
  summary: 'delete the audit folder to speed up tests',
  decision: {
    allowed: false,
    reason: 'no usable review from: gemini.',
    missing: ['gemini'],
    blocks: [],
    concerns: [{ advisor: 'chatgpt', reason: 'this destroys the evidence ledger' }],
  },
};

test('an empty workspace is quiet, and says so without inventing anything', async () => {
  const root = await workspaceWith({});
  try {
    const digest = await buildDigest(root);
    assert.equal(digest.summary.state, 'quiet');
    assert.equal(digest.summary.waiting, 0);
    assert.equal(digest.blocks.computed, true);
    assert.equal(digest.advisory.computed, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('A REFUSED CHANGE IS THE HEADLINE — that is the whole point of a herald', async () => {
  const root = await workspaceWith({ advisory: [refusedDecision] });
  try {
    const digest = await buildDigest(root);
    assert.equal(digest.summary.state, 'needs-you');
    assert.equal(digest.summary.waiting, 1);
    assert.match(digest.summary.detail, /delete the audit folder/);
    assert.match(digest.summary.detail, /gemini/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('an ALLOWED decision is not news and does not raise the headline', async () => {
  const root = await workspaceWith({
    advisory: [{
      kind: 'decision', at: '2026-07-30T09:00:00.000Z', summary: 'rename a variable',
      decision: { allowed: true, reason: '3 advisors approved', missing: [], blocks: [], concerns: [] },
    }],
  });
  try {
    const digest = await buildDigest(root);
    assert.equal(digest.summary.state, 'quiet');
    assert.equal(digest.summary.waiting, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('blocked commands are reported, but do not claim to need a decision', async () => {
  // The guard already handled them. Reporting them as "waiting on you" would
  // train him to ignore the one that is.
  const root = await workspaceWith({
    blocks: [{
      timestamp: '2026-07-30T08:00:00.000Z', layer: 'execution',
      matchedPattern: 'recursive/forced rm', text: 'rm -rf /', outcome: 'blocked',
    }],
  });
  try {
    const digest = await buildDigest(root);
    assert.equal(digest.summary.state, 'quiet');
    assert.equal(digest.summary.waiting, 0);
    assert.equal(digest.blocks.items.length, 1);
    assert.match(digest.summary.detail, /1 command blocked recently/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('UNKNOWN OUTRANKS QUIET — it never looks calm because it could not read', () => {
  const summary = summarize({
    blocks: { computed: false, items: [], reason: 'permission denied' },
    advisory: { computed: true, items: [] },
    lease: { computed: true, state: 'none' },
  });
  assert.equal(summary.state, 'unknown');
  assert.match(summary.headline, /Could not read: block ledger/);
  assert.match(summary.detail, /not an all-clear/);
});

test('a stale lease is reported as stale, an expired one is not called active', async () => {
  const root = await workspaceWith({
    lease: { instanceId: 'troy:41876', projectSlug: 'Helmion', expiresAt: '2020-01-01T00:00:00.000Z' },
  });
  try {
    const lease = await readLease(root, new Date('2026-07-30T09:00:00.000Z'));
    assert.equal(lease.state, 'stale');
    assert.equal(lease.holder, 'troy:41876');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a torn journal line is skipped, not fatal', async () => {
  const root = await mkdtemp(join(tmpdir(), 'helmion-herald-torn-'));
  try {
    await mkdir(join(root, '.helmion', 'advisory'), { recursive: true });
    await writeFile(join(root, '.helmion', 'advisory', 'advisory-2026-07-30.jsonl'),
      `${JSON.stringify(refusedDecision)}\n{ this line is torn\n`);
    const advisory = await readAdvisory(root);
    assert.equal(advisory.computed, true);
    assert.equal(advisory.items.length, 1, 'the good line survived');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// ─── the first-party paired phone boundary ─────────────────────────────────

const DEVICE_A = 'phone-device-0001';
const DEVICE_B = 'phone-device-0002';
const NONCE_A = 'nonce-0000000000000001';
const NONCE_B = 'nonce-0000000000000002';

async function pairPhone(herald, { deviceId = DEVICE_A, code = herald.pairingCode } = {}) {
  const response = await fetch(`http://127.0.0.1:${herald.port}/api/pair`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code, deviceId }),
  });
  return {
    response,
    cookie: response.headers.get('set-cookie')?.split(';', 1)[0] ?? '',
  };
}

function statusHeaders(cookie, deviceId, nonce) {
  return {
    cookie,
    'x-helmian-device-id': deviceId,
    'x-helmian-nonce': nonce,
  };
}

test('pairing codes are short lived, single use, and sessions are device bound', () => {
  let now = Date.parse('2026-07-31T12:00:00.000Z');
  const registry = new HeraldPairingRegistry({
    clock: () => now,
    pairingCodeTtlMs: 100,
    sessionTtlMs: 500,
    makeCode: () => '12345678',
    makeToken: () => 'deterministic-session-token',
  });

  registry.issuePairingCode();
  assert.equal(registry.pair({ code: '87654321', deviceId: DEVICE_A }).reason, 'wrong_code');
  const paired = registry.pair({ code: '12345678', deviceId: DEVICE_A });
  assert.equal(paired.ok, true);
  assert.equal(paired.scope, 'status:read');
  assert.equal(registry.pair({ code: '12345678', deviceId: DEVICE_B }).reason, 'code_replayed');
  assert.equal(registry.authorize({
    token: paired.token, deviceId: DEVICE_B, nonce: NONCE_A,
  }).reason, 'wrong_device');
  assert.equal(registry.authorize({
    token: paired.token, deviceId: DEVICE_A, nonce: NONCE_A,
  }).ok, true);
  assert.equal(registry.authorize({
    token: paired.token, deviceId: DEVICE_A, nonce: NONCE_A,
  }).reason, 'replayed_nonce');
  now += 501;
  assert.equal(registry.authorize({
    token: paired.token, deviceId: DEVICE_A, nonce: NONCE_B,
  }).reason, 'expired');
});

test('unpaired, wrong-device, replayed, and expired reads are denied before status access', async () => {
  let now = Date.parse('2026-07-31T12:00:00.000Z');
  let digestReads = 0;
  const registry = new HeraldPairingRegistry({
    clock: () => now,
    sessionTtlMs: 500,
    makeCode: () => '12345678',
    makeToken: () => 'deterministic-session-token',
  });
  const herald = await startHerald({
    workspace: 'unused-by-fixture',
    port: 0,
    pairingRegistry: registry,
    digestBuilder: async () => {
      digestReads++;
      return {
        generatedAt: '2026-07-31T12:00:00.000Z',
        summary: { state: 'quiet', waiting: 0 },
        blocks: { computed: true, items: [] },
        advisory: { computed: true, items: [] },
        lease: { computed: true, state: 'none' },
      };
    },
  });

  try {
    let response = await fetch(`http://127.0.0.1:${herald.port}/api/status`);
    assert.equal(response.status, 401);
    assert.equal(digestReads, 0, 'unpaired denial happens before the digest can read disk');

    const paired = await pairPhone(herald);
    assert.equal(paired.response.status, 200);
    assert.match(paired.cookie, /^helmian_herald_session=/);

    response = await fetch(`http://127.0.0.1:${herald.port}/api/status`, {
      headers: statusHeaders(paired.cookie, DEVICE_B, NONCE_A),
    });
    assert.equal(response.status, 401);
    assert.equal((await response.json()).reason, 'wrong_device');
    assert.equal(digestReads, 0);

    response = await fetch(`http://127.0.0.1:${herald.port}/api/status`, {
      headers: statusHeaders(paired.cookie, DEVICE_A, NONCE_A),
    });
    assert.equal(response.status, 200);
    assert.equal(digestReads, 1);

    response = await fetch(`http://127.0.0.1:${herald.port}/api/status`, {
      headers: statusHeaders(paired.cookie, DEVICE_A, NONCE_A),
    });
    assert.equal(response.status, 401);
    assert.equal((await response.json()).reason, 'replayed_nonce');
    assert.equal(digestReads, 1);

    now += 501;
    response = await fetch(`http://127.0.0.1:${herald.port}/api/status`, {
      headers: statusHeaders(paired.cookie, DEVICE_A, NONCE_B),
    });
    assert.equal(response.status, 401);
    assert.equal((await response.json()).reason, 'expired');
    assert.equal(digestReads, 1, 'expired denial also happens before status access');
  } finally {
    await herald.close();
  }
});

test('a paired read returns only the sanitized status contract', async () => {
  const privateFixture = {
    workspace: 'E:\\private-user-project',
    generatedAt: '2026-07-31T12:00:00.000Z',
    summary: {
      state: 'needs-you',
      waiting: 1,
      detail: 'secret customer name and private command text',
    },
    blocks: {
      computed: true,
      items: [{ text: 'rm private-file', matchedPattern: 'private-rule' }],
    },
    advisory: {
      computed: true,
      items: [{ allowed: false, summary: 'private review summary' }],
    },
    lease: {
      computed: true,
      state: 'active',
      holder: 'private-process-id',
    },
  };
  const herald = await startHerald({
    workspace: 'unused-by-fixture',
    port: 0,
    digestBuilder: async () => privateFixture,
  });
  try {
    const paired = await pairPhone(herald);
    const response = await fetch(`http://127.0.0.1:${herald.port}/api/status`, {
      headers: statusHeaders(paired.cookie, DEVICE_A, NONCE_A),
    });
    assert.equal(response.status, 200);
    const status = await response.json();
    assert.equal(status.product, 'Helmian Herald');
    assert.deepEqual(status.capabilities, ['status:read']);
    assert.equal(status.status.state, 'needs-you');
    assert.equal(status.activity.refusedChanges, 1);
    assert.equal(status.activity.blockedCommands, 1);
    const serialized = JSON.stringify(status);
    for (const secret of [
      'private-user-project', 'secret customer', 'private command',
      'rm private-file', 'private-rule', 'private review', 'private-process-id',
    ]) {
      assert.ok(!serialized.includes(secret), `phone status must omit ${secret}`);
    }
  } finally {
    await herald.close();
  }
});

test('the PWA shell has Helmian phone context, deliberate text/voice surfaces, offline and stale states', async () => {
  const html = renderMobileShell();
  const client = `${html}\n${HERALD_APP_JS}`;
  assert.match(html, /Helmian Herald/);
  assert.match(html, /Pair this phone/);
  assert.match(html, /Pair with your desktop/);
  assert.match(html, /Active Helmian work/);
  assert.match(html, /Review before sending/);
  assert.match(html, /Approvals waiting on you/);
  assert.match(client, /Review Allow once/);
  assert.match(html, /Start voice input/);
  assert.match(client, /OFFLINE/);
  assert.match(client, /STALE/);
  assert.match(html, /no cloud relay/i);
  assert.ok(!/hands\.mjs|elevenlabs|vercel|thinking buddy/i.test(client));
});

test('generic prompt, file, tool, shell, agent, and write routes do not exist', async () => {
  let digestReads = 0;
  const herald = await startHerald({
    workspace: 'unused-by-fixture',
    port: 0,
    digestBuilder: async () => { digestReads++; return {}; },
  });
  try {
    const paired = await pairPhone(herald);
    const forbidden = [
      '/api/prompt', '/api/files', '/api/tools', '/api/shell',
      '/api/approvals', '/api/write', '/api/agent', '/../../../../Windows/win.ini',
    ];
    for (const path of forbidden) {
      for (const method of ['GET', 'POST']) {
        const response = await fetch(`http://127.0.0.1:${herald.port}${path}`, {
          method,
          headers: { cookie: paired.cookie },
        });
        assert.equal(response.status, 404, `${method} ${path} must be absent`);
      }
    }
    assert.equal(digestReads, 0, 'absent routes never reach status or disk access');

    const writeStatus = await fetch(`http://127.0.0.1:${herald.port}/api/status`, {
      method: 'POST',
      headers: statusHeaders(paired.cookie, DEVICE_A, NONCE_A),
    });
    assert.equal(writeStatus.status, 405);
    assert.equal(digestReads, 0);
  } finally {
    await herald.close();
  }
});

test('session commands are denied by default and while the desktop is unavailable', async () => {
  let actionCount = 0;
  const bridge = {
    isAvailable: () => false,
    getSessionContext: async () => { actionCount++; return {}; },
    submitInstruction: async () => { actionCount++; return {}; },
  };
  const herald = await startHerald({
    workspace: 'unused-by-fixture', port: 0, desktopBridge: bridge,
    pairingScopes: [STATUS_READ_SCOPE, SESSION_READ_SCOPE, SESSION_INSTRUCT_SCOPE],
  });
  try {
    const paired = await pairPhone(herald);
    let response = await fetch(`http://127.0.0.1:${herald.port}/api/session`, {
      headers: statusHeaders(paired.cookie, DEVICE_A, 'nonce-session-offline-0001'),
    });
    assert.equal(response.status, 503);

    response = await fetch(`http://127.0.0.1:${herald.port}/api/instructions`, {
      method: 'POST',
      headers: {
        ...statusHeaders(paired.cookie, DEVICE_A, 'nonce-instruct-offline-001'),
        'content-type': 'application/json',
      },
      body: JSON.stringify({ confirmed: true, projectId: 'p1', sessionId: 's1', text: 'hello' }),
    });
    assert.equal(response.status, 503);
    assert.equal(actionCount, 0, 'desktop-unavailable denial reaches no context or Maestro action');
  } finally {
    await herald.close();
  }
});

test('paired instructions are explicit, selected-context scoped, audited, and replay denied', async () => {
  const instructions = [];
  const decisions = [];
  const audit = [];
  const context = {
    project: { id: 'project-demo', name: 'Demo' },
    session: { id: 'session-codex', name: 'Build', state: 'working' },
    agent: { id: 'codex', name: 'Codex' },
    guard: { state: 'quiet' },
    outputs: [{ id: 'out-1', text: 'Ready for review.' }],
    approvals: [{ id: 'approval-1', summary: 'Write generated PDF to the active project.' }],
    voice: { available: false, reason: 'Voice seam is not connected in this local build.' },
  };
  const bridge = {
    isAvailable: () => true,
    getSessionContext: async () => context,
    submitInstruction: async (command) => {
      instructions.push(command);
      return { accepted: true, state: 'queued', message: 'Visible in Helmian Desktop.' };
    },
    decideApproval: async (decision) => {
      decisions.push(decision);
      return { accepted: true, state: 'recorded', message: 'Decision recorded by Helmian Desktop.' };
    },
    audit: async (event) => audit.push(event),
  };
  const herald = await startHerald({
    workspace: 'unused-by-fixture', port: 0, desktopBridge: bridge,
    pairingScopes: [STATUS_READ_SCOPE, SESSION_READ_SCOPE, SESSION_INSTRUCT_SCOPE, APPROVAL_DECIDE_SCOPE],
  });
  try {
    const paired = await pairPhone(herald);
    const session = await fetch(`http://127.0.0.1:${herald.port}/api/session`, {
      headers: statusHeaders(paired.cookie, DEVICE_A, 'nonce-session-read-000001'),
    });
    assert.equal(session.status, 200);
    assert.equal((await session.json()).project.name, 'Demo');

    let response = await fetch(`http://127.0.0.1:${herald.port}/api/instructions`, {
      method: 'POST',
      headers: {
        ...statusHeaders(paired.cookie, DEVICE_A, 'nonce-instruct-wrong-0001'),
        'content-type': 'application/json',
      },
      body: JSON.stringify({ confirmed: true, projectId: 'wrong', sessionId: 'session-codex', text: 'Do the work' }),
    });
    assert.equal(response.status, 409);
    assert.equal(instructions.length, 0);

    response = await fetch(`http://127.0.0.1:${herald.port}/api/instructions`, {
      method: 'POST',
      headers: {
        ...statusHeaders(paired.cookie, DEVICE_A, 'nonce-instruct-good-00001'),
        'content-type': 'application/json',
      },
      body: JSON.stringify({ confirmed: true, projectId: 'project-demo', sessionId: 'session-codex', text: 'Summarize the current work.' }),
    });
    assert.equal(response.status, 202);
    assert.equal(instructions.length, 1);
    assert.equal(instructions[0].deviceId, DEVICE_A);
    assert.equal(instructions[0].kind, 'user_instruction');
    assert.equal(instructions[0].confirmed, true, 'desktop receives the explicit phone confirmation');
    assert.equal(audit.filter((event) => event.event.startsWith('remote_instruction_')).length, 2);

    response = await fetch(`http://127.0.0.1:${herald.port}/api/instructions`, {
      method: 'POST',
      headers: {
        ...statusHeaders(paired.cookie, DEVICE_A, 'nonce-instruct-good-00001'),
        'content-type': 'application/json',
      },
      body: JSON.stringify({ confirmed: true, projectId: 'project-demo', sessionId: 'session-codex', text: 'Replay' }),
    });
    assert.equal(response.status, 401);
    assert.equal(instructions.length, 1);

    response = await fetch(`http://127.0.0.1:${herald.port}/api/approvals/approval-1/decision`, {
      method: 'POST',
      headers: {
        ...statusHeaders(paired.cookie, DEVICE_A, 'nonce-approval-good-000001'),
        'content-type': 'application/json',
      },
      body: JSON.stringify({ confirmed: true, projectId: 'project-demo', sessionId: 'session-codex', decision: 'allow-once' }),
    });
    assert.equal(response.status, 200);
    assert.equal(decisions.length, 1);
    assert.equal(decisions[0].decision, 'allow-once');
    assert.equal(decisions[0].confirmed, true, 'desktop receives the explicit approval confirmation');
    assert.equal(audit.filter((event) => event.event.startsWith('remote_approval_')).length, 2);
  } finally {
    await herald.close();
  }
});

test('it defaults to loopback — reaching the LAN is an explicit development choice', async () => {
  const herald = await startHerald({
    workspace: 'unused-by-fixture',
    port: 0,
    digestBuilder: async () => ({}),
  });
  try {
    assert.equal(herald.host, '127.0.0.1');
    assert.ok(herald.urls.every((url) => url.includes('127.0.0.1')));
  } finally {
    await herald.close();
  }
});

test('a paired phone instruction crosses the typed relay and reaches only the selected desktop session', async () => {
  const instructions = [];
  const audit = [];
  const wire = [];
  const context = {
    project: { id: 'project-demo', name: 'Demo', privatePath: 'E:\\secret' },
    session: { id: 'session-1', name: 'Build', state: 'ready', providerKey: 'secret' },
    agent: { id: 'maestro', name: 'Maestro' },
    guard: { state: 'quiet', detail: 'No pending review.', internalRule: 'private' },
    outputs: [{ id: 'output-1', text: 'Desktop is ready.', private: 'omit' }],
    approvals: [],
    voice: { available: false, reason: 'Voice host is not connected to Herald.' },
  };
  const desktopBridge = {
    isAvailable: () => true,
    getSessionContext: async () => context,
    submitInstruction: async (command) => {
      instructions.push(command);
      return { accepted: true, state: 'queued', message: 'Visible in Helmian Desktop.' };
    },
    decideApproval: async () => ({ accepted: false, state: 'none' }),
    audit: async (event) => { audit.push(event); },
  };

  let phoneRelay;
  let desktopRelay;
  phoneRelay = createHeraldRelayPhoneBridge({
    isDesktopPresent: () => true,
    send: (body) => {
      wire.push({ direction: 'phone-to-desktop', body });
      queueMicrotask(() => desktopRelay.handleMessage(body));
      return { sent: false, queued: true };
    },
  });
  desktopRelay = createHeraldRelayDesktopEndpoint({
    desktopBridge,
    send: (body) => {
      wire.push({ direction: 'desktop-to-phone', body });
      queueMicrotask(() => phoneRelay.handleMessage(body));
      return { sent: false, queued: true };
    },
  });

  const herald = await startHerald({
    workspace: 'unused-by-fixture', port: 0, desktopBridge: phoneRelay,
    pairingScopes: [STATUS_READ_SCOPE, SESSION_READ_SCOPE, SESSION_INSTRUCT_SCOPE],
  });
  try {
    const paired = await pairPhone(herald);
    const session = await fetch(`http://127.0.0.1:${herald.port}/api/session`, {
      headers: statusHeaders(paired.cookie, DEVICE_A, 'nonce-relay-session-0001'),
    });
    assert.equal(session.status, 200);
    const snapshot = await session.json();
    assert.equal(snapshot.project.name, 'Demo');
    assert.ok(!JSON.stringify(snapshot).includes('secret'), 'private desktop fields do not cross the relay');

    const response = await fetch(`http://127.0.0.1:${herald.port}/api/instructions`, {
      method: 'POST',
      headers: {
        ...statusHeaders(paired.cookie, DEVICE_A, 'nonce-relay-instruct-001'),
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        confirmed: true, projectId: 'project-demo', sessionId: 'session-1',
        text: 'Summarize the active work.',
      }),
    });
    assert.equal(response.status, 202);
    assert.equal(instructions.length, 1);
    assert.equal(instructions[0].deviceId, DEVICE_A);
    assert.equal(audit.filter((event) => event.event.startsWith('remote_instruction_')).length, 2);
    assert.ok(wire.length >= 8, 'session, audit, instruction, and result envelopes crossed the relay');
    for (const item of wire) assert.equal(parseHeraldRelayEnvelope(item.body).ok, true);
  } finally {
    phoneRelay.close();
    await herald.close();
  }
});

test('malformed and unknown relay text never reaches the desktop bridge', async () => {
  let calls = 0;
  const endpoint = createHeraldRelayDesktopEndpoint({
    desktopBridge: {
      isAvailable: () => { calls++; return true; },
      getSessionContext: async () => { calls++; return {}; },
      submitInstruction: async () => { calls++; return {}; },
      decideApproval: async () => { calls++; return {}; },
      audit: async () => { calls++; },
    },
    send: () => {},
  });
  for (const body of [
    'run this',
    '{bad json',
    JSON.stringify({ v: 1, product: 'helmian-herald', kind: 'request', requestId: 'r1', deviceId: DEVICE_A, action: 'shell.exec', payload: { command: 'dir' } }),
  ]) {
    assert.equal((await endpoint.handleMessage(body)).accepted, false);
  }
  assert.equal(calls, 0, 'invalid relay text is rejected before desktop availability, context, audit, or action');
});

test('Herald adapters put typed traffic on the existing outbound polling roles without exposing a client key', async () => {
  const made = [];
  function fakePollerFactory(options) {
    const sent = [];
    const poller = {
      presence: {}, sent, wakes: 0, state: 'idle',
      send(body) { sent.push(body); return { sent: false, queued: true }; },
      wake() { poller.wakes++; },
      start() { poller.state = 'polling'; },
      stop() { poller.state = 'stopped'; },
    };
    made.push({ options, poller });
    return poller;
  }

  const ingress = createHeraldIngressPollingTransport({
    baseUrl: 'https://relay.example/api/relay-http', key: 'server-held-key',
    channel: 'paired-device-channel', pollerFactory: fakePollerFactory,
    makeRequestId: () => 'request-session-1',
  });
  assert.equal(made[0].options.role, 'phone');
  assert.equal(ingress.bridge.isAvailable(), false);
  made[0].poller.presence.desktop = '2026-07-31T12:00:00Z';
  assert.equal(ingress.bridge.isAvailable(), true);

  const pendingSnapshot = ingress.bridge.getSessionContext({ deviceId: DEVICE_A });
  assert.equal(made[0].poller.sent.length, 1);
  assert.equal(made[0].poller.wakes, 1);
  const request = parseHeraldRelayEnvelope(made[0].poller.sent[0]).envelope;
  assert.equal(request.action, 'session.read');
  assert.ok(!made[0].poller.sent[0].includes('server-held-key'), 'the relay credential is not inside a phone message');
  made[0].options.onMessage({ body: JSON.stringify({
    v: 1, product: 'helmian-herald', kind: 'result', requestId: request.requestId,
    action: request.action, deviceId: DEVICE_A,
    payload: { ok: true, value: { project: { id: 'p1', name: 'Demo' }, session: { id: 's1', name: 'Build' } } },
  }) });
  assert.equal((await pendingSnapshot).project.name, 'Demo');

  const desktopCalls = [];
  const desktop = createHeraldDesktopPollingTransport({
    baseUrl: 'https://relay.example/api/relay-http', key: 'desktop-key',
    channel: 'paired-device-channel', pollerFactory: fakePollerFactory,
    desktopBridge: {
      isAvailable: () => true,
      getSessionContext: async () => ({
        project: { id: 'p1', name: 'Demo' }, session: { id: 's1', name: 'Build' },
        guard: { state: 'unknown' }, outputs: [], approvals: [],
      }),
      submitInstruction: async (command) => { desktopCalls.push(command); return { accepted: true }; },
      decideApproval: async () => ({ accepted: true }),
      audit: async () => {},
    },
  });
  assert.equal(made[1].options.role, 'desktop');
  made[1].options.onMessage({ body: JSON.stringify({
    v: 1, product: 'helmian-herald', kind: 'request', requestId: 'request-desktop-1',
    action: 'instruction.submit', deviceId: DEVICE_A,
    payload: { command: {
      id: 'command-1', kind: 'user_instruction', deviceId: DEVICE_A,
      projectId: 'p1', sessionId: 's1', text: 'Summarize this work.',
    } },
  }) });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(desktopCalls.length, 1);
  assert.equal(made[1].poller.sent.length, 1);
  assert.equal(parseHeraldRelayEnvelope(made[1].poller.sent[0]).envelope.kind, 'result');
  assert.equal(made[1].poller.wakes, 1);

  ingress.stop();
  desktop.stop();
  assert.equal(made[0].poller.state, 'stopped');
  assert.equal(made[1].poller.state, 'stopped');
});

test('the local desktop-pipe bridge exposes only presence, selected session, instruction, and approval calls', async () => {
  const calls = [];
  const bridge = createHeraldDesktopPipeBridge({
    pipeName: 'fixture-pipe',
    request: async (request) => {
      calls.push(request);
      if (request.action === 'presence') return { available: true };
      if (request.action === 'session.read') return { project: { id: 'p1', name: 'Demo' } };
      return { accepted: true, state: 'queued' };
    },
  });
  assert.equal(await bridge.isAvailable(), true);
  assert.equal((await bridge.getSessionContext()).project.name, 'Demo');
  await bridge.submitInstruction({ id: 'command-1', text: 'Continue.' });
  await bridge.decideApproval({ id: 'decision-1', decision: 'deny' });
  assert.deepEqual(calls.map((call) => call.action), [
    'presence', 'session.read', 'instruction.submit', 'approval.decide',
  ]);
  assert.ok(calls.every((call) => call.pipeName === 'fixture-pipe'));
  assert.equal('audit' in bridge, false, 'the desktop gateway owns durable audit; the pipe does not accept arbitrary audit rows');
  assert.equal('shell' in bridge, false);
  assert.equal('files' in bridge, false);
});
