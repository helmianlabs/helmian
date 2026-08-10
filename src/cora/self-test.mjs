// Local, provider-free Cora smoke test.
//
// This is intentionally a real server + real WebSocket client. The agent turn
// is deterministic only at the provider seam, so the command proves the wire,
// session-policy, and assistant_end lifecycle without needing Hume or a model
// credential and without writing the workspace activity ledger.

import assert from 'node:assert/strict';

import { startCoraClm } from './clm-server.mjs';
import {
  assertCoraHealthDiagnostics,
  CORA_HEALTH_DIAGNOSTICS_SUPPORTED_VERSIONS,
} from './health-schema.mjs';

const SELF_TEST_TIMEOUT_MS = 5_000;

function waitFor(predicate, label) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const poll = () => {
      if (predicate()) return resolve();
      if (Date.now() - started >= SELF_TEST_TIMEOUT_MS) {
        return reject(new Error(`Timed out waiting for ${label}.`));
      }
      setTimeout(poll, 5).unref?.();
    };
    poll();
  });
}

async function connect(url) {
  const socket = new WebSocket(url);
  const messages = [];
  const failure = new Promise((_, reject) => {
    socket.addEventListener('error', () => reject(new Error('self-test WebSocket failed')), { once: true });
  });
  await Promise.race([
    new Promise((resolve) => socket.addEventListener('open', resolve, { once: true })),
    failure,
  ]);
  socket.addEventListener('message', (event) => {
    try { messages.push(JSON.parse(String(event.data))); } catch { /* not a CLM message */ }
  });
  return { socket, messages };
}

async function closeClient(socket) {
  if (!socket || socket.readyState === WebSocket.CLOSED) return;
  if (socket.readyState === WebSocket.OPEN) socket.close();
  await new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    socket.addEventListener('close', finish, { once: true });
    // A server-side close or a platform WebSocket implementation may not
    // deliver the peer close event. Do not let a smoke test hang forever.
    setTimeout(finish, 250);
  });
}

function sendTurn(socket, text, sessionId) {
  socket.send(JSON.stringify({
    messages: [{ message: { role: 'user', content: text } }],
    custom_session_id: sessionId,
  }));
}

/**
 * Run the local Cora smoke test.
 *
 * @returns {Promise<{turns: number, policyModes: string[]}>}
 */
export async function runCoraSelfTest({ workspace = process.cwd() } = {}) {
  const policyModes = [];
  const server = await startCoraClm({
    workspace,
    port: 0,
    notifyBackgroundAgents: false,
    speakNotificationsUnprompted: false,
    // The smoke test must not append to the caller's activity ledger.
    activitySink: null,
    runTurn: async ({ session, onEvent }) => {
      const mode = session.helmionMode ? 'tools-enabled' : 'chat-only';
      policyModes.push(mode);
      const text = `self-test ${mode}`;
      onEvent({ type: 'assistant', text });
      return { text, messages: [] };
    },
  });

  let client;
  try {
    client = await connect(server.url);

    sendTurn(client.socket, 'local policy check', 'helmion:self-test');
    await waitFor(
      () => client.messages.filter((message) => message.type === 'assistant_end').length === 1,
      'tool-enabled assistant_end',
    );

    sendTurn(client.socket, 'chat policy check', 'chat:self-test');
    await waitFor(
      () => client.messages.filter((message) => message.type === 'assistant_end').length === 2,
      'chat-only assistant_end',
    );

    const inputs = client.messages
      .filter((message) => message.type === 'assistant_input')
      .map((message) => message.text);
    assert.ok(inputs.includes('self-test tools-enabled'));
    assert.ok(inputs.includes('self-test chat-only'));
    assert.deepEqual(policyModes, ['tools-enabled', 'chat-only']);
    assert.equal(server.sessionCount(), 2);

    const health = await fetch(server.healthUrl);
    assert.equal(health.status, 200);
    const snapshot = await health.json();
    assert.equal(snapshot.status, 'ok');
    assert.equal(snapshot.sessions, 2);
    assert.equal(snapshot.inFlight, 0);
    assert.equal(snapshot.provider, null);
    assert.deepEqual(snapshot.providerReadiness, {
      schemaVersion: 1,
      mode: 'local-mock',
      state: 'ready',
      ready: true,
      providerRequired: false,
    });
    assert.equal(JSON.stringify(snapshot).includes(workspace), false);

    const detail = await fetch(`${server.healthUrl}?detail=1`);
    assert.equal(detail.status, 200);
    const detailSnapshot = await detail.json();
    assertCoraHealthDiagnostics(detailSnapshot.diagnostics, {
      supportedVersions: CORA_HEALTH_DIAGNOSTICS_SUPPORTED_VERSIONS,
    });
    assert.equal(detailSnapshot.diagnostics.sessions.length, 2);
    assert.deepEqual(
      detailSnapshot.diagnostics.sessions.map(({ mode, turns, inFlight, active }) => ({
        mode, turns, inFlight, active,
      })),
      [
        { mode: 'tools-enabled', turns: 1, inFlight: 0, active: false },
        { mode: 'chat-only', turns: 1, inFlight: 0, active: false },
      ],
    );
    assert.equal(JSON.stringify(detailSnapshot).includes('self-test'), false);
    assert.equal(JSON.stringify(detailSnapshot).includes(workspace), false);

    return { turns: policyModes.length, policyModes: [...policyModes] };
  } finally {
    try { await closeClient(client?.socket); } catch { /* already closed */ }
    await server.close();
  }
}
