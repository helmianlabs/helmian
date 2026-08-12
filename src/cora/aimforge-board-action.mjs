import { createHash, createHmac, randomUUID } from 'node:crypto';

export const AIMFORGE_BOARD_SUMMARY_PATH = '/api/helmian/actions/dispatch-board-summary';
export const AIMFORGE_PREPARE_DRIVER_MESSAGE_PATH = '/api/helmian/actions/prepare-driver-message';
export const AIMFORGE_DEPARTMENT_HANDOFF_PATH = '/api/helmian/actions/department-handoff';
export const AIMFORGE_EQUIPMENT_SAFETY_STATUS_PATH = '/api/helmian/actions/equipment-safety-status';
export const AIMFORGE_EQUIPMENT_SAFETY_CHECK_PATH = '/api/helmian/actions/equipment-safety-check';
export const AIMFORGE_EQUIPMENT_SAFETY_ESCALATION_PATH = '/api/helmian/actions/equipment-safety-escalation';
export const AIMFORGE_CONSOLE_NAVIGATION_INTENT_PATH = '/api/helmian/actions/console-navigation-intent';
export const AIMFORGE_BOARD_TOOL_NAME = 'aimforge_get_dispatch_board_summary';
export const AIMFORGE_PREPARE_DRIVER_MESSAGE_TOOL_NAME = 'aimforge_prepare_driver_message';
export const AIMFORGE_DEPARTMENT_HANDOFF_TOOL_NAME = 'aimforge_create_department_handoff';
export const AIMFORGE_EQUIPMENT_SAFETY_STATUS_TOOL_NAME = 'aimforge_get_equipment_safety_status';
export const AIMFORGE_EQUIPMENT_SAFETY_CHECK_TOOL_NAME = 'aimforge_record_equipment_safety_check';
export const AIMFORGE_EQUIPMENT_SAFETY_ESCALATION_TOOL_NAME = 'aimforge_request_safety_supervisor_review';
export const AIMFORGE_CONSOLE_NAVIGATION_TOOL_NAME = 'aimforge_create_console_navigation_intent';
export const AIMFORGE_CONSOLE_NAVIGATION_PAGES = Object.freeze(['dashboard', 'dispatch_board', 'load_planner']);
export const AIMFORGE_EQUIPMENT_SAFETY_TOOL_NAMES = Object.freeze([
  AIMFORGE_EQUIPMENT_SAFETY_STATUS_TOOL_NAME,
  AIMFORGE_EQUIPMENT_SAFETY_CHECK_TOOL_NAME,
  AIMFORGE_EQUIPMENT_SAFETY_ESCALATION_TOOL_NAME,
]);
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

function validateSafetyCheckInput(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).sort().join(',') !== 'checkKey,notes,result,structuredData') {
    throw new Error('Only checkKey, result, notes, and structuredData are allowed');
  }
  const checkKey = typeof value.checkKey === 'string' ? value.checkKey.trim() : '';
  const notes = value.notes === null ? null : typeof value.notes === 'string' ? value.notes.trim() : undefined;
  const results = ['OK', 'DEFECT_MINOR', 'DEFECT_MAJOR', 'DEFECT_OOS', 'NOT_APPLICABLE'];
  if (!checkKey || checkKey.length > 80 || !results.includes(value.result)
    || notes === undefined || (notes?.length ?? 0) > 500
    || !value.structuredData || typeof value.structuredData !== 'object' || Array.isArray(value.structuredData)
    || Object.keys(value.structuredData).length > 12) throw new Error('Safety check arguments are invalid');
  for (const entry of Object.values(value.structuredData)) {
    if (!['string', 'number', 'boolean'].includes(typeof entry) || (typeof entry === 'string' && entry.length > 100)) {
      throw new Error('Safety structured data is invalid');
    }
  }
  return { checkKey, result: value.result, notes, structuredData: value.structuredData };
}

function validateSafetyResponse(value, action, state, status) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || value.version !== '1' || value.action !== action || value.state !== state) {
    throw new Error('AimForge returned an invalid safety receipt');
  }
  if (action === 'equipment.safety.status') {
    if (status !== 200 || !['PENDING', 'DEFECT', 'HOLD'].includes(value.disposition)
      || !['dry_van', 'reefer', 'flatbed'].includes(value.equipmentType)
      || !Array.isArray(value.checks) || value.checks.length > 32
      || !Array.isArray(value.recordedChecks) || value.recordedChecks.length > 128) {
      throw new Error('AimForge returned an invalid safety status');
    }
    return Object.freeze(value);
  }
  if (status !== 201 || !/^[0-9a-f-]{36}$/iu.test(value.inspectionItemId)
    || !['PENDING', 'DEFECT', 'HOLD'].includes(value.disposition)
    || (action === 'equipment.safety.escalation' && value.disposition !== 'HOLD')) {
    throw new Error('AimForge returned an invalid safety write receipt');
  }
  return Object.freeze({ state: value.state, disposition: value.disposition, inspectionItemId: value.inspectionItemId });
}

