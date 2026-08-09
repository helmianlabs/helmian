// Helmian Herald — first-party paired phone companion.
//
// This server intentionally has only these route families:
//   1. static in-memory PWA shell assets (no filesystem access),
//   2. POST /api/pair (memory-only authentication state), and
//   3. paired status/session reads and narrowly scoped, explicitly confirmed
//      instruction/approval requests delegated to the desktop-owned bridge.
//
// There is no generic prompt, file, tool, shell, install, or write route.
// Authentication is checked before local reads or desktop delegation. Pairing
// sessions are per-device, expiring, revocable, scope-limited, and nonce-
// protected. The phone receives the session only as an HttpOnly cookie.

import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { networkInterfaces } from 'node:os';

import { buildDigest } from './digest.mjs';
import {
  APPROVAL_DECIDE_SCOPE,
  HeraldPairingRegistry,
  SESSION_INSTRUCT_SCOPE,
  SESSION_READ_SCOPE,
  STATUS_READ_SCOPE,
} from './pairing.mjs';
import { sanitizeDigestForPhone } from './status.mjs';
import {
  HERALD_APP_JS,
  HERALD_ICON,
  HERALD_MANIFEST,
  HERALD_SERVICE_WORKER,
  renderMobileShell,
} from './mobile-shell.mjs';

export const DEFAULT_PORT = 7420;
export const SESSION_COOKIE = 'helmian_herald_session';
const MAX_REQUEST_BODY_BYTES = 16_384;
const MAX_INSTRUCTION_LENGTH = 4_000;

/** Every LAN address this machine answers on, for an explicitly requested URL. */
export function lanAddresses() {
  const found = [];
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family === 'IPv4' && !entry.internal) found.push(entry.address);
    }
  }
  return found;
}

function send(response, status, contentType, body, extraHeaders = {}) {
  response.writeHead(status, {
    'content-type': contentType,
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    'x-frame-options': 'DENY',
    ...extraHeaders,
  });
  response.end(body);
}

function sendJson(response, status, value, extraHeaders = {}) {
  send(response, status, 'application/json; charset=utf-8', JSON.stringify(value), extraHeaders);
}

function parseCookies(header) {
  const cookies = new Map();
  for (const part of String(header ?? '').split(';')) {
    const separator = part.indexOf('=');
    if (separator <= 0) continue;
    const name = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    try { cookies.set(name, decodeURIComponent(value)); } catch { /* malformed cookie is absent */ }
  }
  return cookies;
}

async function readJsonBody(request) {
  const contentType = String(request.headers['content-type'] ?? '').split(';')[0].trim();
  if (contentType !== 'application/json') {
    const error = new Error('Pairing requires application/json.');
    error.status = 415;
    throw error;
  }

  let size = 0;
  const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_REQUEST_BODY_BYTES) {
      const error = new Error('Request is too large.');
      error.status = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    const error = new Error('Pairing request is not valid JSON.');
    error.status = 400;
    throw error;
  }
}

function publicAsset(pathname) {
  if (pathname === '/') {
    return {
      type: 'text/html; charset=utf-8',
      body: renderMobileShell(),
      headers: {
        'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; script-src 'self'; connect-src 'self'; manifest-src 'self'; worker-src 'self'; img-src 'self'",
      },
    };
  }
  if (pathname === '/app.js') {
    return { type: 'text/javascript; charset=utf-8', body: HERALD_APP_JS };
  }
  if (pathname === '/sw.js') {
    return { type: 'text/javascript; charset=utf-8', body: HERALD_SERVICE_WORKER };
  }
  if (pathname === '/manifest.webmanifest') {
    return { type: 'application/manifest+json; charset=utf-8', body: HERALD_MANIFEST };
  }
  if (pathname === '/icon.svg') {
    return { type: 'image/svg+xml; charset=utf-8', body: HERALD_ICON };
  }
  return null;
}

/**
 * Starts the local Herald companion service.
 *
 * @param {{
 *   workspace: string,
 *   host?: string,
 *   port?: number,
 *   pairingRegistry?: HeraldPairingRegistry,
 *   digestBuilder?: typeof buildDigest,
 *   pairingScopes?: string[],
 *   desktopBridge?: object,
 * }} options
 */
