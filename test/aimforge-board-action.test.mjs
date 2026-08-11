import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import test from 'node:test';
import {
  AIMFORGE_BOARD_SUMMARY_PATH,
  AIMFORGE_BOARD_TOOL_NAME,
  AIMFORGE_PREPARE_DRIVER_MESSAGE_PATH,
  AIMFORGE_PREPARE_DRIVER_MESSAGE_TOOL_NAME,
  createAimForgeBoardActionClient,
  createAimForgeBoardToolRuntime,
} from '../src/cora/aimforge-board-action.mjs';

const ACTION_SECRET = 'action-secret-for-tests-that-is-at-least-32-bytes';
const SIGNED_BRIDGE = 'helmion:payload.signature';
const NOW = new Date('2026-08-11T17:00:00.000Z');
const NONCE = 'nonce-helmian-board-0001';

function okResponse(summary = {}) {
  return new Response(JSON.stringify({
    version: '1',
    action: 'dispatch.board.summary',
    summary: {
      date: '2026-08-11',
      totalLoads: 5,
      assignedLoads: 3,
      unassignedLoads: 2,
      driversOnShift: 4,
      driversLowHos: 1,
      ...summary,
    },
  }), {
    status: 200,
    headers: { 'x-aimforge-action-receipt': 'a'.repeat(32) },
  });
}

function proposalResponse(overrides = {}, status = 201) {
  return new Response(JSON.stringify({
    version: '1',
    action: 'driver.message.prepare',
    state: 'pending_approval',
    proposalId: 'a30aa22b-5740-4966-8d62-394cb53ba6fa',
    recipientMasked: '(***) ***-0198',
    duplicate: status === 202,
    ...overrides,
  }), {
    status,
    headers: { 'x-aimforge-action-receipt': 'b'.repeat(32) },
  });
}

test('fixed board client signs the canonical request and returns bounded aggregates only', async () => {
  let captured;
  const client = createAimForgeBoardActionClient({
    baseUrl: 'https://aimforge-api.fly.dev',
    actionSecret: ACTION_SECRET,
    now: () => NOW,
    nonce: () => NONCE,
    fetchImpl: async (url, init) => {
      captured = { url: String(url), init };
      return okResponse();
    },
  });
  const result = await client.getDispatchBoardSummary({
    signedBridge: SIGNED_BRIDGE,
    date: '2026-08-11',
  });

  assert.equal(captured.url, `https://aimforge-api.fly.dev${AIMFORGE_BOARD_SUMMARY_PATH}`);
  assert.equal(captured.init.method, 'POST');
  assert.equal(captured.init.body, JSON.stringify({
    custom_session_id: SIGNED_BRIDGE,
    date: '2026-08-11',
  }));
  const digestHex = createHash('sha256').update(captured.init.body).digest('hex');
  const canonical = [
    'v1', 'POST', AIMFORGE_BOARD_SUMMARY_PATH,
    String(Math.floor(NOW.getTime() / 1_000)), NONCE, digestHex,
  ].join('\n');
  const expected = createHmac('sha256', ACTION_SECRET).update(canonical).digest('base64url');
  assert.equal(captured.init.headers['x-helmian-signature'], expected);
  assert.deepEqual(result, {
    date: '2026-08-11', totalLoads: 5, assignedLoads: 3, unassignedLoads: 2,
    driversOnShift: 4, driversLowHos: 1,
  });
  assert.equal(JSON.stringify(result).includes('receipt'), false);
  assert.equal(JSON.stringify(result).includes('tenant'), false);
});

