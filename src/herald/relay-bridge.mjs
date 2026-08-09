// Helmian Herald — typed request/response traffic over the existing relay.
//
// The old relay deliberately carries only bounded text. This module keeps that
// property: it serializes a small, closed set of Herald envelopes into that
// text lane. Receiving text is never authority to execute it. Only a request
// already authenticated by the Herald phone boundary can become one of the
// named actions below, and the desktop checks availability and selected context
// again before delegating to Maestro.

import { randomUUID } from 'node:crypto';
import { MAX_BODY_CHARS } from '../relay/protocol.mjs';
import { createRelayPoller } from '../relay/poller.mjs';

export const HERALD_RELAY_VERSION = 1;
export const HERALD_RELAY_PRODUCT = 'helmian-herald';

const ACTIONS = new Set([
  'session.read',
  'instruction.submit',
  'approval.decide',
  'audit.append',
]);

const ID_RE = /^[A-Za-z0-9._:-]{1,128}$/;
const DEVICE_RE = /^[A-Za-z0-9._:-]{8,128}$/;
const MAX_RELAY_INSTRUCTION_CHARS = 2_800;

function plainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function boundedText(value, max = 4_000) {
  return typeof value === 'string' && value.length > 0 && value.length <= max;
}

function cleanNamedEntity(value) {
  if (!plainObject(value) || !boundedText(value.id, 256)) return null;
  return {
    id: value.id,
    ...(boundedText(value.name, 256) ? { name: value.name } : {}),
    ...(boundedText(value.state, 128) ? { state: value.state } : {}),
  };
}

/** Only these fields can cross from the desktop to a paired phone. */
export function sanitizeSessionSnapshot(context) {
  if (!plainObject(context)) throw new TypeError('desktop session context is unavailable');
  const project = cleanNamedEntity(context.project);
  const session = cleanNamedEntity(context.session);
  if (!project || !session) throw new TypeError('desktop session context is incomplete');

  const outputs = Array.isArray(context.outputs) ? context.outputs.slice(-8).flatMap((item) => {
    if (!plainObject(item) || !boundedText(item.id, 256) || !boundedText(item.text, 280)) return [];
    return [{ id: item.id, text: item.text, ...(boundedText(item.at, 64) ? { at: item.at } : {}) }];
  }) : [];
  const approvals = Array.isArray(context.approvals) ? context.approvals.slice(0, 8).flatMap((item) => {
    if (!plainObject(item) || !boundedText(item.id, 256) || !boundedText(item.summary, 240)) return [];
    return [{ id: item.id, summary: item.summary, ...(boundedText(item.state, 128) ? { state: item.state } : {}) }];
  }) : [];

  return {
    project,
    session,
    agent: cleanNamedEntity(context.agent),
    guard: plainObject(context.guard) && boundedText(context.guard.state, 128)
      ? { state: context.guard.state, ...(boundedText(context.guard.detail, 1_000) ? { detail: context.guard.detail } : {}) }
      : { state: 'unknown', detail: 'Guard state was unavailable.' },
    outputs,
    approvals,
    voice: plainObject(context.voice) && context.voice.available === true
      ? { available: true }
      : { available: false, reason: boundedText(context.voice?.reason, 500)
        ? context.voice.reason : 'Voice is not available from this desktop session.' },
  };
}

export function parseHeraldRelayEnvelope(raw) {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > MAX_BODY_CHARS) {
    return { ok: false, reason: 'invalid_size' };
  }
  let value;
  try { value = JSON.parse(raw); } catch { return { ok: false, reason: 'invalid_json' }; }
  if (!plainObject(value) || value.v !== HERALD_RELAY_VERSION || value.product !== HERALD_RELAY_PRODUCT) {
    return { ok: false, reason: 'wrong_protocol' };
  }
  if (!['request', 'result'].includes(value.kind) || !ID_RE.test(value.requestId ?? '')
      || !ACTIONS.has(value.action) || !DEVICE_RE.test(value.deviceId ?? '')) {
    return { ok: false, reason: 'invalid_envelope' };
  }
  if (!plainObject(value.payload)) return { ok: false, reason: 'invalid_payload' };
  return { ok: true, envelope: {
    v: HERALD_RELAY_VERSION,
    product: HERALD_RELAY_PRODUCT,
    kind: value.kind,
    requestId: value.requestId,
    action: value.action,
    deviceId: value.deviceId,
    payload: value.payload,
  } };
}

