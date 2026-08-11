import { createHash, createHmac, randomUUID } from 'node:crypto';

export const AIMFORGE_BOARD_SUMMARY_PATH = '/api/helmian/actions/dispatch-board-summary';
export const AIMFORGE_PREPARE_DRIVER_MESSAGE_PATH = '/api/helmian/actions/prepare-driver-message';
export const AIMFORGE_DEPARTMENT_HANDOFF_PATH = '/api/helmian/actions/department-handoff';
export const AIMFORGE_BOARD_TOOL_NAME = 'aimforge_get_dispatch_board_summary';
export const AIMFORGE_PREPARE_DRIVER_MESSAGE_TOOL_NAME = 'aimforge_prepare_driver_message';
export const AIMFORGE_DEPARTMENT_HANDOFF_TOOL_NAME = 'aimforge_create_department_handoff';
export const AIMFORGE_ACTION_TIMEOUT_MS = 10_000;
export const AIMFORGE_ACTION_MAX_RESPONSE_BYTES = 16_384;
export const AIMFORGE_ALLOWED_ACTION_ORIGINS = Object.freeze([
  'https://aimforge-api.fly.dev',
]);

function requiredActionSecret(value) {
  const secret = String(value ?? '');
  if (Buffer.byteLength(secret, 'utf8') < 32) {
    throw new Error('HELMION_AIMFORGE_ACTION_SECRET must be at least 32 bytes');
  }
  return secret;
}

export function isAllowedAimForgeActionOrigin(value) {
  let base;
  try {
    base = new URL(String(value ?? '').trim());
  } catch {
    return false;
  }
  if (base.protocol !== 'https:' || base.username || base.password
    || base.search || base.hash || !['', '/'].includes(base.pathname)) {
    return false;
  }
  return AIMFORGE_ALLOWED_ACTION_ORIGINS.includes(base.origin);
}

function fixedActionUrl(value, path) {
  if (!isAllowedAimForgeActionOrigin(value)) {
    throw new Error(
      'HELMION_AIMFORGE_API_BASE_URL must be an explicitly allowed AimForge HTTPS origin',
    );
  }
  const base = new URL(String(value).trim());
  return new URL(path, base.origin);
}

function sha256Hex(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function canonicalRequest(path, timestamp, nonce, bodyDigest) {
  return ['v1', 'POST', path, timestamp, nonce, bodyDigest].join('\n');
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

async function readBoundedResponse(response, maxBytes = AIMFORGE_ACTION_MAX_RESPONSE_BYTES) {
  const contentLength = response.headers?.get?.('content-length');
  if (contentLength !== null && contentLength !== undefined && contentLength !== '') {
    const declared = Number(contentLength);
    if (!Number.isSafeInteger(declared) || declared < 0 || declared > maxBytes) {
      await response.body?.cancel?.('AimForge response exceeded its size limit');
      throw new Error('AimForge action response exceeded its size limit');
    }
  }
  const reader = response.body?.getReader?.();
  if (!reader) throw new Error('AimForge returned an unreadable response body');
  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!(value instanceof Uint8Array)) {
      await reader.cancel('AimForge response chunk was invalid');
      throw new Error('AimForge returned an unreadable response body');
    }
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel('AimForge response exceeded its size limit');
      throw new Error('AimForge action response exceeded its size limit');
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks, total).toString('utf8');
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

function validateDriverMessageInput(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('driver-message arguments must be an object');
  }
  if (Object.keys(value).sort().join(',') !== 'body,priority,subject') {
    throw new Error('Only subject, body, and priority are allowed');
  }
  const subject = typeof value.subject === 'string' ? value.subject.trim() : '';
  const body = typeof value.body === 'string' ? value.body.trim() : '';
  const priority = value.priority;
  if (!subject || subject.length > 120
    || !body || body.length > 1_400
    || (priority !== 'normal' && priority !== 'urgent')) {
    throw new Error('Driver-message arguments are invalid');
  }
  return { subject, body, priority };
}