test('client refuses non-origin/generic HTTP configuration and unbounded response fields', async () => {
  for (const baseUrl of [
    'http://aimforge-api.fly.dev',
    'https://aimforge-api.fly.dev/anything',
    'https://user:pass@aimforge-api.fly.dev',
    'https://dairyforge-api.fly.dev',
    'https://aimforge-console.vercel.app',
  ]) {
    assert.throws(() => createAimForgeBoardActionClient({
      baseUrl, actionSecret: ACTION_SECRET,
    }), /HTTPS origin/u);
  }
  const client = createAimForgeBoardActionClient({
    baseUrl: 'https://aimforge-api.fly.dev', actionSecret: ACTION_SECRET,
    now: () => NOW, nonce: () => NONCE,
    fetchImpl: async () => okResponse({ driverName: 'must-not-cross' }),
  });
  await assert.rejects(
    client.getDispatchBoardSummary({ signedBridge: SIGNED_BRIDGE }),
    /projection was not bounded/u,
  );
});

test('prepare client signs only the fixed proposal path and returns pending approval, never sent', async () => {
  let captured;
  const client = createAimForgeBoardActionClient({
    baseUrl: 'https://aimforge-api.fly.dev', actionSecret: ACTION_SECRET,
    now: () => NOW, nonce: () => NONCE,
    fetchImpl: async (url, init) => {
      captured = { url: String(url), init };
      return proposalResponse();
    },
  });
  const result = await client.prepareDriverMessage({
    signedBridge: SIGNED_BRIDGE,
    subject: 'Dock changed',
    body: 'Use door six.',
    priority: 'urgent',
  });
  assert.equal(captured.url, `https://aimforge-api.fly.dev${AIMFORGE_PREPARE_DRIVER_MESSAGE_PATH}`);
  assert.equal(captured.init.body, JSON.stringify({
    custom_session_id: SIGNED_BRIDGE,
    subject: 'Dock changed',
    body: 'Use door six.',
    priority: 'urgent',
  }));
  const digest = createHash('sha256').update(captured.init.body).digest('hex');
  const canonical = ['v1', 'POST', AIMFORGE_PREPARE_DRIVER_MESSAGE_PATH,
    String(Math.floor(NOW.getTime() / 1_000)), NONCE, digest].join('\n');
  assert.equal(
    captured.init.headers['x-helmian-signature'],
    createHmac('sha256', ACTION_SECRET).update(canonical).digest('base64url'),
  );
  assert.deepEqual(result, {
    state: 'pending_approval',
    proposalId: 'a30aa22b-5740-4966-8d62-394cb53ba6fa',
    recipientMasked: '(***) ***-0198',
    duplicate: false,
  });
  assert.equal(JSON.stringify(result).includes('sent'), false);
});

test('prepare client rejects forged scope fields and unbounded or send-like responses', async () => {
  const client = createAimForgeBoardActionClient({
    baseUrl: 'https://aimforge-api.fly.dev', actionSecret: ACTION_SECRET,
    now: () => NOW, nonce: () => NONCE,
    fetchImpl: async () => proposalResponse({ providerMessageId: 'SMsecret', state: 'accepted' }),
  });
  await assert.rejects(client.prepareDriverMessage({
    signedBridge: SIGNED_BRIDGE, subject: 'x', body: 'y',
    priority: 'normal', tenantId: 'forged', recipientDriverId: 'forged',
  }), /invalid pending-approval proposal/u);
});

test('client forbids redirects before a signed bridge can leave the fixed origin', async () => {
  let redirectMode;
  const client = createAimForgeBoardActionClient({
    baseUrl: 'https://aimforge-api.fly.dev', actionSecret: ACTION_SECRET,
    now: () => NOW, nonce: () => NONCE,
    fetchImpl: async (_url, init) => {
      redirectMode = init.redirect;
      return new Response(null, {
        status: 307,
        headers: { location: 'https://attacker.example/collect' },
      });
    },
  });
  await assert.rejects(
    client.getDispatchBoardSummary({ signedBridge: SIGNED_BRIDGE }),
    /redirect was refused/u,
  );
  assert.equal(redirectMode, 'error');
});