function encodeEnvelope(value) {
  const encoded = JSON.stringify(value);
  if (encoded.length > MAX_BODY_CHARS) throw new TypeError('Herald relay envelope is too large');
  return encoded;
}

function requestEnvelope({ requestId, action, deviceId, payload }) {
  return encodeEnvelope({
    v: HERALD_RELAY_VERSION, product: HERALD_RELAY_PRODUCT, kind: 'request',
    requestId, action, deviceId, payload,
  });
}

function resultEnvelope(request, payload) {
  return encodeEnvelope({
    v: HERALD_RELAY_VERSION, product: HERALD_RELAY_PRODUCT, kind: 'result',
    requestId: request.requestId, action: request.action, deviceId: request.deviceId, payload,
  });
}

/** Relay-backed implementation of the desktopBridge contract used by server.mjs. */
export function createHeraldRelayPhoneBridge({
  send,
  isDesktopPresent = () => false,
  timeoutMs = 10_000,
  makeRequestId = randomUUID,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
} = {}) {
  if (typeof send !== 'function') throw new TypeError('Herald phone relay needs send');
  const pending = new Map();

  function request(action, deviceId, payload) {
    if (!DEVICE_RE.test(deviceId ?? '')) return Promise.reject(new TypeError('valid paired device id required'));
    const requestId = makeRequestId();
    return new Promise((resolve, reject) => {
      const timer = setTimer(() => {
        pending.delete(requestId);
        reject(new Error('Helmian Desktop did not answer the Herald relay request.'));
      }, timeoutMs);
      pending.set(requestId, { action, deviceId, resolve, reject, timer });
      try {
        const sent = send(requestEnvelope({ requestId, action, deviceId, payload }));
        if (sent?.sent === false && sent?.queued !== true) throw new Error(sent.reason ?? 'relay refused request');
      } catch (error) {
        pending.delete(requestId);
        clearTimer(timer);
        reject(error);
      }
    });
  }

  return {
    isAvailable: () => isDesktopPresent() === true,
    getSessionContext: ({ deviceId } = {}) => request('session.read', deviceId, {}),
    submitInstruction: (command) => request('instruction.submit', command?.deviceId, { command }),
    decideApproval: (decision) => request('approval.decide', decision?.deviceId, { decision }),
    audit: (event) => request('audit.append', event?.deviceId, { event }),
    handleMessage(body) {
      const parsed = parseHeraldRelayEnvelope(body);
      if (!parsed.ok || parsed.envelope.kind !== 'result') return { accepted: false, reason: parsed.reason ?? 'not_result' };
      const current = pending.get(parsed.envelope.requestId);
      if (!current || current.action !== parsed.envelope.action || current.deviceId !== parsed.envelope.deviceId) {
        return { accepted: false, reason: 'unmatched_result' };
      }
      pending.delete(parsed.envelope.requestId);
      clearTimer(current.timer);
      if (parsed.envelope.payload.ok !== true) current.reject(new Error(parsed.envelope.payload.message ?? 'Desktop refused request.'));
      else current.resolve(parsed.envelope.payload.value);
      return { accepted: true };
    },
    close() {
      for (const current of pending.values()) {
        clearTimer(current.timer);
        current.reject(new Error('Herald relay bridge closed.'));
      }
      pending.clear();
    },
  };
}