function validatePrepareResponse(value, status) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).sort().join(',') !== 'action,duplicate,proposalId,recipientMasked,state,version'
    || value.version !== '1' || value.action !== 'driver.message.prepare'
    || value.state !== 'pending_approval'
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value.proposalId)
    || typeof value.recipientMasked !== 'string' || value.recipientMasked.length < 4 || value.recipientMasked.length > 32
    || /\d{7,}/u.test(value.recipientMasked)
    || typeof value.duplicate !== 'boolean'
    || (status === 201 && value.duplicate) || (status === 202 && !value.duplicate)) {
    throw new Error('AimForge returned an invalid pending-approval proposal');
  }
  return Object.freeze({
    state: value.state,
    proposalId: value.proposalId,
    recipientMasked: value.recipientMasked,
    duplicate: value.duplicate,
  });
}

const DEPARTMENT_ROLES = Object.freeze(['safety', 'payroll', 'director', 'dispatcher']);

function validateDepartmentHandoffInput(value, { includeConfirmation = false } = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('department-handoff arguments must be an object');
  }
  const expected = includeConfirmation
    ? 'body,confirmed,priority,recipientRole,subject'
    : 'body,priority,recipientRole,subject';
  if (Object.keys(value).sort().join(',') !== expected) {
    throw new Error(`Only recipientRole, subject, body, priority${includeConfirmation ? ', and confirmed' : ''} are allowed`);
  }
  const recipientRole = typeof value.recipientRole === 'string' ? value.recipientRole.trim().toLowerCase() : '';
  const subject = typeof value.subject === 'string' ? value.subject.trim() : '';
  const body = typeof value.body === 'string' ? value.body.trim() : '';
  const priority = value.priority;
  if (!DEPARTMENT_ROLES.includes(recipientRole)
    || !subject || subject.length > 160
    || !body || body.length > 4_000
    || (priority !== 'normal' && priority !== 'urgent')
    || (includeConfirmation && typeof value.confirmed !== 'boolean')) {
    throw new Error('Department-handoff arguments are invalid');
  }
  return { recipientRole, subject, body, priority, ...(includeConfirmation ? { confirmed: value.confirmed } : {}) };
}

function validateDepartmentHandoffResponse(value, status) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).sort().join(',') !== 'action,duplicate,messageId,priority,recipientRole,state,version'
    || value.version !== '1' || value.action !== 'department.handoff.create'
    || value.state !== 'persisted'
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value.messageId)
    || !DEPARTMENT_ROLES.includes(value.recipientRole)
    || (value.priority !== 'normal' && value.priority !== 'urgent')
    || typeof value.duplicate !== 'boolean'
    || (status === 201 && value.duplicate) || (status === 200 && !value.duplicate)) {
    throw new Error('AimForge returned an invalid department-handoff receipt');
  }
  return Object.freeze({
    state: value.state,
    messageId: value.messageId,
    recipientRole: value.recipientRole,
    priority: value.priority,
    duplicate: value.duplicate,
  });
}

function isExplicitHandoffConfirmation(value) {
  const text = String(value ?? '').trim().toLowerCase().replace(/[.!]+$/u, '').trim();
  return /^(?:yes(?:,? i)? confirm(?: the (?:internal )?(?:department )?handoff)?|i confirm(?: the (?:internal )?(?:department )?handoff)?|confirm(?: the (?:internal )?(?:department )?handoff)?|confirmed|proceed|go ahead)$/u.test(text);
}

