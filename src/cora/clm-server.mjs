// CORA -> HELMION, PHASE 1: a Custom Language Model backend that runs on this
// machine, for Troy alone. No cloud, no tenancy, no relay.
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
import { createSessionState, runAgentTurn } from '../agent/loop.mjs';
import { attachWebSocketServer, CLOSE } from './ws-server.mjs';
import {
  DEFAULT_MAX_SPOKEN_CHARS,
  DEFAULT_SPEECH_CHUNK_CHARS,
  annotateWithProsody,
  applySpokenBudget,
  assistantEnd,
  assistantInput,
  parseHumePayload,
  speakableText,
  splitForSpeech,
  topProsody,
} from './clm-protocol.mjs';
import { recordVoiceTurn } from './activity.mjs';

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

/** A chat whose custom_session_id starts with this runs with tools. */
export const HELMION_SESSION_PREFIX = 'helmion';

/** How long one spoken turn may hold the conversation before it is released. */
export const DEFAULT_TURN_TIMEOUT_MS = 120_000;

/** Sessions idle longer than this are dropped, releasing their tool runtime. */
export const DEFAULT_SESSION_IDLE_MS = 30 * 60_000;

export const DEFAULT_MAX_SESSIONS = 8;

/**
 * "Helmion mode", marked the way the task requires: on Hume's
 * `custom_session_id`. Configure the EVI session with
 * `custom_session_id: "helmion:<anything>"` and the turn gets the tool-enabled
 * agent; anything else — including a session with no id at all — gets a
 * read-only chat runtime.
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

/**
 * Decide whether this bind is allowed at all, BEFORE the port is opened.
 *
 * This socket reaches `run_command`. Binding it to 0.0.0.0 with no credential
 * would put an unauthenticated remote-shell on the LAN, which is exactly the
 * defect already recorded against another local ws server on this machine. So
 * that combination is refused at startup rather than documented as a caveat.
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
}) {
  return async function runTurn({ text, session, onEvent }) {
    if (!session.state) {
      session.state = createSessionState(workspace, {
        permissionMode: session.helmionMode ? permissionMode : 'read-only',
        safeWorkspaceTools,
      });
    }
    return runAgentTurn({
      userText: text,
      messages: session.state.messages,
      provider,
      runtime: session.state.runtime,
      onEvent,
      tier,
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
  token = null,
  providerName = 'claude',
  provider = null,
  permissionMode = 'read-tools',
  tier = 'standard',
  safeWorkspaceTools = true,
  sessionPrefix = HELMION_SESSION_PREFIX,
  runTurn = null,
  activitySink = recordVoiceTurn,
  includeProsody = true,
  speakToolProgress = true,
  maxSpokenChars = DEFAULT_MAX_SPOKEN_CHARS,
  speechChunkChars = DEFAULT_SPEECH_CHUNK_CHARS,
  turnTimeoutMs = DEFAULT_TURN_TIMEOUT_MS,
  sessionIdleMs = DEFAULT_SESSION_IDLE_MS,
  maxSessions = DEFAULT_MAX_SESSIONS,
  logger = () => {},
} = {}) {
  const { requiresToken } = resolveAccess({ host, token });

  let activeProvider = provider;
  let turn = runTurn;
  if (!turn) {
    if (!activeProvider) {
      const env = loadHelmionEnv(workspace);
      activeProvider = resolveProvider(providerName, env);
    }
    if (!activeProvider?.key) {
      throw new Error(
        `No API key for ${activeProvider?.label ?? providerName}. Cora speaks with `
        + 'Helmion\'s own provider chain; set the matching key in .env '
        + '(ANTHROPIC_API_KEY for Claude/Sonnet).',
      );
    }
    turn = createAgentTurnRunner({
      workspace, provider: activeProvider, permissionMode, tier, safeWorkspaceTools,
    });
  }

  /** @type {Map<string, {id, key, helmionMode, state, queue, lastSeen, turns}>} */
  const sessions = new Map();

  const evictIdle = () => {
    const cutoff = Date.now() - sessionIdleMs;
    for (const [key, session] of sessions) {
      if (session.lastSeen < cutoff) {
        void session.state?.runtime?.dispose?.();
        sessions.delete(key);
      }
    }
  };

  const sessionFor = (customSessionId, connectionId) => {
    evictIdle();
    const key = customSessionId ?? `socket:${connectionId}`;
    let session = sessions.get(key);
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
        id: customSessionId ?? `cora-${connectionId}`,
        helmionMode: isHelmionSession(customSessionId, sessionPrefix),
        state: null,
        // Turns on one chat are strictly serialized. Two overlapping agent
        // turns on one tool runtime would interleave their tool calls into a
        // single history and produce an answer neither question asked for.
        queue: Promise.resolve(),
        lastSeen: Date.now(),
        turns: 0,
      };
      sessions.set(key, session);
    }
    session.lastSeen = Date.now();
    return session;
  };

  async function handleTurn(connection, raw) {
    const parsed = parseHumePayload(raw);
    const session = sessionFor(parsed.customSessionId, connection.id);
    const sessionId = parsed.customSessionId;

    let ended = false;
    let spokenBudget = maxSpokenChars;
    let saidAnything = false;
    let announcedTruncation = false;
    const spokenPieces = [];
    const toolsUsed = [];
    let answeredBy = null;

    const speak = (text) => {
      const clean = speakableText(text);
      if (!clean) return;
      const { text: allowed, truncated } = applySpokenBudget(clean, spokenBudget);
      if (allowed) {
        spokenBudget -= allowed.length;
        saidAnything = true;
        spokenPieces.push(allowed);
        for (const chunk of splitForSpeech(allowed, { maxChars: speechChunkChars })) {
          connection.sendJson(assistantInput(chunk, sessionId));
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
          sessionId,
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
      if (!parsed.ok) {
        logger({ level: 'warn', event: 'bad_payload', reason: parsed.error });
        connection.sendJson(assistantInput(
          'I could not read that message from the voice service.', sessionId,
        ));
        return;
      }
      if (!parsed.lastUser) {
        // Nothing was asked. Hand the turn straight back rather than filling the
        // silence — and do NOT bill a model call for it.
        logger({ level: 'debug', event: 'no_user_turn', sessionId });
        return;
      }

      const heard = parsed.lastUser.content;
      const prompt = includeProsody
        ? annotateWithProsody(heard, topProsody(parsed.lastUser.prosody, 3))
        : heard;

      session.turns += 1;
      logger({
        level: 'info',
        event: 'turn_start',
        sessionId,
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
            connection.sendJson(assistantInput('Working on that now.', sessionId));
          }
        } else if (ev.type === 'provenance') {
          answeredBy = ev.model ?? answeredBy;
        } else if (ev.type === 'assistant_partial' || ev.type === 'assistant') {
          speak(ev.text);
        }
      };

      const running = session.queue.then(() => turn({ text: prompt, session, onEvent }));
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
        logger({ level: 'warn', event: 'turn_timeout', sessionId, ms: turnTimeoutMs });
        connection.sendJson(assistantInput(
          'That is taking longer than a conversation should. It is still running, '
          + 'and I will put the result in the activity log.', sessionId,
        ));
        endTurn();
        void running.then(
          () => writeActivity('completed-after-timeout'),
          (err) => {
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
      logger({ level: 'error', event: 'turn_failed', message: err?.message ?? String(err) });
      // The listener must be told, out loud, that it failed. A silent failure
      // followed by assistant_end is indistinguishable from a correct answer of
      // "nothing".
      if (!ended) {
        connection.sendJson(assistantInput(
          `Something went wrong on my side: ${shortError(err)}`, sessionId,
        ));
      }
      writeActivity('failed', shortError(err));
    } finally {
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
      });
      // A ledger failure is never silent — this codebase already shipped that
      // bug once with a dropped `skipped` flag.
      if (result && result.logged === false) {
        logger({ level: 'error', event: 'activity_not_recorded', reason: result.reason });
      }
    }
  }

  const httpServer = createServer((_request, response) => {
    response.writeHead(426, {
      'content-type': 'text/plain; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    });
    response.end(`Cora CLM speaks WebSocket only. Point a Hume EVI config at ws://${host}:${port}${path}\n`);
  });

  const ws = attachWebSocketServer(httpServer, {
    path,
    verifyClient: ({ url }) => {
      if (!requiresToken) return { ok: true };
      const presented = url.searchParams.get('token') ?? '';
      if (tokenMatches(token, presented)) return { ok: true };
      return { ok: false, status: 401, message: 'Bad or missing token.' };
    },
    onConnection: (connection) => {
      logger({ level: 'info', event: 'connected', id: connection.id, from: connection.remoteAddress });
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
  return {
    host,
    port: address.port,
    path,
    url: `ws://${host}:${address.port}${path}`,
    provider: activeProvider
      ? { id: activeProvider.id, label: activeProvider.label }
      : null,
    requiresToken,
    sessionCount: () => sessions.size,
    async close() {
      ws.closeAll(CLOSE.GOING_AWAY, 'Cora CLM shutting down');
      for (const session of sessions.values()) await session.state?.runtime?.dispose?.();
      sessions.clear();
      await new Promise((resolve) => httpServer.close(resolve));
    },
  };
}

function shortError(err) {
  const message = String(err?.message ?? err ?? 'unknown error');
  return message.length > 160 ? `${message.slice(0, 160)}…` : message;
}
