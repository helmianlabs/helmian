// CORA -> HELMIAN: the Custom Language Model backend used both by the local
// desktop runtime and the separately deployed Helmian Cloud voice endpoint.
// Remote binds are refused unless a token is configured; a Hume configuration
// is therefore a named, authenticated entry point rather than an open agent.
//
// WHAT THIS IS. Hume EVI can be configured to get its words from YOUR server
// instead of a hosted model: EVI dials a WebSocket, sends the conversation (with
// its prosody reading of how the speaker sounded), and waits for
// `assistant_input` chunks followed by `assistant_end`. That contract lives in
// src/cora/clm-protocol.mjs, with its primary sources cited there.
//
// WHAT MAKES IT HELMION RATHER THAN A CHATBOT. The words do not come from a raw
// model call. They come from `runAgentTurn` — the SAME orchestration the CLI
// REPL (src/agent/session.mjs:419) and the desktop EXE bridge
// (src/agent/bridge.mjs:419) use. So a spoken sentence runs the real tool loop
// against the real workspace, under the real permission gate, and the real
// provenance ledger records which model answered. Nothing about voice gets its
// own softer path; that is the entire point.
//
// THE ONE INVARIANT THAT MATTERS MOST: EXACTLY ONE `assistant_end` PER TURN.
// EVI hands the conversational turn to the CLM and does not take it back until
// `assistant_end` arrives. Miss it once — a thrown error, a provider timeout, a
// malformed frame — and the user's microphone is dead for the rest of the chat
// with no error anywhere. Every path out of `handleTurn` therefore goes through
// one `finally`, and `endTurn` is idempotent. This is tested directly, including
// the throwing path.
//
// HISTORY: WHOSE COPY WINS. Hume re-sends the whole conversation on every turn,
// and `runAgentTurn` also keeps its own `messages` array. Feeding Hume's copy in
// as well would double every utterance. Helmion's copy is the one kept, because
// it is strictly richer: it contains the tool calls and tool results, which
// Hume never sees and which are most of what makes the next turn correct. Only
// the newest user utterance is taken from the incoming payload.
//
// SCOPE. Phase 1 is local. There is no multi-tenant anything here, and the
// access rule below refuses to bind a tool-capable socket to a non-loopback
// address without a token rather than leaving that to a later deployment note.

import { createServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { isIPv4, isIPv6 } from 'node:net';

import { loadHelmionEnv, resolveProvider } from '../agent/env.mjs';
import { createSessionState, isAbortError, runAgentTurn } from '../agent/loop.mjs';
import { attachWebSocketServer, CLOSE } from './ws-server.mjs';
import {
  DEFAULT_MAX_SPOKEN_CHARS,
  DEFAULT_SPEECH_CHUNK_CHARS,
  annotateWithProsody,
  applySpokenBudget,
  assistantEnd,
  assistantInput,
  isStopIntent,
  parseHumePayload,
  speakableText,
  splitForSpeech,
  topProsody,
} from './clm-protocol.mjs';
import { recordVoiceSessionAuthorization, recordVoiceTurn } from './activity.mjs';
import {
  AIMFORGE_BRIDGE_MARKER,
  authorizeAimForgeBridgeReceipt,
  verifyAimForgeSessionBridge,
} from './aimforge-session-bridge.mjs';
import { createBackgroundAgentNotifier } from './notify.mjs';
import { inspectCoraProviderReadiness } from './provider-readiness.mjs';
import {
  createAimForgeBoardActionClient,
  createAimForgeBoardToolRuntime,
  AIMFORGE_EQUIPMENT_SAFETY_TOOL_NAMES,
} from './aimforge-board-action.mjs';
import {
  CORA_HEALTH_DIAGNOSTICS_SCHEMA_VERSION,
  MAX_CORA_HEALTH_AGE_MS,
  MAX_CORA_HEALTH_DETAIL_SESSIONS,
  MAX_CORA_HEALTH_PHASE_COUNT,
} from './health-schema.mjs';
import {
  authorizeSessionConnection,
  DEFAULT_MAX_SESSION_ID_CHARS,
  validateSessionId,
} from './session-context.mjs';

/**
 * Deliberately NOT 8788. A ws server on :8788 that spawned a coding agent with
 * permissions off is a known finding on this machine (2026-07-29 security
 * audit); reusing the port would make this indistinguishable from it in a
 * netstat. 7421 sits next to Herald's 7420 so the local Helmion family is
 * contiguous and recognisable.
 */
export const DEFAULT_CORA_PORT = 7421;

/** Hume's own example serves the CLM socket at /llm; keep the convention. */
export const DEFAULT_CORA_PATH = '/llm';

/** Read-only local readiness endpoint; it never returns credentials or paths. */
export const DEFAULT_CORA_HEALTH_PATH = '/healthz';

// Keep the default policy local to the CLM entrypoint so an older packaged
// WebSocket helper cannot make the service fail during module linking. An
// empty list is fail-closed: browser origins are allowed only when explicitly
// supplied by the caller.
const DEFAULT_ALLOWED_ORIGINS = Object.freeze([]);

// Re-export contract bounds for existing local consumers and focused tests.
export {
  MAX_CORA_HEALTH_DETAIL_SESSIONS,
  MAX_CORA_HEALTH_PHASE_COUNT,
} from './health-schema.mjs';

/** Legacy local marker; production AimForge sessions require a verified bridge. */
export const HELMION_SESSION_PREFIX = 'helmion';

/** How long one spoken turn may hold the conversation before it is released. */
export const DEFAULT_TURN_TIMEOUT_MS = 120_000;

/** Sessions idle longer than this are dropped, releasing their tool runtime. */
export const DEFAULT_SESSION_IDLE_MS = 30 * 60_000;

export const DEFAULT_MAX_SESSIONS = 8;

export const AIMFORGE_HAND_LABELS = Object.freeze({
  aimforge_get_dispatch_board_summary: 'read aggregate dispatch-board counts',
  aimforge_prepare_driver_message: 'prepare a driver message proposal for the already-focused assignment; it is not sent',
  aimforge_create_department_handoff: 'stage an internal department handoff that requires a later explicit confirmation',
  aimforge_get_equipment_safety_status: 'read the server-approved equipment-safety workflow and current disposition',
  aimforge_record_equipment_safety_check: 'record one server-manifest-approved equipment safety check',
  aimforge_request_safety_supervisor_review: 'request human supervisor review and place or retain a safety hold',
});

export function buildAimForgeSessionPrompt({ bridgeContext = null, enabledToolNames = [] } = {}) {
  const enabled = Array.isArray(enabledToolNames)
    ? enabledToolNames.filter((name) => Object.hasOwn(AIMFORGE_HAND_LABELS, name))
    : [];
  const hands = enabled.map((name) => AIMFORGE_HAND_LABELS[name]);
  const scope = bridgeContext?.surface === 'mobile' && bridgeContext?.role === 'driver'
    ? 'This is a driver mobile session.'
    : 'This is an operations session.';
  const capability = hands.length
    ? `For this session you can ${hands.join('; ')}.`
    : 'No AimForge action hands are enabled for this session. You may explain status, but you must not claim to have changed anything.';
  return [
    'You are Cora for AimForge.',
    scope,
    capability,
    'Speak success only from an API receipt.',
    'If an internal handoff hand is enabled, call confirmed=false first and only call confirmed=true after the user explicitly confirms in a later turn (the immediately following user turn).',
    'You cannot release or approve holds, send or deliver messages, choose tenants, drivers, assignments, profiles, citations, providers, URLs, or arbitrary records.',
    'You have no generic HTTP, shell, workspace, navigation, or arbitrary record-change tool.',
  ].join(' ');
}

/**
 * "Helmion mode", marked the way the task requires: on Hume's
 * `custom_session_id`. A legacy local marker selects the configured local
 * runtime. Production AimForge sessions additionally require a signed bridge;
 * only a verified bridge receives the dedicated fixed-path board-summary tool.
 * Anything else — including a session with no id at all — gets a read-only
 * chat runtime.
 *
 * FAILING CLOSED IS THE WHOLE VALUE OF THIS FUNCTION. An unmarked session is
 * the case where nobody stated an intent, and "nobody stated an intent" must
 * not mean "may run shell commands by voice".
 */
export function isHelmionSession(customSessionId, prefix = HELMION_SESSION_PREFIX) {
  const id = String(customSessionId ?? '').trim().toLowerCase();
  if (!id) return false;
  const marker = String(prefix).trim().toLowerCase();
  if (!marker) return false;
  return id === marker || id.startsWith(`${marker}:`) || id.startsWith(`${marker}-`);
}

/** Loopback in the forms a host string actually arrives in. */
export function isLoopbackHost(host) {
  const h = String(host ?? '').trim().toLowerCase().replace(/^\[|\]$/g, '');
  if (!h) return false;
  if (h === 'localhost') return true;
  if (h === '::1') return true;
  if (isIPv4(h)) return h.startsWith('127.');
  if (isIPv6(h)) return h === '::1' || h === '::ffff:127.0.0.1';
  return false;
}

/** Constant-time compare that does not leak length through an early return. */
function tokenMatches(expected, presented) {
  const a = Buffer.from(String(expected ?? ''), 'utf8');
  const b = Buffer.from(String(presented ?? ''), 'utf8');
  if (a.length === 0 || a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** Bearer auth for the HTTP health endpoint. WebSocket auth remains query-based. */
function requestBearerToken(request) {
  const header = request?.headers?.authorization;
  if (typeof header !== 'string') return '';
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match?.[1]?.trim() ?? '';
}

/**
 * Decide whether this bind is allowed at all, BEFORE the port is opened.
 *
 * A legacy local session can reach `run_command`. Binding it to 0.0.0.0 with
 * no credential would put an unauthenticated remote-shell on the LAN, which is
 * exactly the defect already recorded against another local ws server on this
 * machine. Signed AimForge sessions never receive that runtime, but the socket
 * still fails closed for every mode at startup.
 *
 * @returns {{ requiresToken: boolean }}
 * @throws when the configuration would expose an unauthenticated agent
 */
export function resolveAccess({ host, token }) {
  const loopback = isLoopbackHost(host);
  const hasToken = Boolean(String(token ?? '').trim());
  if (!loopback && !hasToken) {
    throw new Error(
      `Refusing to bind the Cora CLM socket to ${host}: it can run tools, and a `
      + 'non-loopback bind without a token is an unauthenticated agent on the '
      + 'network. Pass a token, or bind 127.0.0.1 (the default).',
    );
  }
  return { requiresToken: hasToken };
}

/**
 * The real turn runner: Helmion's own agent loop, unchanged.
 *
 * Read-only sessions get `permissionMode: 'read-only'`, which
 * createToolRuntime turns into an empty tool catalog, so an unmarked chat
 * cannot touch the disk however persuasive it is.
 */
export function createAgentTurnRunner({
  workspace,
  provider,
  permissionMode = 'read-tools',
  tier = 'standard',
  safeWorkspaceTools = true,
  aimforgeActionClient = null,
  globalActionPolicyResolver = null,
}) {
  return async function runTurn({ text, session, onEvent, signal = null }) {
    if (!session.state) {
      if (session.bridgeContext) {
        if (!aimforgeActionClient) {
          throw new Error('Signed AimForge actions are unavailable: the fixed action client is not configured.');
        }
        const actionPolicy = globalActionPolicyResolver
          ? await globalActionPolicyResolver()
          : null;
        if (globalActionPolicyResolver && !Array.isArray(actionPolicy?.enabledActions)) {
          throw new Error('Signed AimForge action policy is unavailable or invalid.');
        }
        const runtime = createAimForgeBoardToolRuntime({
          client: aimforgeActionClient,
          signedBridge: session.signedBridge,
          workspace,
          ...(session.bridgeContext.role === 'driver'
            && session.bridgeContext.surface === 'mobile'
            ? { enabledToolNames: session.bridgeContext.focusedAssignmentId
              ? AIMFORGE_EQUIPMENT_SAFETY_TOOL_NAMES.filter((name) => !actionPolicy || actionPolicy.enabledActions.includes(name))
              : [] }
            : (actionPolicy ? { enabledToolNames: actionPolicy.enabledActions } : {})),
        });
        session.state = {
          runtime,
          permissionMode: runtime.permissionMode,
          messages: [{
            role: 'system',
            content: buildAimForgeSessionPrompt({
              bridgeContext: session.bridgeContext,
              enabledToolNames: Object.keys(runtime.tools ?? {}),
            }),
          }],
        };
      } else {
        session.state = createSessionState(workspace, {
          permissionMode: session.helmionMode ? permissionMode : 'read-only',
          safeWorkspaceTools,
        });
      }
    }
    session.state.runtime.beginTurn?.(text);
    return runAgentTurn({
      userText: text,
      messages: session.state.messages,
      provider,
      runtime: session.state.runtime,
      onEvent,
      tier,
      // The kill switch. Without this line every other part of the cancel path
      // is decoration: the agent loop would keep calling models and running
      // tools no matter what the socket had been told.
      signal,
      // Groups every provenance row for this chat under the id Hume gave us, so
      // "which model answered me on that call" is answerable from the ledger.
      sessionId: session.id,
    });
  };
}

/**
 * Start the local CLM backend.
 *
 * `runTurn` is injectable so the protocol half can be proven without a model;
 * when it is omitted the real agent loop is used and a provider key is
 * required, which is the correct failure to hit loudly at startup rather than
 * silently on the first spoken word.
 */
export async function startCoraClm({
  workspace = process.cwd(),
  host = '127.0.0.1',
  port = DEFAULT_CORA_PORT,
  path = DEFAULT_CORA_PATH,
  healthPath = DEFAULT_CORA_HEALTH_PATH,
  token = null,
  bridgeSecret = process.env.HELMION_AIMFORGE_BRIDGE_SECRET ?? null,
  // Cloud/non-loopback deployments must accept only signed AimForge context.
  // Loopback keeps the legacy marker for local self-test/development only.
  requireSignedSessions = !isLoopbackHost(host),
  providerName = 'claude',
  provider = null,
  permissionMode = 'read-tools',
  tier = 'standard',
  safeWorkspaceTools = true,
  sessionPrefix = HELMION_SESSION_PREFIX,
  runTurn = null,
  activitySink = recordVoiceTurn,
  authorizationActivitySink = recordVoiceSessionAuthorization,
  includeProsody = true,
  speakToolProgress = true,
  maxSpokenChars = DEFAULT_MAX_SPOKEN_CHARS,
  speechChunkChars = DEFAULT_SPEECH_CHUNK_CHARS,
  turnTimeoutMs = DEFAULT_TURN_TIMEOUT_MS,
  sessionIdleMs = DEFAULT_SESSION_IDLE_MS,
  maxSessions = DEFAULT_MAX_SESSIONS,
  maxSessionIdChars = DEFAULT_MAX_SESSION_ID_CHARS,
  // Browser origins allowed to open this socket. Empty = every browser
  // refused, non-browser peers judged on their token. See ws-server.mjs.
  allowedOrigins = DEFAULT_ALLOWED_ORIGINS,
  // Background-agent completion notices. Injectable so a test drives the exact
  // transitions instead of sleeping past a 5-second poll and hoping.
  notifyBackgroundAgents = true,
  notifier = null,
  notifyPollMs = undefined,
  deliverNotification = null,
  // Attempt an unprompted spoken notice on an idle socket. See speakUnprompted
  // below — undocumented in Hume's CLM guide and unverified against a live
  // config, which is why it degrades to the guaranteed next-turn path rather
  // than being relied on.
  speakNotificationsUnprompted = true,
  // Optional authenticated HTTP surface sharing this process/port. The
  // handler must return true after it has written a response, or false to let
  // the CLM health/WebSocket fallback handle the request.
  httpRequestHandler = null,
  globalActionPolicyResolver = null,
  logger = () => {},
  providerSessionUsageSink = null,
  publishedConfigResolver = null,
} = {}) {
  const { requiresToken } = resolveAccess({ host, token });
  if (requireSignedSessions && Buffer.byteLength(String(bridgeSecret ?? ''), 'utf8') < 32) {
    throw new Error(
      'Refusing to start signed Cora sessions without '
      + 'HELMION_AIMFORGE_BRIDGE_SECRET (minimum 32 bytes).',
    );
  }
  const statusPath = String(healthPath || DEFAULT_CORA_HEALTH_PATH).startsWith('/')
    ? String(healthPath || DEFAULT_CORA_HEALTH_PATH)
    : `/${String(healthPath)}`;

  let activeProvider = provider;
  let turn = runTurn;
  let providerReadiness;
  if (!turn) {
    if (!activeProvider) {
      const env = loadHelmionEnv(workspace);
      activeProvider = resolveProvider(providerName, env);
    }
    providerReadiness = inspectCoraProviderReadiness({
      providerName,
      provider: activeProvider,
    });
    if (!providerReadiness.ready) {
      if (providerReadiness.state === 'invalid-configuration') {
        throw new Error('Invalid live-provider configuration for Cora.');
      }
      throw new Error(
        `No API key for ${activeProvider?.label ?? providerName}. Cora speaks with `
        + 'Helmion\'s own provider chain; set the matching key in .env '
        + '(ANTHROPIC_API_KEY for Claude/Sonnet).',
      );
    }
    const actionConfigured = Boolean(
      String(process.env.HELMION_AIMFORGE_API_BASE_URL ?? '').trim()
      || String(process.env.HELMION_AIMFORGE_ACTION_SECRET ?? '').trim(),
    );
    const aimforgeActionClient = (requireSignedSessions || actionConfigured)
      ? createAimForgeBoardActionClient()
      : null;
    turn = createAgentTurnRunner({
      workspace, provider: activeProvider, permissionMode, tier, safeWorkspaceTools,
      aimforgeActionClient,
      globalActionPolicyResolver,
    });
  } else {
    providerReadiness = inspectCoraProviderReadiness({
      providerName,
      provider: activeProvider,
      runTurn: turn,
    });
  }

  /** @type {Map<string, {id, key, helmionMode, state, queue, lastSeen, turns}>} */
  const sessions = new Map();
  /** A receipt may bind to one session/socket for its full signed lifetime. */
  const bridgeReceipts = new Map();

  const evictIdle = () => {
    const nowSeconds = Math.floor(Date.now() / 1_000);
    for (const [receiptId, receipt] of bridgeReceipts) {
      if (receipt.expiresAt <= nowSeconds) bridgeReceipts.delete(receiptId);
    }
    const cutoff = Date.now() - sessionIdleMs;
    for (const [key, session] of sessions) {
      if (session.lastSeen < cutoff) {
        void session.state?.runtime?.dispose?.();
        sessions.delete(key);
      }
    }
  };

  const sessionFor = async (customSessionId, connectionId) => {
    evictIdle();
    const isSignedShape = String(customSessionId ?? '').startsWith(AIMFORGE_BRIDGE_MARKER);
    const verification = (requireSignedSessions || isSignedShape)
      ? verifyAimForgeSessionBridge(customSessionId, { secret: bridgeSecret })
      : { ok: false, reason: null };
    if (requireSignedSessions && !verification.ok) {
      return { session: null, refused: verification.reason, bridgeContext: null };
    }
    // When a verification secret is configured, a claimed signed marker is
    // never downgraded to the old local marker path after a bad signature.
    if (isSignedShape && bridgeSecret && !verification.ok) {
      return { session: null, refused: verification.reason, bridgeContext: null };
    }

    const bridgeContext = verification.ok ? verification.context : null;
    let sessionConfig = null;
    if (bridgeContext && requireSignedSessions) {
      if (typeof publishedConfigResolver !== 'function') return { session: null, refused: 'published Organization Cora config resolver is unavailable', bridgeContext: null };
      try {
        sessionConfig = await publishedConfigResolver({ ...bridgeContext, verified: true });
      } catch (error) {
        return { session: null, refused: error?.code ?? 'published Organization Cora config is unavailable', bridgeContext: null };
      }
    }
    if (bridgeContext) {
      const receiptAccess = authorizeAimForgeBridgeReceipt(
        bridgeReceipts, bridgeContext, connectionId,
      );
      if (!receiptAccess.ok) {
        return {
          session: null,
          refused: receiptAccess.reason,
          bridgeContext: null,
        };
      }
    }

    const key = bridgeContext
      ? `aimforge:${bridgeContext.sessionId}`
      : (customSessionId ?? `socket:${connectionId}`);
    let session = sessions.get(key);
    const access = authorizeSessionConnection(session, connectionId);
    if (!access.ok) {
      return { session: null, refused: access.reason, bridgeContext: null };
    }
    if (!session) {
      if (sessions.size >= maxSessions) {
        // Drop the least recently used rather than refusing the live caller.
        const oldest = [...sessions.entries()].sort((a, b) => a[1].lastSeen - b[1].lastSeen)[0];
        if (oldest) {
          void oldest[1].state?.runtime?.dispose?.();
          sessions.delete(oldest[0]);
        }
      }
      session = {
        key,
        id: bridgeContext?.sessionId ?? customSessionId ?? `cora-${connectionId}`,
        connectionId,
        helmionMode: bridgeContext ? true : isHelmionSession(customSessionId, sessionPrefix),
        bridgeContext,
        sessionConfig,
        // Bearer-like raw bridge is kept only in memory for the fixed AimForge
        // action request. Activity/log paths receive bridgeContext, never this.
        signedBridge: bridgeContext ? customSessionId : null,
        state: null,
        // Turns on one chat are strictly serialized. Two overlapping agent
        // turns on one tool runtime would interleave their tool calls into a
        // single history and produce an answer neither question asked for.
        queue: Promise.resolve(),
        // Every turn that has not settled yet — the RUNNING one plus anything
        // queued behind it. A Set rather than a single slot because "stop"
        // means stop this chat, and cancelling only the newest would leave the
        // one actually touching the disk running.
        inFlight: new Set(),
        lastSeen: Date.now(),
        turns: 0,
      };
      sessions.set(key, session);
      if (bridgeContext) {
        const result = authorizationActivitySink?.(workspace, bridgeContext);
        if (result && result.logged === false) {
          logger({
            level: 'error', event: 'voice_authorization_not_recorded', reason: result.reason,
          });
        }
        logger({
          level: 'info',
          event: 'aimforge_session_authorized',
          receiptId: bridgeContext.receiptId,
          tenantId: bridgeContext.tenantId,
          role: bridgeContext.role,
          surface: bridgeContext.surface,
        });
        if (providerSessionUsageSink) {
          Promise.resolve(providerSessionUsageSink({ bridgeContext, outcome: 'success' }))
            .then((receipt) => { if (receipt?.recorded === false) logger({ level: 'warn', event: 'provider_session_usage_not_recorded', reason: receipt.reason }); })
            .catch((error) => logger({ level: 'error', event: 'provider_session_usage_failed', reason: error?.message ?? String(error) }));
        }
      }
    }
    session.lastSeen = Date.now();
    return { session, refused: null, bridgeContext: session.bridgeContext };
  };

  /**
   * Cancel everything unsettled on ONE chat — the running turn and anything
   * queued behind it.
   * @returns {number} how many were actually cancelled; 0 means nothing ran,
   *   which is a different thing to say out loud than "stopped".
   */
  const cancelSession = (session, reason) => {
    let cancelled = 0;
    for (const handle of [...session.inFlight]) {
      if (handle.cancel(reason)) cancelled += 1;
    }
    return cancelled;
  };

  /**
   * A disconnected voice client no longer owns a live conversational context.
   * Remove it immediately instead of allowing a reconnect or another client
   * to inherit stale tool history during the idle grace period. Cancellation
   * happens before disposal, and disposal waits for the serialized queue to
   * settle so it cannot tear down a runtime underneath a running tool.
   */
  const discardConnectionSessions = (connectionId, reason) => {
    let discarded = 0;
    for (const [key, session] of sessions) {
      if (session.connectionId !== connectionId) continue;
      cancelSession(session, reason);
      sessions.delete(key);
      discarded += 1;
      void Promise.resolve(session.queue)
        .then(() => session.state?.runtime?.dispose?.())
        .catch(() => {});
    }
    return discarded;
  };

  /** True while ANY chat has a turn that has not settled. */
  const anyTurnInFlight = () => {
    for (const session of sessions.values()) if (session.inFlight.size > 0) return true;
    return false;
  };

  /** Live sockets, so a notification has somewhere it could be spoken. */
  const liveConnections = new Set();

  /**
   * Say a background-agent notice on an idle socket, without being asked.
   *
   * 🔴 THE ONE UNVERIFIED BEHAVIOUR IN THIS FILE, flagged rather than buried.
   * Hume's CLM guide documents the REPLY path only — EVI hands the CLM a turn,
   * the CLM streams `assistant_input` and closes with `assistant_end`
   * (quoted verbatim in clm-protocol.mjs). Whether EVI accepts an
   * `assistant_input` it did not ask for is documented NEITHER WAY, and there
   * is no Hume key on this machine to settle it with.
   *
   * So this is built to be harmless if it turns out to be wrong: it is only
   * ever attempted when NOTHING is in flight (it can never interrupt a real
   * answer), and a `false` return puts the line straight back on the pending
   * queue, where the next genuine turn speaks it for certain. The guaranteed
   * path is the drain at the top of handleTurn; this is the nicety on top.
   *
   * Set `speakNotificationsUnprompted: false` to use only the guaranteed path.
   */
  const speakUnprompted = (text) => {
    if (!speakNotificationsUnprompted) return false;
    if (anyTurnInFlight()) return false;
    const connection = [...liveConnections].find((c) => !c.closed);
    if (!connection) return false;
    if (!connection.sendJson(assistantInput(text))) return false;
    connection.sendJson(assistantEnd());
    logger({ level: 'info', event: 'spoke_notification_unprompted' });
    return true;
  };

  const backgroundNotifier = notifier ?? (notifyBackgroundAgents
    ? createBackgroundAgentNotifier({
      root: workspace,
      speak: speakUnprompted,
      isBusy: anyTurnInFlight,
      ...(deliverNotification ? { deliver: deliverNotification } : {}),
      ...(notifyPollMs === undefined ? {} : { pollMs: notifyPollMs }),
      logger,
    })
    : null);

  async function handleTurn(connection, raw) {
    const parsed = parseHumePayload(raw);
    const sessionIdCheck = validateSessionId(parsed.customSessionId, {
      maxChars: maxSessionIdChars,
    });
    // Do not reflect an invalid, potentially unbounded value back to the voice
    // service. Invalid labels are a refused request, not session context.
    const sessionId = sessionIdCheck.ok ? sessionIdCheck.id : null;
    const sessionResult = sessionIdCheck.ok
      ? await sessionFor(sessionId, connection.id)
      : { session: null, refused: sessionIdCheck.reason };
    const session = sessionResult.session;
    const logSessionId = session?.bridgeContext?.receiptId ?? sessionId;
    // Hume already remembers the client-supplied id for this chat. Do not
    // echo a signed authorization envelope on every assistant frame.
    const outboundSessionId = /^helmion:[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u.test(String(sessionId ?? ''))
      ? null
      : sessionId;

    let ended = false;
    let spokenBudget = session?.sessionConfig?.professionalBehavior?.maxSpokenChars ?? maxSpokenChars;
    let saidAnything = false;
    let announcedTruncation = false;
    const spokenPieces = [];
    const toolsUsed = [];
    let answeredBy = null;

    /**
     * This turn's cancel state, in an object so `speak` and the catch can both
     * see it before the controller further down has been created.
     */
    const turnState = { cancelled: false, controller: null };

    const speak = (text) => {
      // A cancelled turn goes SILENT immediately. Its model call and its tools
      // are being torn down, but events already in flight can still arrive, and
      // letting them speak would talk straight over the "Stopped." the user is
      // hearing — the exact failure Rule 0.25 is about, one layer down.
      if (turnState.cancelled) return;
      const clean = speakableText(text);
      if (!clean) return;
      const { text: allowed, truncated } = applySpokenBudget(clean, spokenBudget);
      if (allowed) {
        spokenBudget -= allowed.length;
        saidAnything = true;
        spokenPieces.push(allowed);
        for (const chunk of splitForSpeech(allowed, { maxChars: speechChunkChars })) {
          connection.sendJson(assistantInput(chunk, outboundSessionId));
        }
      }
      // Say that it was cut, ONCE. Going quiet mid-answer is indistinguishable
      // from a crash to someone who can only hear the result — and repeating
      // the apology on every later chunk is its own kind of broken.
      if (truncated && !announcedTruncation) {
        announcedTruncation = true;
        saidAnything = true;
        connection.sendJson(assistantInput(
          'There is more detail than I should read out; the full answer is in the Helmion activity log.',
          outboundSessionId,
        ));
      }
    };

    /** Idempotent. Every exit from this function goes through it. */
    const endTurn = () => {
      if (ended) return;
      ended = true;
      connection.sendJson(assistantEnd());
    };

    try {
      if (!session) {
        logger({
          level: 'warn',
          event: 'session_refused',
          sessionId: null,
          reason: sessionResult.refused,
        });
        connection.sendJson(assistantInput(
          'I could not use that voice session. Please start a new voice session.',
          outboundSessionId,
        ));
        return;
      }
      if (!parsed.ok) {
        logger({ level: 'warn', event: 'bad_payload', reason: parsed.error });
        connection.sendJson(assistantInput(
          'I could not read that message from the voice service.', outboundSessionId,
        ));
        return;
      }
      if (!parsed.lastUser) {
        // Nothing was asked. Hand the turn straight back rather than filling the
        // silence — and do NOT bill a model call for it.
        logger({ level: 'debug', event: 'no_user_turn', sessionId: logSessionId });
        return;
      }

      const heard = parsed.lastUser.content;

      // ── THE STOP PATH ───────────────────────────────────────────────────
      //
      // CHECKED BEFORE THE QUEUE, AND THAT ORDERING IS THE ENTIRE FIX. The old
      // code sent every incoming payload through `session.queue.then(...)`, so
      // the word "stop" waited politely in line behind the very turn it was
      // trying to stop — Troy heard silence, assumed it had worked, and the
      // agent carried on running tools against his disk the whole time.
      //
      // A cancel is also answered WITHOUT a model call. Paying a provider
      // round-trip to find out how to say "Stopped." would put a second or two
      // of latency on the one interaction that must feel instant.
      if (isStopIntent(heard)) {
        const stopped = cancelSession(session, 'the user said stop');
        logger({ level: 'info', event: 'stop_requested', sessionId: logSessionId, cancelled: stopped });
        speak(stopped > 0
          ? 'Stopped.'
          : 'Nothing was running, but I am listening.');
        // Deliberately NOT written to the activity ledger as a turn: the
        // cancelled turn writes its own `cancelled` row, and a second row
        // saying "heard: stop" would double-count one interruption.
        return;
      }

      const prompt = includeProsody
        ? annotateWithProsody(heard, topProsody(parsed.lastUser.prosody, 3))
        : heard;

      // Anything a background agent finished while nobody was talking gets said
      // FIRST, in the same breath as the answer. See notify.mjs for why this is
      // the guaranteed delivery path and an unprompted one is not.
      for (const line of backgroundNotifier?.drainSpoken() ?? []) speak(line);

      session.turns += 1;
      logger({
        level: 'info',
        event: 'turn_start',
        sessionId: logSessionId,
        helmionMode: session.helmionMode,
        chars: heard.length,
      });

      let spokeProgress = false;
      const onEvent = (ev) => {
        if (ev.type === 'tool') {
          toolsUsed.push(ev.name);
          if (speakToolProgress && !spokeProgress) {
            spokeProgress = true;
            // ONE short line, once per turn. A running commentary of every tool
            // call talks over the user and is the fastest way to make a voice
            // agent unbearable.
            connection.sendJson(assistantInput('Working on that now.', outboundSessionId));
          }
        } else if (ev.type === 'provenance') {
          answeredBy = ev.model ?? answeredBy;
        } else if (ev.type === 'assistant_partial' || ev.type === 'assistant') {
          speak(ev.text);
        }
      };

      // This turn's kill switch, registered on the session BEFORE the turn
      // starts. Registering after would leave a window — short, but exactly the
      // window a fast "stop" lands in — where the turn is running and nothing
      // on the session knows how to reach it. A turn that is still QUEUED is
      // registered too, so cancelling takes out the backlog as well as the
      // thing currently touching the disk.
      const controller = new AbortController();
      turnState.controller = controller;
      turnState.handle = {
        phase: 'queued',
        cancel(reason) {
          if (turnState.cancelled) return false;
          turnState.cancelled = true;
          controller.abort(new Error(reason));
          return true;
        },
      };
      session.inFlight.add(turnState.handle);

      const running = session.queue
        .then(() => {
          turnState.handle.phase = 'running';
          return turn({ text: prompt, session, onEvent, signal: controller.signal });
        });
      // Keep the chain alive even when this turn rejects, or one failure would
      // poison every later turn on the session.
      session.queue = running.catch(() => {});

      const timedOut = Symbol('timeout');
      let timer = null;
      let outcome;
      try {
        outcome = await Promise.race([
          running.then(() => 'done'),
          new Promise((resolve) => { timer = setTimeout(() => resolve(timedOut), turnTimeoutMs); }),
        ]);
      } finally {
        // MUST be a finally. Clearing this after the await meant a REJECTED
        // turn skipped the clear and left a two-minute timer pending — the
        // whole test process stayed alive for exactly turnTimeoutMs, which is
        // how this was caught.
        if (timer) clearTimeout(timer);
      }

      if (outcome === timedOut) {
        // Release the conversation. The agent turn is NOT cancelled — it has
        // real work in flight — but it will not speak after this point, because
        // speaking into a turn we already handed back means talking over
        // whatever the user said next.
        logger({ level: 'warn', event: 'turn_timeout', sessionId: logSessionId, ms: turnTimeoutMs });
        turnState.handle.phase = 'timed-out';
        connection.sendJson(assistantInput(
          'That is taking longer than a conversation should. It is still running, '
          + 'and I will put the result in the activity log.', outboundSessionId,
        ));
        endTurn();
        // THE HANDLE DELIBERATELY STAYS REGISTERED. This is the one case where
        // the conversation has been handed back while real work is still
        // running, so it is precisely when Troy is most likely to say "stop" —
        // and if the `finally` below deregistered it on the way out, that stop
        // would have nothing left to cancel. It is removed when the work
        // actually settles, in both branches here.
        turnState.keepRegistered = true;
        const releaseHandle = () => session.inFlight.delete(turnState.handle);
        void running.then(
          () => { releaseHandle(); writeActivity('completed-after-timeout'); },
          (err) => {
            releaseHandle();
            if (isAbortError(err) || turnState.cancelled) {
              logger({ level: 'info', event: 'turn_cancelled_after_timeout', sessionId: logSessionId });
              writeActivity('cancelled');
              return;
            }
            logger({ level: 'error', event: 'turn_failed_after_timeout', message: err?.message });
            writeActivity('failed');
          },
        );
        return;
      }

      if (!saidAnything) {
        // A turn that ends with total silence reads as a hang. Say something.
        speak('Done, but there was nothing to say out loud.');
      }
      writeActivity('completed');
    } catch (err) {
      // A CANCEL IS NOT A FAILURE, and must not be announced as one. The stop
      // turn has already said "Stopped."; an apology arriving a moment later
      // contradicts it out loud, and a 'failed' ledger row would turn every
      // deliberate interruption into a defect that never happened.
      if (isAbortError(err) || turnState.cancelled) {
        logger({ level: 'info', event: 'turn_cancelled', sessionId: logSessionId });
        writeActivity('cancelled');
        return;
      }
      logger({ level: 'error', event: 'turn_failed', message: err?.message ?? String(err) });
      // The listener must be told, out loud, that it failed. A silent failure
      // followed by assistant_end is indistinguishable from a correct answer of
      // "nothing".
      if (!ended) {
        connection.sendJson(assistantInput(
          `Something went wrong on my side: ${shortError(err)}`, outboundSessionId,
        ));
      }
      writeActivity('failed', shortError(err));
    } finally {
      // Deregistered here for every normal exit. The ONE exception is the
      // timeout path above, which keeps its handle alive on purpose so a late
      // "stop" still has something to kill.
      if (turnState.handle && !turnState.keepRegistered) {
        session.inFlight.delete(turnState.handle);
      }
      endTurn();
    }

    function writeActivity(status, failure = null) {
      if (!parsed.ok || !parsed.lastUser) return;
      const result = activitySink?.(workspace, {
        heard: parsed.lastUser.content,
        spoken: failure ? `(failed) ${failure}` : spokenPieces.join(' '),
        status,
        tools: toolsUsed,
        model: answeredBy,
        sessionId,
        helmionMode: session.helmionMode,
        bridgeContext: session.bridgeContext,
      });
      // A ledger failure is never silent — this codebase already shipped that
      // bug once with a dropped `skipped` flag.
      if (result && result.logged === false) {
        logger({ level: 'error', event: 'activity_not_recorded', reason: result.reason });
      }
    }
  }

  const countInFlight = () => {
    let n = 0;
    for (const session of sessions.values()) n += session.inFlight.size;
    return n;
  };

  /**
   * A deliberately lossy, identifier-free view of live session state.
   * Diagnostics can say whether work exists and which policy mode it uses, but
   * never which session, connection, workspace, or user prompt produced it.
   */
  const healthDetail = () => {
    const now = Date.now();
    const sessionsForHealth = [...sessions.values()].slice(0, MAX_CORA_HEALTH_DETAIL_SESSIONS);
    const phaseCounts = { queued: 0, running: 0, 'timed-out': 0 };
    const phaseCountsByMode = {
      'tools-enabled': { queued: 0, running: 0, 'timed-out': 0 },
      'chat-only': { queued: 0, running: 0, 'timed-out': 0 },
    };
    let phaseCountsTruncated = false;
    const phaseCountsByModeTruncated = { 'tools-enabled': false, 'chat-only': false };
    for (const session of sessions.values()) {
      const mode = session.helmionMode ? 'tools-enabled' : 'chat-only';
      for (const handle of session.inFlight) {
        const phase = handle.phase;
        if (phase !== 'queued' && phase !== 'running' && phase !== 'timed-out') continue;
        if (phaseCounts[phase] >= MAX_CORA_HEALTH_PHASE_COUNT) {
          phaseCountsTruncated = true;
        } else {
          phaseCounts[phase] += 1;
        }
        if (phaseCountsByMode[mode][phase] >= MAX_CORA_HEALTH_PHASE_COUNT) {
          phaseCountsByModeTruncated[mode] = true;
        } else {
          phaseCountsByMode[mode][phase] += 1;
        }
      }
    }
    return {
      schemaVersion: CORA_HEALTH_DIAGNOSTICS_SCHEMA_VERSION,
      sessions: sessionsForHealth.map((session) => {
        const activeTurnPhases = [...session.inFlight]
          .map((handle) => handle.phase)
          .filter((phase) => phase === 'queued' || phase === 'running' || phase === 'timed-out')
          .slice(0, MAX_CORA_HEALTH_DETAIL_SESSIONS);
        const phase = activeTurnPhases.includes('timed-out')
          ? 'timed-out'
          : activeTurnPhases.includes('running')
            ? 'running'
            : activeTurnPhases.includes('queued')
              ? 'queued'
              : null;
        return {
          mode: session.helmionMode ? 'tools-enabled' : 'chat-only',
          turns: Math.max(0, Math.min(1_000_000, Number(session.turns) || 0)),
          inFlight: Math.max(0, Math.min(100, session.inFlight.size)),
          active: session.inFlight.size > 0,
          phase,
          activeTurnPhases,
          lastSeenAgeMs: Math.max(0, Math.min(MAX_CORA_HEALTH_AGE_MS, now - session.lastSeen)),
        };
      }),
      phaseCounts,
      phaseCountsTruncated,
      phaseCountsByMode,
      phaseCountsByModeTruncated,
      truncated: sessions.size > MAX_CORA_HEALTH_DETAIL_SESSIONS,
    };
  };

  const handleHttpRequest = async (request, response) => {
    let requestUrl;
    try {
      requestUrl = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);
    } catch {
      response.writeHead(400, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
      response.end('Malformed request target.\n');
      return;
    }

    // Health remains behind the Cora bearer boundary below. An optional
    // application handler may serve other HTTP routes on this same port.
    if (requestUrl.pathname !== statusPath && typeof httpRequestHandler === 'function') {
      const handled = await httpRequestHandler(request, response, requestUrl);
      if (handled) return;
    }

    if (request.method === 'GET' && requestUrl.pathname === statusPath) {
      if (requiresToken && !tokenMatches(token, requestBearerToken(request))) {
        response.writeHead(401, {
          'content-type': 'application/json; charset=utf-8',
          'cache-control': 'no-store',
          'www-authenticate': 'Bearer',
          'x-content-type-options': 'nosniff',
        });
        response.end(JSON.stringify({ status: 'unauthorized', service: 'cora-clm' }));
        return;
      }
      const bodyObject = {
        status: 'ok',
        service: 'cora-clm',
        protocol: 'hume-clm',
        socketPath: path,
        healthPath: statusPath,
        provider: activeProvider ? { id: activeProvider.id, label: activeProvider.label } : null,
        providerReadiness,
        hume: {
          configured: Boolean(String(process.env.HELMION_HUME_CONFIG_ID ?? '').trim()),
          configId: String(process.env.HELMION_HUME_CONFIG_ID ?? '').trim() || null,
          customLanguageModel: true,
          requiredSessionPrefix: `${sessionPrefix}:`,
          signedSessionsRequired: requireSignedSessions,
          sessionConfigResolution: typeof publishedConfigResolver === 'function' ? 'organization_published_at_session_time' : 'unavailable',
        },
        requiresToken,
        allowedOriginCount: Array.isArray(allowedOrigins) ? allowedOrigins.length : 0,
        sessions: sessions.size,
        inFlight: countInFlight(),
      };
      // Detail is opt-in. `detail=1` is intentionally not a second authority
      // mechanism: it inherits the exact health endpoint bearer boundary above.
      if (requestUrl.searchParams.get('detail') === '1') {
        bodyObject.diagnostics = healthDetail();
      }
      const body = JSON.stringify(bodyObject);
      response.writeHead(200, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
      });
      response.end(body);
      return;
    }

    response.writeHead(426, {
      'content-type': 'text/plain; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    });
    response.end(`Cora CLM speaks WebSocket only. Point a Hume EVI config at ws://${host}:${port}${path}\n`);
  };

  const httpServer = createServer((request, response) => {
    void handleHttpRequest(request, response).catch((error) => {
      logger({ level: 'error', event: 'http_handler_failed', message: error?.message ?? String(error) });
      if (!response.headersSent) {
        response.writeHead(500, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
        response.end(JSON.stringify({ valid: false, code: 'HTTP_HANDLER_FAILED' }));
      } else if (!response.writableEnded) {
        response.end();
      }
    });
  });

  const ws = attachWebSocketServer(httpServer, {
    path,
    allowedOrigins,
    onRefused: (info) => logger({ level: 'warn', event: 'upgrade_refused', ...info }),
    verifyClient: ({ url }) => {
      if (!requiresToken) return { ok: true };
      const presented = url.searchParams.get('token') ?? '';
      if (tokenMatches(token, presented)) return { ok: true };
      return { ok: false, status: 401, message: 'Bad or missing token.' };
    },
    onConnection: (connection) => {
      logger({ level: 'info', event: 'connected', id: connection.id, from: connection.remoteAddress });
      liveConnections.add(connection);
      connection.on('text', (raw) => {
        // Deliberately not awaited: each incoming payload owns its own turn and
        // its own assistant_end. Serialization happens per SESSION inside
        // handleTurn, not per socket, because two chats can share one process.
        void handleTurn(connection, raw).catch((err) => {
          logger({ level: 'error', event: 'handler_crashed', message: err?.message });
          try { connection.sendJson(assistantEnd()); } catch { /* socket gone */ }
        });
      });
      connection.on('close', ({ code, reason }) => {
        liveConnections.delete(connection);
        const discarded = discardConnectionSessions(connection.id, 'the voice connection closed');
        if (discarded) logger({
          level: 'info',
          event: 'sessions_discarded_on_disconnect',
          connectionId: connection.id,
          count: discarded,
        });
        logger({ level: 'info', event: 'disconnected', id: connection.id, code, reason });
      });
      connection.on('error', (err) => {
        logger({ level: 'warn', event: 'socket_error', message: err?.message });
      });
    },
  });

  await new Promise((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(port, host, resolve);
  });

  const address = httpServer.address();
  backgroundNotifier?.start?.();

  return {
    host,
    port: address.port,
    path,
    healthPath: statusPath,
    url: `ws://${host}:${address.port}${path}`,
    healthUrl: `http://${host}:${address.port}${statusPath}`,
    provider: activeProvider
      ? { id: activeProvider.id, label: activeProvider.label }
      : null,
    providerReadiness,
    requiresToken,
    requiresSignedSessions: requireSignedSessions,
    allowedOrigins,
    sessionCount: () => sessions.size,
    /** Turns that have not settled, across every chat. */
    inFlightCount: countInFlight,
    /** The kill switch, reachable from outside a spoken turn. */
    cancelAll(reason = 'cancelled by the host') {
      let n = 0;
      for (const session of sessions.values()) n += cancelSession(session, reason);
      return n;
    },
    notifier: backgroundNotifier,
    async close() {
      // CANCEL BEFORE DISPOSING. `dispose()` tears down the tool runtime a
      // running turn is still using; doing that underneath a live turn is how
      // shutdown races turn into "cannot read property of undefined" from
      // inside a tool. Stopping the work first makes the teardown ordered.
      for (const session of sessions.values()) cancelSession(session, 'the server is shutting down');
      backgroundNotifier?.stop?.();
      ws.closeAll(CLOSE.GOING_AWAY, 'Cora CLM shutting down');
      for (const session of sessions.values()) await session.state?.runtime?.dispose?.();
      sessions.clear();
      liveConnections.clear();
      await new Promise((resolve) => httpServer.close(resolve));
    },
  };
}

function shortError(err) {
  const message = String(err?.message ?? err ?? 'unknown error');
  return message.length > 160 ? `${message.slice(0, 160)}…` : message;
}