test('client cancels an oversized streamed response before buffering it', async () => {
  let cancelled = false;
  const body = new ReadableStream({
    pull(controller) {
      controller.enqueue(new Uint8Array(9_000));
    },
    cancel() { cancelled = true; },
  });
  const client = createAimForgeBoardActionClient({
    baseUrl: 'https://aimforge-api.fly.dev', actionSecret: ACTION_SECRET,
    now: () => NOW, nonce: () => NONCE,
    fetchImpl: async () => new Response(body, {
      status: 200,
      headers: { 'x-aimforge-action-receipt': 'a'.repeat(32) },
    }),
  });
  await assert.rejects(
    client.getDispatchBoardSummary({ signedBridge: SIGNED_BRIDGE }),
    /exceeded its size limit/u,
  );
  assert.equal(cancelled, true);
});

test('turn cancellation reaches the fixed AimForge fetch', async () => {
  const controller = new AbortController();
  let fetchSignal;
  const client = createAimForgeBoardActionClient({
    baseUrl: 'https://aimforge-api.fly.dev', actionSecret: ACTION_SECRET,
    now: () => NOW, nonce: () => NONCE,
    fetchImpl: async (_url, init) => {
      fetchSignal = init.signal;
      return new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true });
      });
    },
  });
  const pending = client.getDispatchBoardSummary({
    signedBridge: SIGNED_BRIDGE,
    signal: controller.signal,
  });
  controller.abort(new Error('driver stopped Cora'));
  await assert.rejects(pending, /driver stopped Cora/u);
  assert.equal(fetchSignal.aborted, true);
});

test('signed AimForge runtime advertises exactly board-read plus prepare-only and no approval tool', async () => {
  const calls = [];
  const runtime = createAimForgeBoardToolRuntime({
    signedBridge: SIGNED_BRIDGE,
    workspace: 'C:/signed-aimforge-provenance',
    client: {
      async getDispatchBoardSummary(input) {
        calls.push(input);
        return { date: '2026-08-11', totalLoads: 1, assignedLoads: 0, unassignedLoads: 1, driversOnShift: 2, driversLowHos: 0 };
      },
      async prepareDriverMessage(input) {
        calls.push(input);
        return { state: 'pending_approval', proposalId: 'a30aa22b-5740-4966-8d62-394cb53ba6fa', recipientMasked: '(***) ***-0198', duplicate: false };
      },
    },
  });
  assert.deepEqual(Object.keys(runtime.tools), [AIMFORGE_BOARD_TOOL_NAME, AIMFORGE_PREPARE_DRIVER_MESSAGE_TOOL_NAME]);
  assert.equal(runtime.root, 'C:/signed-aimforge-provenance');
  assert.deepEqual(runtime.definitionsForOpenAi().map((item) => item.function.name), [AIMFORGE_BOARD_TOOL_NAME, AIMFORGE_PREPARE_DRIVER_MESSAGE_TOOL_NAME]);
  assert.match(await runtime.execute('run_command', { command: 'curl anywhere' }), /unknown tool/u);
  assert.match(await runtime.execute('aimforge_approve_driver_message', { proposalId: 'forged' }), /unknown tool/u);
  assert.match(await runtime.execute(AIMFORGE_PREPARE_DRIVER_MESSAGE_TOOL_NAME, {
    assignmentId: 41, subject: 'Dock changed', body: 'Use door six.', priority: 'normal',
    tenantId: 'forged-tenant', recipientDriverId: 'forged-driver', approved: true,
  }), /Only subject, body, and priority are allowed/u);
  assert.equal(calls.length, 0);
  const result = JSON.parse(await runtime.execute(AIMFORGE_BOARD_TOOL_NAME, { date: '2026-08-11' }));
  assert.equal(result.totalLoads, 1);
  assert.equal(calls[0].signedBridge, SIGNED_BRIDGE);
  const proposal = JSON.parse(await runtime.execute(AIMFORGE_PREPARE_DRIVER_MESSAGE_TOOL_NAME, {
    subject: 'Dock changed', body: 'Use door six.', priority: 'normal',
  }));
  assert.equal(proposal.state, 'pending_approval');
  assert.equal(calls[1].signedBridge, SIGNED_BRIDGE);
});