export async function startHerald({
  workspace,
  host = '127.0.0.1',
  port = DEFAULT_PORT,
  pairingRegistry = new HeraldPairingRegistry(),
  digestBuilder = buildDigest,
  pairingScopes = [STATUS_READ_SCOPE],
  desktopBridge = null,
} = {}) {
  if (!workspace) throw new Error('Herald needs a workspace to report on');
  const pairing = pairingRegistry.issuePairingCode({ scopes: pairingScopes });

  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);

    const asset = publicAsset(url.pathname);
    if (asset) {
      if (request.method !== 'GET') {
        send(response, 405, 'text/plain; charset=utf-8', 'Helmian Herald shell is read-only.\n', { allow: 'GET' });
        return;
      }
      send(response, 200, asset.type, asset.body, asset.headers);
      return;
    }

    if (url.pathname === '/api/pair') {
      if (request.method !== 'POST') {
        sendJson(response, 405, { error: 'method_not_allowed' }, { allow: 'POST' });
        return;
      }
      try {
        const body = await readJsonBody(request);
        const result = pairingRegistry.pair({ code: body?.code, deviceId: body?.deviceId });
        if (!result.ok) {
          sendJson(response, 401, { error: 'pairing_refused', reason: result.reason, message: 'Pairing was refused.' });
          return;
        }
        const maxAge = Math.max(0, Math.floor((Date.parse(result.expiresAt) - Date.now()) / 1000));
        sendJson(response, 200, {
          paired: true,
          deviceId: result.deviceId,
          scope: result.scope,
          scopes: result.scopes,
          expiresAt: result.expiresAt,
        }, {
          'set-cookie': `${SESSION_COOKIE}=${encodeURIComponent(result.token)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}`,
        });
      } catch (error) {
        sendJson(response, error?.status ?? 400, { error: 'invalid_pairing_request', message: error.message });
      }
      return;
    }

    const authorize = (scope) => {
      const token = parseCookies(request.headers.cookie).get(SESSION_COOKIE);
      return pairingRegistry.authorize({
        token,
        deviceId: request.headers['x-helmian-device-id'],
        nonce: request.headers['x-helmian-nonce'],
        scope,
      });
    };

    const requireAuthorization = (scope) => {
      const authorization = authorize(scope);
      if (!authorization.ok) {
        sendJson(response, 401, {
          error: 'pairing_required',
          reason: authorization.reason,
          message: 'A current device pairing with the required scope is required.',
        });
        return null;
      }
      return authorization;
    };

    if (url.pathname === '/api/status') {
      if (request.method !== 'GET') {
        sendJson(response, 405, { error: 'read_only' }, { allow: 'GET' });
        return;
      }

      // Authentication and replay denial occur before the digest builder can
      // touch the fixed local status ledgers.
      if (!requireAuthorization(STATUS_READ_SCOPE)) return;

      try {
        const digest = await digestBuilder(workspace);
        sendJson(response, 200, sanitizeDigestForPhone(digest));
      } catch {
        // Local read failures stay generic at the phone boundary.
        sendJson(response, 503, {
          error: 'status_unavailable',
          message: 'Local Helmian status could not be computed. This is not an all-clear.',
        });
      }
      return;
    }

    if (url.pathname === '/api/session') {
      if (request.method !== 'GET') {
        sendJson(response, 405, { error: 'method_not_allowed' }, { allow: 'GET' });
        return;
      }
      const authorization = requireAuthorization(SESSION_READ_SCOPE);
      if (!authorization) return;
      if (!await desktopBridge?.isAvailable?.()) {
        sendJson(response, 503, { error: 'desktop_unavailable', message: 'Helmian Desktop is not available.' });
        return;
      }
      const context = await desktopBridge.getSessionContext({ deviceId: authorization.deviceId });
      sendJson(response, 200, {
        project: context.project,
        session: context.session,
        agent: context.agent,
        guard: context.guard,
        outputs: Array.isArray(context.outputs) ? context.outputs.slice(-20) : [],
        approvals: Array.isArray(context.approvals) ? context.approvals : [],
        voice: context.voice ?? { available: false, reason: 'Voice is not available from this desktop session.' },
      });
      return;
    }

    if (url.pathname === '/api/instructions') {
      if (request.method !== 'POST') {
        sendJson(response, 405, { error: 'method_not_allowed' }, { allow: 'POST' });
        return;
      }
      const authorization = requireAuthorization(SESSION_INSTRUCT_SCOPE);
      if (!authorization) return;
      if (!await desktopBridge?.isAvailable?.()) {
        sendJson(response, 503, { error: 'desktop_unavailable', message: 'Helmian Desktop is not available; no instruction was sent.' });
        return;
      }
      try {
        const body = await readJsonBody(request);
        const text = String(body?.text ?? '').trim();
        if (body?.confirmed !== true || text.length === 0 || text.length > MAX_INSTRUCTION_LENGTH) {
          sendJson(response, 400, { error: 'invalid_instruction', message: 'Review and explicitly confirm a 1–4000 character instruction.' });
          return;
        }
        const context = await desktopBridge.getSessionContext({ deviceId: authorization.deviceId });
        if (body.projectId !== context.project?.id || body.sessionId !== context.session?.id) {
          sendJson(response, 409, { error: 'context_changed', message: 'The selected project or session changed. Review again before sending.' });
          return;
        }
        const command = {
          id: randomUUID(),
          kind: 'user_instruction',
          deviceId: authorization.deviceId,
          projectId: body.projectId,
          sessionId: body.sessionId,
          text,
          confirmed: true,
          submittedAt: new Date().toISOString(),
        };
        await desktopBridge.audit?.({ ...command, event: 'remote_instruction_requested' });
        const result = await desktopBridge.submitInstruction(command);
        await desktopBridge.audit?.({ ...command, event: 'remote_instruction_result', result: result?.state ?? 'unknown' });
        sendJson(response, result?.accepted === true ? 202 : 409, {
          instructionId: command.id,
          accepted: result?.accepted === true,
          state: result?.state ?? 'refused',
          message: result?.message ?? 'The desktop did not accept the instruction.',
        });
      } catch (error) {
        sendJson(response, error?.status ?? 400, { error: 'invalid_instruction', message: error.message });
      }
      return;
    }

    const approvalMatch = url.pathname.match(/^\/api\/approvals\/([A-Za-z0-9._:-]{1,128})\/decision$/);
    if (approvalMatch) {
      if (request.method !== 'POST') {
        sendJson(response, 405, { error: 'method_not_allowed' }, { allow: 'POST' });
        return;
      }
      const authorization = requireAuthorization(APPROVAL_DECIDE_SCOPE);
      if (!authorization) return;
      if (!await desktopBridge?.isAvailable?.()) {
        sendJson(response, 503, { error: 'desktop_unavailable', message: 'Helmian Desktop is not available; no decision was applied.' });
        return;
      }
      try {
        const body = await readJsonBody(request);
        if (body?.confirmed !== true || !['allow-once', 'deny'].includes(body?.decision)) {
          sendJson(response, 400, { error: 'invalid_decision', message: 'Review and confirm Allow once or Deny.' });
          return;
        }
        const context = await desktopBridge.getSessionContext({ deviceId: authorization.deviceId });
        if (body.projectId !== context.project?.id || body.sessionId !== context.session?.id) {
          sendJson(response, 409, { error: 'context_changed', message: 'The selected project or session changed. Review again.' });
          return;
        }
        const decision = {
          id: randomUUID(), approvalId: approvalMatch[1], decision: body.decision,
          deviceId: authorization.deviceId, projectId: body.projectId, sessionId: body.sessionId,
          confirmed: true,
          decidedAt: new Date().toISOString(),
        };
        await desktopBridge.audit?.({ ...decision, event: 'remote_approval_requested' });
        const result = await desktopBridge.decideApproval(decision);
        await desktopBridge.audit?.({ ...decision, event: 'remote_approval_result', result: result?.state ?? 'unknown' });
        sendJson(response, result?.accepted === true ? 200 : 409, {
          decisionId: decision.id,
          accepted: result?.accepted === true,
          state: result?.state ?? 'refused',
          message: result?.message ?? 'The desktop did not accept the decision.',
        });
      } catch (error) {
        sendJson(response, error?.status ?? 400, { error: 'invalid_decision', message: error.message });
      }
      return;
    }

    // No catch-all digest and no static filesystem handler. Prompt, file, tool,
    // shell, write, approval, and traversal-looking routes all end here.
    sendJson(response, 404, { error: 'route_not_found' });
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolve);
  });

  const actual = server.address();
  const urls = (host === '0.0.0.0' ? lanAddresses() : [host])
    .map((address) => `http://${address}:${actual.port}/`);

  return {
    host,
    port: actual.port,
    urls,
    pairingCode: pairing.code,
    pairingExpiresAt: pairing.expiresAt,
    revokeDevice: (deviceId) => pairingRegistry.revokeDevice(deviceId),
    async close() {
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