/** A fixed-path client limited to aggregate reads and prepare-only proposals. */
export function createAimForgeBoardActionClient({
  baseUrl = process.env.HELMION_AIMFORGE_API_BASE_URL,
  actionSecret = process.env.HELMION_AIMFORGE_ACTION_SECRET,
  fetchImpl = globalThis.fetch,
  now = () => new Date(),
  nonce = randomUUID,
  timeoutMs = AIMFORGE_ACTION_TIMEOUT_MS,
} = {}) {
  const boardUrl = fixedActionUrl(baseUrl, AIMFORGE_BOARD_SUMMARY_PATH);
  const prepareUrl = fixedActionUrl(baseUrl, AIMFORGE_PREPARE_DRIVER_MESSAGE_PATH);
  const departmentHandoffUrl = fixedActionUrl(baseUrl, AIMFORGE_DEPARTMENT_HANDOFF_PATH);
  const secret = requiredActionSecret(actionSecret);
  if (typeof fetchImpl !== 'function') throw new Error('AimForge action fetch is unavailable');

  async function signedRequest({ path, url, signedBridge, payload, signal, label }) {
    if (typeof signedBridge !== 'string' || !signedBridge.startsWith('helmion:')) {
      throw new Error('A verified signed AimForge bridge is required');
    }
    const body = JSON.stringify({ custom_session_id: signedBridge, ...payload });
    const timestamp = String(Math.floor(now().getTime() / 1_000));
    const requestNonce = nonce();
    if (!/^[A-Za-z0-9_-]{16,128}$/u.test(requestNonce)) {
      throw new Error('AimForge action nonce generator returned an invalid value');
    }
    const canonical = canonicalRequest(path, timestamp, requestNonce, sha256Hex(body));
    const signature = createHmac('sha256', secret).update(canonical, 'utf8').digest('base64url');
    const combined = combineSignals(signal, timeoutMs);
    try {
      const response = await fetchImpl(url, {
          method: 'POST',
          redirect: 'error',
          headers: {
            'content-type': 'application/json',
            'x-helmian-timestamp': timestamp,
            'x-helmian-nonce': requestNonce,
            'x-helmian-signature': signature,
          },
          body,
          signal: combined.signal,
      });
      if (response.status >= 300 && response.status < 400) {
        await response.body?.cancel?.('AimForge redirects are forbidden');
        throw new Error(`AimForge ${label} redirect was refused`);
      }
      const text = await readBoundedResponse(response);
      let parsed;
      try { parsed = JSON.parse(text); } catch { throw new Error('AimForge returned non-JSON'); }
      if (!response.ok) {
        throw new Error(`AimForge ${label} was refused (${response.status})`);
      }
      const receipt = response.headers?.get?.('x-aimforge-action-receipt') ?? '';
      if (!/^[a-f0-9]{32}$/u.test(receipt)) {
        throw new Error('AimForge action receipt is missing or invalid');
      }
      return { parsed, status: response.status };
    } finally {
      combined.dispose();
    }
  }

  return Object.freeze({
    async getDispatchBoardSummary({ signedBridge, date = null, signal = null }) {
      const normalizedDate = validateDate(date);
      const result = await signedRequest({
        path: AIMFORGE_BOARD_SUMMARY_PATH,
        url: boardUrl,
        signedBridge,
        payload: { date: normalizedDate },
        signal,
        label: 'board summary',
      });
      return validateSummaryResponse(result.parsed);
    },
    async prepareDriverMessage({ signedBridge, subject, body, priority, signal = null }) {
      const input = validateDriverMessageInput({ subject, body, priority });
      const result = await signedRequest({
        path: AIMFORGE_PREPARE_DRIVER_MESSAGE_PATH,
        url: prepareUrl,
        signedBridge,
        payload: input,
        signal,
        label: 'driver-message proposal',
      });
      if (result.status !== 201 && result.status !== 202) {
        throw new Error(`AimForge driver-message proposal returned HTTP ${result.status}`);
      }
      return validatePrepareResponse(result.parsed, result.status);
    },
    async createDepartmentHandoff({ signedBridge, recipientRole, subject, body, priority, signal = null }) {
      const input = validateDepartmentHandoffInput({ recipientRole, subject, body, priority });
      const result = await signedRequest({
        path: AIMFORGE_DEPARTMENT_HANDOFF_PATH,
        url: departmentHandoffUrl,
        signedBridge,
        payload: input,
        signal,
        label: 'department handoff',
      });
      if (result.status !== 200 && result.status !== 201) {
        throw new Error(`AimForge department handoff returned HTTP ${result.status}`);
      }
      return validateDepartmentHandoffResponse(result.parsed, result.status);
    },
  });
}