function validateNavigationInput(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).sort().join(',') !== 'page'
    || !AIMFORGE_CONSOLE_NAVIGATION_PAGES.includes(value.page)) {
    throw new Error('Only one allowlisted page is allowed');
  }
  return { page: value.page };
}

function validateNavigationResponse(value, status) {
  if (status !== 201 || !value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).sort().join(',') !== 'action,execution,intent,state,version'
    || value.version !== '1' || value.action !== 'console.navigation.intent.create'
    || value.state !== 'intent_created' || value.execution !== 'not_executed') {
    throw new Error('AimForge returned an invalid navigation intent');
  }
  const intent = value.intent;
  const paths = { dashboard: '/dashboard', dispatch_board: '/dispatch', load_planner: '/schedule' };
  if (!intent || typeof intent !== 'object' || Array.isArray(intent)
    || Object.keys(intent).sort().join(',') !== 'page,path,replace,type,version'
    || intent.type !== 'aimforge.console.navigate' || intent.version !== '1'
    || !AIMFORGE_CONSOLE_NAVIGATION_PAGES.includes(intent.page)
    || intent.path !== paths[intent.page] || intent.replace !== false) {
    throw new Error('AimForge returned an invalid navigation intent projection');
  }
  return Object.freeze({ state: value.state, execution: value.execution, intent: Object.freeze({ ...intent }) });
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
  const safetyStatusUrl = fixedActionUrl(baseUrl, AIMFORGE_EQUIPMENT_SAFETY_STATUS_PATH);
  const safetyCheckUrl = fixedActionUrl(baseUrl, AIMFORGE_EQUIPMENT_SAFETY_CHECK_PATH);
  const safetyEscalationUrl = fixedActionUrl(baseUrl, AIMFORGE_EQUIPMENT_SAFETY_ESCALATION_PATH);
  const navigationUrl = fixedActionUrl(baseUrl, AIMFORGE_CONSOLE_NAVIGATION_INTENT_PATH);
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
    async getEquipmentSafetyStatus({ signedBridge, signal = null }) {
      const result = await signedRequest({ path: AIMFORGE_EQUIPMENT_SAFETY_STATUS_PATH, url: safetyStatusUrl,
        signedBridge, payload: {}, signal, label: 'equipment safety status' });
      return validateSafetyResponse(result.parsed, 'equipment.safety.status', 'active', result.status);
    },
    async recordEquipmentSafetyCheck({ signedBridge, signal = null, ...args }) {
      const input = validateSafetyCheckInput(args);
      const result = await signedRequest({ path: AIMFORGE_EQUIPMENT_SAFETY_CHECK_PATH, url: safetyCheckUrl,
        signedBridge, payload: input, signal, label: 'equipment safety check' });
      return validateSafetyResponse(result.parsed, 'equipment.safety.check', 'recorded', result.status);
    },
    async requestSafetySupervisorReview({ signedBridge, checkKey, reason, signal = null }) {
      const key = typeof checkKey === 'string' ? checkKey.trim() : '';
      const cleanReason = typeof reason === 'string' ? reason.trim() : '';
      if (!key || key.length > 80 || !cleanReason || cleanReason.length > 500) throw new Error('Safety escalation arguments are invalid');
      const result = await signedRequest({ path: AIMFORGE_EQUIPMENT_SAFETY_ESCALATION_PATH, url: safetyEscalationUrl,
        signedBridge, payload: { checkKey: key, reason: cleanReason }, signal, label: 'safety supervisor review' });
      return validateSafetyResponse(result.parsed, 'equipment.safety.escalation', 'supervisor_review_requested', result.status);
    },
    async createConsoleNavigationIntent({ signedBridge, page, signal = null }) {
      const input = validateNavigationInput({ page });
      const result = await signedRequest({ path: AIMFORGE_CONSOLE_NAVIGATION_INTENT_PATH, url: navigationUrl,
        signedBridge, payload: input, signal, label: 'console navigation intent' });
      return validateNavigationResponse(result.parsed, result.status);
    },
  });
}