/** Desktop consumer. Raw relay text reaches only this closed dispatcher. */
export function createHeraldRelayDesktopEndpoint({ desktopBridge, send } = {}) {
  if (!desktopBridge || typeof send !== 'function') throw new TypeError('Herald desktop relay needs bridge and send');

  async function refuse(request, message) {
    send(resultEnvelope(request, { ok: false, message }));
    return { accepted: false, reason: message };
  }

  return {
    async handleMessage(body) {
      const parsed = parseHeraldRelayEnvelope(body);
      if (!parsed.ok || parsed.envelope.kind !== 'request') return { accepted: false, reason: parsed.reason ?? 'not_request' };
      const request = parsed.envelope;
      if (!desktopBridge.isAvailable?.()) return refuse(request, 'Helmian Desktop is not available.');

      try {
        let value;
        if (request.action === 'session.read') {
          value = sanitizeSessionSnapshot(await desktopBridge.getSessionContext());
        } else if (request.action === 'instruction.submit') {
          const command = request.payload.command;
          if (!plainObject(command) || command.deviceId !== request.deviceId
              || command.kind !== 'user_instruction' || !boundedText(command.text, MAX_RELAY_INSTRUCTION_CHARS)
              || !boundedText(command.projectId, 256) || !boundedText(command.sessionId, 256)) {
            return refuse(request, 'The instruction envelope was invalid.');
          }
          const context = sanitizeSessionSnapshot(await desktopBridge.getSessionContext());
          if (context.project.id !== command.projectId || context.session.id !== command.sessionId) {
            return refuse(request, 'The selected project or session changed.');
          }
          value = await desktopBridge.submitInstruction(command);
        } else if (request.action === 'approval.decide') {
          const decision = request.payload.decision;
          if (!plainObject(decision) || decision.deviceId !== request.deviceId
              || !['allow-once', 'deny'].includes(decision.decision)
              || !boundedText(decision.projectId, 256) || !boundedText(decision.sessionId, 256)) {
            return refuse(request, 'The approval envelope was invalid.');
          }
          const context = sanitizeSessionSnapshot(await desktopBridge.getSessionContext());
          if (context.project.id !== decision.projectId || context.session.id !== decision.sessionId) {
            return refuse(request, 'The selected project or session changed.');
          }
          value = await desktopBridge.decideApproval(decision);
        } else if (request.action === 'audit.append') {
          const event = request.payload.event;
          if (!plainObject(event) || event.deviceId !== request.deviceId || !boundedText(event.event, 128)) {
            return refuse(request, 'The audit envelope was invalid.');
          }
          value = await desktopBridge.audit(event);
        }
        send(resultEnvelope(request, { ok: true, value: value ?? null }));
        return { accepted: true, action: request.action };
      } catch {
        return refuse(request, 'Helmian Desktop could not complete the request.');
      }
    },
  };
}

function pollingSend(poller, body) {
  const result = poller.send(body);
  if (result?.queued === true) poller.wake();
  return result;
}

/**
 * Trusted server-side half of Herald over the proven polling transport.
 * The relay key stays here; it is never shipped in the PWA JavaScript.
 */
export function createHeraldIngressPollingTransport({
  baseUrl,
  key,
  channel,
  onStatus = () => {},
  pollerFactory = createRelayPoller,
  ...bridgeOptions
} = {}) {
  let bridge;
  const poller = pollerFactory({
    baseUrl, key, channel, role: 'phone', onStatus,
    onMessage: (message) => bridge.handleMessage(message.body),
  });
  bridge = createHeraldRelayPhoneBridge({
    ...bridgeOptions,
    send: (body) => pollingSend(poller, body),
    isDesktopPresent: () => Boolean(poller.presence?.desktop),
  });
  return {
    bridge,
    poller,
    start: () => poller.start(),
    stop() { bridge.close(); poller.stop(); },
  };
}

/** Desktop outbound half. It listens nowhere and accepts only typed envelopes. */
export function createHeraldDesktopPollingTransport({
  baseUrl,
  key,
  channel,
  desktopBridge,
  onStatus = () => {},
  onProtocolError = () => {},
  pollerFactory = createRelayPoller,
} = {}) {
  let endpoint;
  const poller = pollerFactory({
    baseUrl, key, channel, role: 'desktop', onStatus,
    onMessage: (message) => {
      Promise.resolve(endpoint.handleMessage(message.body)).catch(onProtocolError);
    },
  });
  endpoint = createHeraldRelayDesktopEndpoint({
    desktopBridge,
    send: (body) => pollingSend(poller, body),
  });
  return {
    endpoint,
    poller,
    start: () => poller.start(),
    stop: () => poller.stop(),
  };
}