/** Dedicated three-tool runtime for signed AimForge voice sessions. */
export function createAimForgeBoardToolRuntime({ client, signedBridge, workspace = process.cwd() }) {
  if (!client || typeof client.getDispatchBoardSummary !== 'function'
    || typeof client.prepareDriverMessage !== 'function'
    || typeof client.createDepartmentHandoff !== 'function') {
    throw new Error('AimForge action client is required');
  }
  const boardTool = Object.freeze({
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
  const prepareTool = Object.freeze({
    description: 'Prepare a driver SMS proposal for the assignment focused in the signed session. This does not approve, send, or deliver anything.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['subject', 'body', 'priority'],
      properties: {
        subject: { type: 'string', minLength: 1, maxLength: 120 },
        body: { type: 'string', minLength: 1, maxLength: 1400 },
        priority: { type: 'string', enum: ['normal', 'urgent'] },
      },
    },
    async execute(args, { signal = null } = {}) {
      const input = validateDriverMessageInput(args);
      const proposal = await client.prepareDriverMessage({ signedBridge, ...input, signal });
      return JSON.stringify(proposal);
    },
  });
  let turnNumber = 0;
  let currentTurnConfirmed = false;
  let pendingHandoff = null;
  const handoffTool = Object.freeze({
    description: 'Stage or persist an internal tenant department handoff. First call with confirmed=false to produce the confirmation summary. Only after the user explicitly confirms in a later turn may the same handoff be called with confirmed=true. This is internal inbox persistence, never SMS or provider delivery.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['recipientRole', 'subject', 'body', 'priority', 'confirmed'],
      properties: {
        recipientRole: { type: 'string', enum: DEPARTMENT_ROLES },
        subject: { type: 'string', minLength: 1, maxLength: 160 },
        body: { type: 'string', minLength: 1, maxLength: 4000 },
        priority: { type: 'string', enum: ['normal', 'urgent'] },
        confirmed: { type: 'boolean', description: 'False to stage and ask; true only after explicit user confirmation in a later turn.' },
      },
    },
    async execute(args, { signal = null } = {}) {
      const input = validateDepartmentHandoffInput(args, { includeConfirmation: true });
      const intent = { recipientRole: input.recipientRole, subject: input.subject, body: input.body, priority: input.priority };
      const intentDigest = sha256Hex(JSON.stringify(intent));
      if (!input.confirmed) {
        pendingHandoff = { intentDigest, stagedTurn: turnNumber };
        return JSON.stringify({ state: 'confirmation_required', ...intent });
      }
      if (!pendingHandoff || pendingHandoff.intentDigest !== intentDigest) {
        throw new Error('Stage this exact handoff with confirmed=false before asking for confirmation');
      }
      if (turnNumber <= pendingHandoff.stagedTurn) {
        throw new Error('Explicit confirmation must arrive in a later user turn');
      }
      if (turnNumber !== pendingHandoff.stagedTurn + 1) {
        throw new Error('The handoff must be restaged before asking for confirmation again');
      }
      if (!currentTurnConfirmed) {
        throw new Error('The latest user turn must explicitly confirm this internal handoff');
      }
      const receipt = await client.createDepartmentHandoff({ signedBridge, ...intent, signal });
      pendingHandoff = null;
      return JSON.stringify(receipt);
    },
  });
  const tools = Object.freeze({
    [AIMFORGE_BOARD_TOOL_NAME]: boardTool,
    [AIMFORGE_PREPARE_DRIVER_MESSAGE_TOOL_NAME]: prepareTool,
    [AIMFORGE_DEPARTMENT_HANDOFF_TOOL_NAME]: handoffTool,
  });
  return Object.freeze({
    // The agent loop uses root only for local provenance storage. It does not
    // add workspace tools; this runtime's advertised catalog remains fixed.
    root: workspace,
    permissionMode: 'read-tools',
    tools,
    beginTurn(userText = '') {
      turnNumber += 1;
      currentTurnConfirmed = isExplicitHandoffConfirmation(userText);
    },
    definitionsForOpenAi() {
      return Object.entries(tools).map(([name, tool]) => ({
        type: 'function', function: { name, description: tool.description, parameters: tool.parameters },
      }));
    },
    async execute(name, args, options = {}) {
      if (options.signal?.aborted) return 'The action was cancelled before it ran.';
      const tool = tools[name];
      if (!tool) return `Error: unknown tool ${name}`;
      try {
        return await tool.execute(args, options);
      } catch (error) {
        return `Error: ${error?.message ?? String(error)}`;
      }
    },
    async dispose() {},
  });
}
