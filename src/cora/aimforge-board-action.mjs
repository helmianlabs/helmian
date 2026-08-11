import { createHash, createHmac, randomUUID } from 'node:crypto';

export const AIMFORGE_BOARD_SUMMARY_PATH = '/api/helmian/actions/dispatch-board-summary';
export const AIMFORGE_BOARD_TOOL_NAME = 'aimforge_get_dispatch_board_summary';
export const AIMFORGE_ACTION_TIMEOUT_MS = 10_000;

function requiredActionSecret(value) {
  const secret = String(value ?? '');
  if (Buffer.byteLength(secret, 'utf8') < 32) {
    throw new Error('HELMION_AIMFORGE_ACTION_SECRET must be at least 32 bytes');
  }
  return secret;
}

function fixedActionUrl(value) {
  let base;
  try {
    base = new URL(String(value ?? '').trim());
  } catch {
    throw new Error('HELMION_AIMFORGE_API_BASE_URL must be a valid HTTPS origin');
  }
  if (base.protocol !== 'https:' || base.username || base.password
    || base.search || base.hash || !['', '/'].includes(base.pathname)) {
    throw new Error('HELMION_AIMFORGE_API_BASE_URL must be an HTTPS origin without path, credentials, query, or fragment');
  }
  return new URL(AIMFORGE_BOARD_SUMMARY_PATH, base.origin);
}

function sha256Hex(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function canonicalBody(signedBridge, date) {
  return JSON.stringify({ custom_session_id: signedBridge, date });
}

function canonicalRequest(timestamp, nonce, bodyDigest) {
  return ['v1', 'POST', AIMFORGE_BOARD_SUMMARY_PATH, timestamp, nonce, bodyDigest].join('\n');
}

function combineSignals(external, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('AimForge action timed out')), timeoutMs);
  const onAbort = () => controller.abort(external?.reason);
  if (external?.aborted) onAbort();
  else external?.addEventListener?.('abort', onAbort, { once: true });
  return {
    signal: controller.signal,
    dispose() {
      clearTimeout(timer);
      external?.removeEventListener?.('abort', onAbort);
    },
  };
}