/** Dedicated three-tool runtime for signed AimForge voice sessions. */
export function createAimForgeBoardToolRuntime({
  client,
  signedBridge,
  workspace = process.cwd(),
  enabledToolNames = [
    AIMFORGE_BOARD_TOOL_NAME,
    AIMFORGE_PREPARE_DRIVER_MESSAGE_TOOL_NAME,
    AIMFORGE_DEPARTMENT_HANDOFF_TOOL_NAME,
    AIMFORGE_CONSOLE_NAVIGATION_TOOL_NAME,
  ],
}) {
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
  const safetyStatusTool = Object.freeze({
    description: 'Read or initialize the safety workflow for the server-focused active driver assignment. Takes no identifiers and returns server-approved guidance and current disposition.',
    parameters: { type: 'object', additionalProperties: false, properties: {} },
    async execute(args, { signal = null } = {}) {
      if (Object.keys(args ?? {}).length) throw new Error('Safety status takes no arguments');
      return JSON.stringify(await client.getEquipmentSafetyStatus({ signedBridge, signal }));
    },
  });
  const safetyCheckTool = Object.freeze({
    description: 'Record exactly one server-manifest-approved equipment safety check for the signed current assignment. Speak success only from the returned receipt. This cannot release or bypass a hold.',
    parameters: { type: 'object', additionalProperties: false, required: ['checkKey', 'result', 'notes', 'structuredData'], properties: {
      checkKey: { type: 'string', minLength: 1, maxLength: 80 },
      result: { type: 'string', enum: ['OK', 'DEFECT_MINOR', 'DEFECT_MAJOR', 'DEFECT_OOS', 'NOT_APPLICABLE'] },
      notes: { type: ['string', 'null'], maxLength: 500 },
      structuredData: { type: 'object', maxProperties: 12, additionalProperties: { type: ['string', 'number', 'boolean'] } },
    } },
    async execute(args, { signal = null } = {}) {
      return JSON.stringify(await client.recordEquipmentSafetyCheck({ signedBridge, ...validateSafetyCheckInput(args), signal }));
    },
  });
  const safetyEscalationTool = Object.freeze({
    description: 'Request human supervisor review and place/retain a safety hold for one server-manifest-approved check. This cannot release, approve, or bypass a hold.',
    parameters: { type: 'object', additionalProperties: false, required: ['checkKey', 'reason'], properties: {
      checkKey: { type: 'string', minLength: 1, maxLength: 80 }, reason: { type: 'string', minLength: 1, maxLength: 500 },
    } },
    async execute(args, { signal = null } = {}) {
      if (!args || typeof args !== 'object' || Array.isArray(args) || Object.keys(args).sort().join(',') !== 'checkKey,reason') throw new Error('Only checkKey and reason are allowed');
      return JSON.stringify(await client.requestSafetySupervisorReview({ signedBridge, checkKey: args.checkKey, reason: args.reason, signal }));
    },
  });
  const navigationTool = Object.freeze({
    description: 'Create a typed intent for one allowlisted AimForge console page. This does not move the browser; never claim navigation completed.',
    parameters: { type: 'object', additionalProperties: false, required: ['page'], properties: {
      page: { type: 'string', enum: AIMFORGE_CONSOLE_NAVIGATION_PAGES },
    } },
    async execute(args, { signal = null } = {}) {
      return JSON.stringify(await client.createConsoleNavigationIntent({ signedBridge, ...validateNavigationInput(args), signal }));
    },
  });
  const availableTools = Object.freeze({
    [AIMFORGE_BOARD_TOOL_NAME]: boardTool,
    [AIMFORGE_PREPARE_DRIVER_MESSAGE_TOOL_NAME]: prepareTool,
    [AIMFORGE_DEPARTMENT_HANDOFF_TOOL_NAME]: handoffTool,
    [AIMFORGE_EQUIPMENT_SAFETY_STATUS_TOOL_NAME]: safetyStatusTool,
    [AIMFORGE_EQUIPMENT_SAFETY_CHECK_TOOL_NAME]: safetyCheckTool,
    [AIMFORGE_EQUIPMENT_SAFETY_ESCALATION_TOOL_NAME]: safetyEscalationTool,
    [AIMFORGE_CONSOLE_NAVIGATION_TOOL_NAME]: navigationTool,
  });
  if (!Array.isArray(enabledToolNames)
    || enabledToolNames.some((name) => typeof name !== 'string' || !Object.hasOwn(availableTools, name))
    || new Set(enabledToolNames).size !== enabledToolNames.length) {
    throw new Error('AimForge enabled tool policy is invalid');
  }
  const enabled = new Set(enabledToolNames);
  const tools = Object.freeze(Object.fromEntries(
    Object.entries(availableTools).filter(([name]) => enabled.has(name)),
  ));
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
