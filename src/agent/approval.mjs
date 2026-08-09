import { redactSecrets } from './redact.mjs';

/**
 * Human-in-the-loop approval for the "ask" permission mode.
 *
 * Security posture: FAIL CLOSED. Every path that is not an explicit human
 * "allow" resolves to DENY — no approver, malformed answer, unknown decision
 * word, timeout, thrown approver, or shutdown while pending. There is
 * deliberately NO environment variable, argument, or event an agent can emit
 * that approves its own tool call: the only inputs that produce an allow are
 * a `permission_response` line from the host UI or a TTY answer from a human.
 */

export const ALLOW_ONCE = 'allow-once';
export const ALLOW_SESSION = 'allow-session';
export const DENY = 'deny';

/** Default wait for a human answer before denying (5 minutes). */
export const DEFAULT_ASK_TIMEOUT_MS = 300_000;

/**
 * Read the ask-mode timeout from the environment.
 * A missing, zero, negative, or non-numeric value falls back to the default
 * rather than disabling the timeout — "no timeout" would mean a dead UI could
 * hang a turn forever, which is the failure this guard exists to prevent.
 */
export function resolveAskTimeoutMs(raw = process.env.HELMION_ASK_TIMEOUT_MS) {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_ASK_TIMEOUT_MS;
  return Math.floor(n);
}

/**
 * Map any inbound answer to exactly one of the three decisions.
 * Anything unrecognized — undefined, null, an object, a typo, a hostile value —
 * becomes DENY. Callers never have to validate before calling this.
 */
export function normalizeDecision(raw) {
  let value = raw;
  // Tolerate {decision:"allow-once"} as well as a bare string.
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    value = value.decision ?? value.result ?? value.answer;
  }
  if (typeof value === 'boolean') return value ? ALLOW_ONCE : DENY;
  const s = String(value ?? '').trim().toLowerCase();
  switch (s) {
    case 'allow-once':
    case 'allow_once':
    case 'allow':
    case 'once':
    case 'approve':
    case 'yes':
    case 'y':
      return ALLOW_ONCE;
    case 'allow-session':
    case 'allow_session':
    case 'session':
    case 'always':
    case 'all':
    case 's':
      return ALLOW_SESSION;
    default:
      return DENY;
  }
}

/** True only for the two decisions that let a tool run. */
export function isAllowed(decision) {
  return decision === ALLOW_ONCE || decision === ALLOW_SESSION;
}

/**
 * One human-readable line describing the tool call being approved.
 * This is the text a person reads before deciding, so it shows the real path
 * and the real command rather than a generic "write_file" label. Secrets are
 * redacted because the line lands in a transcript.
 */
export function summarizeToolCall(tool, args, maxLength = 220) {
  const a = args && typeof args === 'object' ? args : {};
  let body;
  switch (tool) {
    case 'run_command':
      body = `run_command: ${String(a.command ?? '')}`;
      break;
    case 'write_file': {
      const bytes = Buffer.byteLength(String(a.content ?? ''), 'utf8');
      body = `write_file: ${String(a.path ?? '')} (${bytes} bytes)`;
      break;
    }
    case 'create_file': {
      const bytes = Buffer.byteLength(String(a.content ?? ''), 'utf8');
      body = `create_file: ${String(a.path ?? '')} (${bytes} bytes)`;
      break;
    }
    case 'edit_file':
      body = `edit_file: ${String(a.path ?? '')} (exact replacement)`;
      break;
    case 'run_project_task':
      body = `run_project_task: ${String(a.task_id ?? '')}`;
      break;
    case 'start_project_preview':
      body = `start_project_preview: ${String(a.path ?? '')}`;
      break;
    case 'stop_project_preview':
      body = 'stop_project_preview';
      break;
    case 'workspace_context':
      body = 'workspace_context';
      break;
    case 'read_file':
      body = `read_file: ${String(a.path ?? '')}`;
      break;
    case 'list_dir':
      body = `list_dir: ${String(a.path ?? '.')}`;
      break;
    case 'search_text':
      body = `search_text: ${JSON.stringify(a.query ?? '')} in ${String(a.path ?? '.')}`;
      break;
    default:
      try {
        body = `${tool}: ${JSON.stringify(a)}`;
      } catch {
        body = `${tool}: (unserializable arguments)`;
      }
  }
  const clean = redactSecrets(body).replace(/\s+/g, ' ').trim();
  return clean.length > maxLength ? `${clean.slice(0, maxLength)}…` : clean;
}

/** Args as they travel to the UI: redacted and length-capped. */
export function safeArgsForDisplay(args, maxLength = 2000) {
  let json;
  try {
    json = JSON.stringify(args ?? {});
  } catch {
    return '{}';
  }
  const clean = redactSecrets(json);
  return clean.length > maxLength ? `${clean.slice(0, maxLength)}…` : clean;
}

/**
 * Broker that turns an event/response protocol into an async approver function.
 *
 * `emit` writes one protocol event; the host is responsible for delivering
 * `permission_response` messages back through `handleResponse`.
 *
 * @param {{ emit: (obj: any) => void, timeoutMs?: number }} options
 */
export function createApprovalBroker({ emit, timeoutMs = resolveAskTimeoutMs() } = {}) {
  if (typeof emit !== 'function') {
    throw new TypeError('createApprovalBroker requires an emit function');
  }
  const wait = Number.isFinite(timeoutMs) && timeoutMs > 0
    ? Math.floor(timeoutMs)
    : DEFAULT_ASK_TIMEOUT_MS;

  const pending = new Map();
  let sequence = 0;

  async function approver({ tool, args, workspace, permissionMode } = {}) {
    sequence += 1;
    const id = `perm-${sequence}-${Date.now().toString(36)}`;

    return new Promise((resolve) => {
      let settled = false;
      let timer = null;

      const settle = (decision, source) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        pending.delete(id);
        emit({
          event: 'permission_decision',
          id,
          tool,
          decision,
          source,
        });
        resolve(decision);
      };

      pending.set(id, { settle, tool });

      // Announce only after the pending entry exists, so a response that comes
      // back synchronously (a scripted host, a test) still finds its id.
      emit({
        event: 'permission_request',
        id,
        tool,
        summary: summarizeToolCall(tool, args),
        args: safeArgsForDisplay(args),
        workspace: workspace ?? null,
        permission: permissionMode ?? 'ask',
        timeoutMs: wait,
      });

      if (settled) return;
      timer = setTimeout(() => settle(DENY, 'timeout'), wait);
    });
  }

  /**
   * Deliver a `permission_response` from the host.
   * @returns {boolean} false when the id is unknown (late, duplicate, or forged)
   */
  function handleResponse(message) {
    const id = typeof message?.id === 'string' ? message.id : String(message?.id ?? '');
    const entry = pending.get(id);
    if (!entry) return false;
    entry.settle(normalizeDecision(message?.decision), 'user');
    return true;
  }

  /** Fail every in-flight request closed — used on shutdown/reset. */
  function denyAllPending(source = 'cancelled') {
    for (const entry of [...pending.values()]) {
      entry.settle(DENY, source);
    }
  }

  return {
    approver,
    handleResponse,
    denyAllPending,
    timeoutMs: wait,
    get pendingCount() {
      return pending.size;
    },
  };
}