function validateDate(value) {
  if (value === undefined || value === null || value === '') return null;
  const date = String(value);
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(date)) throw new Error('date must be YYYY-MM-DD');
  const parsed = new Date(`${date}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) {
    throw new Error('date must be a real calendar date');
  }
  return date;
}

function validateSummaryResponse(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('AimForge returned an invalid board summary');
  }
  const topKeys = Object.keys(value).sort();
  if (topKeys.join(',') !== 'action,summary,version'
    || value.version !== '1' || value.action !== 'dispatch.board.summary') {
    throw new Error('AimForge returned an invalid board summary contract');
  }
  const summary = value.summary;
  if (!summary || typeof summary !== 'object' || Array.isArray(summary)) {
    throw new Error('AimForge returned an invalid board summary');
  }
  const expectedKeys = [
    'assignedLoads', 'date', 'driversLowHos', 'driversOnShift',
    'totalLoads', 'unassignedLoads',
  ];
  if (Object.keys(summary).sort().join(',') !== expectedKeys.join(',')) {
    throw new Error('AimForge board summary projection was not bounded');
  }
  validateDate(summary.date);
  for (const key of expectedKeys.filter((key) => key !== 'date')) {
    if (!Number.isSafeInteger(summary[key]) || summary[key] < 0) {
      throw new Error(`AimForge board summary ${key} is invalid`);
    }
  }
  if (summary.assignedLoads + summary.unassignedLoads !== summary.totalLoads) {
    throw new Error('AimForge board summary load counts are inconsistent');
  }
  return Object.freeze({
    date: summary.date,
    totalLoads: summary.totalLoads,
    assignedLoads: summary.assignedLoads,
    unassignedLoads: summary.unassignedLoads,
    driversOnShift: summary.driversOnShift,
    driversLowHos: summary.driversLowHos,
  });
}

/** A single fixed-path client. It cannot issue writes or arbitrary HTTP. */
export function createAimForgeBoardActionClient({
  baseUrl = process.env.HELMION_AIMFORGE_API_BASE_URL,
  actionSecret = process.env.HELMION_AIMFORGE_ACTION_SECRET,
  fetchImpl = globalThis.fetch,
  now = () => new Date(),
  nonce = randomUUID,
  timeoutMs = AIMFORGE_ACTION_TIMEOUT_MS,
} = {}) {
  const url = fixedActionUrl(baseUrl);
  const secret = requiredActionSecret(actionSecret);
  if (typeof fetchImpl !== 'function') throw new Error('AimForge action fetch is unavailable');

  return Object.freeze({
    async getDispatchBoardSummary({ signedBridge, date = null, signal = null }) {
      if (typeof signedBridge !== 'string' || !signedBridge.startsWith('helmion:')) {
        throw new Error('A verified signed AimForge bridge is required');
      }
      const normalizedDate = validateDate(date);
      const body = canonicalBody(signedBridge, normalizedDate);
      const timestamp = String(Math.floor(now().getTime() / 1_000));
      const requestNonce = nonce();
      if (!/^[A-Za-z0-9_-]{16,128}$/u.test(requestNonce)) {
        throw new Error('AimForge action nonce generator returned an invalid value');
      }
      const canonical = canonicalRequest(timestamp, requestNonce, sha256Hex(body));
      const signature = createHmac('sha256', secret).update(canonical, 'utf8').digest('base64url');
      const combined = combineSignals(signal, timeoutMs);
      try {
        const response = await fetchImpl(url, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-helmian-timestamp': timestamp,
            'x-helmian-nonce': requestNonce,
            'x-helmian-signature': signature,
          },
          body,
          signal: combined.signal,
        });
        const text = await response.text();
        if (Buffer.byteLength(text, 'utf8') > 16_384) {
          throw new Error('AimForge board summary response exceeded its size limit');
        }
        let parsed;
        try { parsed = JSON.parse(text); } catch { throw new Error('AimForge returned non-JSON'); }
        if (!response.ok) {
          throw new Error(`AimForge board summary was refused (${response.status})`);
        }
        const receipt = response.headers?.get?.('x-aimforge-action-receipt') ?? '';
        if (!/^[a-f0-9]{32}$/u.test(receipt)) {
          throw new Error('AimForge action receipt is missing or invalid');
        }
        return validateSummaryResponse(parsed);
      } finally {
        combined.dispose();
      }
    },
  });
}

/** Dedicated one-tool runtime for signed AimForge voice sessions. */
export function createAimForgeBoardToolRuntime({ client, signedBridge }) {
  if (!client || typeof client.getDispatchBoardSummary !== 'function') {
    throw new Error('AimForge board action client is required');
  }
  const tool = Object.freeze({
    description: 'Read aggregate dispatch-board counts for the signed AimForge tenant. Returns no driver, vehicle, route, or contact details.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        date: { type: 'string', description: 'Optional service date in YYYY-MM-DD format.' },
      },
    },
    async execute(args, { signal = null } = {}) {
      const keys = Object.keys(args ?? {});
      if (keys.some((key) => key !== 'date')) throw new Error('Only the optional date argument is allowed');
      const summary = await client.getDispatchBoardSummary({
        signedBridge,
        date: args?.date ?? null,
        signal,
      });
      return JSON.stringify(summary);
    },
  });
  const tools = Object.freeze({ [AIMFORGE_BOARD_TOOL_NAME]: tool });
  return Object.freeze({
    root: 'aimforge-remote',
    permissionMode: 'read-tools',
    tools,
    definitionsForOpenAi() {
      return [{
        type: 'function',
        function: {
          name: AIMFORGE_BOARD_TOOL_NAME,
          description: tool.description,
          parameters: tool.parameters,
        },
      }];
    },
    async execute(name, args, options = {}) {
      if (options.signal?.aborted) return 'The action was cancelled before it ran.';
      if (name !== AIMFORGE_BOARD_TOOL_NAME) return `Error: unknown tool ${name}`;
      try {
        return await tool.execute(args, options);
      } catch (error) {
        return `Error: ${error?.message ?? String(error)}`;
      }
    },
    async dispose() {},
  });
}
