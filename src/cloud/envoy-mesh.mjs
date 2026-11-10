// Envoy mesh: agents as channel members, and the Discord / Slack links.
//
// Routes (hung off handleEnvoyAblyRoute; live-admin.mjs stays untouched):
//   Signed-in members and paired desktops (session cookie or device token):
//     GET  /api/admin/envoy/channel-config?channel_id=   agents + Discord / Slack links for one channel
//     POST /api/admin/envoy/channel-config               add-agent | remove-agent | link-discord | unlink-discord | link-slack | unlink-slack | set-armed-connectors | (and the later actions below)
//     GET  /api/admin/envoy/agent-work?providers=a,b     device token: messages waiting for an agent reply
//     POST /api/admin/envoy/agent-messages               device token: post as an agent member
//   Bridge services (Hetzner, bearer HELMIAN_ENVOY_BRIDGE_TOKEN):
//     GET  /api/admin/envoy/bridge/links
//     POST /api/admin/envoy/bridge/confirm-link
//     POST /api/admin/envoy/bridge/inbound
//     GET  /api/admin/envoy/bridge/outbound?since=
//
// Storage needs no new migration: a channel's config is an append-only
// author_kind='system' row in helmion.envoy_messages (author CONFIG_SUBJECT,
// hidden from chat reads); the newest row wins. Every change also writes a
// visible notice ("Claude joined the channel").
//
// Provider keys never reach this server (rule 019). Agents run on the user's
// own runner (PC bridge) and post their replies here.
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { Pool } from 'pg';
import { withTenantTransaction, requireActiveTenantMembership } from '../core/tenant-context.mjs';
import { publishEnvoyMessage } from './envoy-ably.mjs';
import {
  AGENT_NAMES, AGENT_PROVIDERS, CONFIG_SUBJECT, DESK_ROSTER_FALLBACK, MAESTRO_DESK_SLUG, MAX_CHANNEL_AGENTS, MAX_DEBATE_TURNS, DEFAULT_DEBATE_TURNS, NOTICE_SUBJECT,
  agentSubject, agentsToAnswer, describeAuthor, discordSubject, isSlackId, slackSubject,
  emptyConfig, normalizeCustomHandle, normalizeProvider, parseConfig, publicConfig, sanitizeArmedConnectors, sanitizeChannelAvatar, sanitizeCustomAgent, sanitizeGithubLink, serializeConfig,
} from './envoy-agents.mjs';
import { claimGateFor, tenantAgentStateOn } from './tenant-agent-state.mjs';
import { classifySeatAsk } from './envoy-actions.mjs';
import { evaluateSeatAction, guardRefusalText } from './envoy-guard.mjs';
import { createGuardStore } from './guard-findings.mjs';
import { ingestEvaluationFinding } from './envoy-findings.mjs';
import { screenIntakeContent, siteGuardRefusalText, siteGuardStopRecord, ingestSiteGuardFindings, createSiteGuardRateLimiter, siteGuardSenderKey, siteGuardRateRefusalText, siteGuardRateStopRecord, ingestSiteGuardRateFinding } from './site-guard.mjs';
import { readNotebookBlock } from './envoy-notebook.mjs';
import { createLibrarianStore, deriveChannelName, fileDispatchAsk, fileIncidentFromDispatch, isGenericChannelTitle, nameChannelIfGeneric, readKnowledgeBaseBlock } from './envoy-librarian.mjs';
import { createSkillLibraryStore } from './skill-library.mjs';
import { armingPairsForDispatch, resolveDispatchArming } from './connector-arming-dispatch.mjs';
import { createRunnerPresenceStore } from './runner-presence.mjs';

// The bot status functions live in bot-status.mjs (import-free, so the
// channels store can carry them too); re-exported here for the callers
// and tests that have always taken them from the mesh.
export { discordBotStatus, slackBotStatus } from './bot-status.mjs';
import { discordBotStatus, slackBotStatus } from './bot-status.mjs';

export const CHANNEL_CONFIG_PATH = '/api/admin/envoy/channel-config';
export const AGENT_WORK_PATH = '/api/admin/envoy/agent-work';
export const AGENT_MESSAGES_PATH = '/api/admin/envoy/agent-messages';
export const BRIDGE_PREFIX = '/api/admin/envoy/bridge/';
export const LINK_CODE_TTL_MS = 15 * 60 * 1000;
const WORK_WINDOW_MS = 30 * 60 * 1000;
const MSG_COLS = 'id, channel_id, author_subject, author_kind, body, idempotency_key, created_at, metadata';

let sharedPool = null;
function getPool() {
  if (!sharedPool) {
    const connectionString = String(process.env.HELMION_DATABASE_URL ?? '').trim();
    if (!connectionString) throw Object.assign(new Error('database not configured'), { status: 503 });
    sharedPool = new Pool({ connectionString, ssl: connectionString.includes('sslmode=disable') ? false : undefined, max: 3 });
  }
  return sharedPool;
}

const fail = (status, code, message = code) => Object.assign(new Error(message), { status, code });
const sha256 = (value) => createHash('sha256').update(String(value), 'utf8').digest('hex');

export function newLinkCode() {
  // 8 chars from an unambiguous alphabet (no 0/O/1/I).
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = randomBytes(8);
  return [...bytes].map((b) => alphabet[b % alphabet.length]).join('');
}

export function messageOut(row) {
  const who = describeAuthor(row.author_subject, row.author_kind);
  return {
    id: String(row.id), channelId: String(row.channel_id), authorSubject: String(row.author_subject), authorKind: String(row.author_kind),
    ...(who.name ? { authorName: who.name } : {}), source: who.source, ...(who.provider ? { agentProvider: who.provider } : {}),
    body: String(row.body), ...(row.metadata ? { metadata: typeof row.metadata === 'string' ? JSON.parse(row.metadata) : row.metadata } : {}), idempotencyKey: String(row.idempotency_key), createdAt: row.created_at,
  };
}

async function setTenant(client, tenantId) {
  await client.query(`select set_config('helmion.tenant_id', $1, true)`, [tenantId]);
}

// The dispatch read for Helmian-store skills (slash-skills DESIGN
// §3.2): the named records for one tenant, through the skill store
// over the mesh's pool — deliberately NOT the dispatch transaction's
// client, so a skill failure can never poison the transaction that
// hands out work (the notebook read's discipline). Returns a Map of
// the records FOUND; an id the store does not return is simply absent
// from the map. Throws on a real read failure — the caller in
// agentWork turns that into "no skills this poll", never a failed
// dispatch.
async function readSkillRecords(pool, tenantId, ids) {
  const store = createSkillLibraryStore(pool);
  const found = new Map();
  for (const id of ids) {
    const record = await store.getSkill(tenantId, id);
    if (record) found.set(id, record);
  }
  return found;
}

/**
 * Resolve one message's skill toggles (metadata.skills) against the
 * records dispatch read, for the seats due on that message
 * (slash-skills DESIGN §3.2). Pure. `records` is a Map of skill id →
 * store record (or null/absent when the read did not return it).
 *
 * The record's scope is the ceiling: a blanket record takes the
 * message's target as-is; a 'seats' record narrows the message's
 * target to its own seat list — 'all' becomes the record's seats, a
 * seat outside the list becomes nothing. A message can narrow a
 * skill for one turn, never widen it. Targets that name no due seat
 * do not ride the work item at all (they are not this item's
 * business), and 'all' rides only when someone is due — the due set
 * is agentsToAnswer's, so a blanket skill never targets Maestro,
 * who is never due (DESIGN §5.5).
 *
 * A toggle whose record is absent, or no longer 'available', rides
 * as { id, missing: true, seatId } for each of its targets among the
 * due seats, so the turn states the honest line (DESIGN §2.4) rather
 * than the seat never knowing a skill was attached.
 *
 * Entries are { id, name, body, seatId } or { id, missing: true,
 * seatId } — seatId is the EFFECTIVE target after clamping ('all' or
 * one seat), which the bridges slice on and attachments.mjs
 * re-checks per turn (defense in depth).
 */
export function resolveDispatchSkills(toggles, records, dueSeats) {
  const due = new Set(dueSeats ?? []);
  const out = [];
  const seen = new Set();
  const push = (entry) => {
    const key = `${entry.id}|${entry.seatId}|${entry.missing ? 'missing' : 'body'}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(entry);
  };
  for (const toggle of toggles ?? []) {
    const skillId = toggle?.skillId;
    const seatId = toggle?.seatId;
    if (!skillId || !seatId) continue;
    const record = records?.get?.(skillId) ?? null;
    if (!record || record.state !== 'available') {
      if (seatId === 'all' ? due.size > 0 : due.has(seatId)) push({ id: skillId, missing: true, seatId });
      continue;
    }
    let targets;
    if (record.scope === 'blanket') targets = [seatId];
    else if (seatId === 'all') targets = Array.isArray(record.seatIds) ? record.seatIds : [];
    else targets = (Array.isArray(record.seatIds) ? record.seatIds : []).includes(seatId) ? [seatId] : [];
    for (const target of targets) {
      if (target === 'all' ? due.size === 0 : !due.has(target)) continue;
      push({ id: record.id ?? skillId, name: record.name, body: record.body, seatId: target });
    }
  }
  return out;
}

async function readConfig(client, tenantId, channelId) {
  const r = await client.query(
    `select body from helmion.envoy_messages where tenant_id=$1 and channel_id=$2 and author_subject=$3 order by created_at desc, id desc limit 1`,
    [tenantId, channelId, CONFIG_SUBJECT],
  );
  return r.rowCount ? parseConfig(r.rows[0].body) : null;
}

async function insertMessage(client, { tenantId, channelId, subject, kind, body, key, metadata = null }) {
  const r = await client.query(
    `insert into helmion.envoy_messages(tenant_id, channel_id, author_subject, author_kind, body, idempotency_key, metadata)
     values ($1,$2,$3,$4,$5,$6,$7)
     on conflict (tenant_id, channel_id, author_subject, idempotency_key) do nothing
     returning ${MSG_COLS}`,
    [tenantId, channelId, subject, kind, body, key, metadata ? JSON.stringify(metadata) : null],
  );
  if (r.rowCount === 1) return { row: r.rows[0], replayed: false };
  const again = await client.query(
    `select ${MSG_COLS} from helmion.envoy_messages where tenant_id=$1 and channel_id=$2 and author_subject=$3 and idempotency_key=$4`,
    [tenantId, channelId, subject, key],
  );
  return { row: again.rows[0] ?? null, replayed: true };
}

async function writeConfig(client, tenantId, channelId, config) {
  await insertMessage(client, { tenantId, channelId, subject: CONFIG_SUBJECT, kind: 'system', body: serializeConfig(config), key: `cfg:${randomUUID()}` });
}

async function notice(client, tenantId, channelId, text) {
  const { row } = await insertMessage(client, { tenantId, channelId, subject: NOTICE_SUBJECT, kind: 'system', body: text.slice(0, 4000), key: `notice:${randomUUID()}` });
  return row;
}

async function channelRow(client, tenantId, channelId) {
  if (!/^[0-9a-f-]{36}$/i.test(String(channelId ?? ''))) throw fail(400, 'ENVOY_CHANNEL_INVALID');
  const r = await client.query('select id, slug, title, kind from helmion.envoy_channels where tenant_id=$1 and id=$2', [tenantId, channelId]);
  if (r.rowCount !== 1) throw fail(404, 'ENVOY_CHANNEL_NOT_FOUND');
  return r.rows[0];
}

function contextFor(actor) {
  return { tenantId: actor.tenantId, actorSubject: actor.subject, actorRole: actor.role, sessionId: randomUUID(), requestId: randomUUID() };
}

const publish = (tenantId, row, publishImpl) => { if (row) void (publishImpl ?? publishEnvoyMessage)({ tenantId, channelId: String(row.channel_id), message: messageOut(row) }); };

// The answer stamp (honest-connection fix, 2026-11-01): after a runner
// posts an agent reply, record when that provider last answered on the
// tenant's presence row (sql/066) — the one event that proves the road
// works, and the stamp the provider cards read as "Answered".
// Best-effort by contract: a reply that landed must never fail because
// the stamp could not be written. The store's markAnswered is
// update-only, so an answer never creates a presence row for a tenant
// that has none (a row's existence is itself a readiness signal).
export async function stampAgentAnswered(pool, tenantId, provider) {
  if (!pool || !tenantId || !provider) return false;
  try {
    const result = await createRunnerPresenceStore(pool).markAnswered(tenantId, provider);
    return result?.answered === true;
  } catch {
    return false;
  }
}

// A custom agent answers through its engine provider (the entry's
// .provider, e.g. a "coder" seat running on claude). The stamp belongs
// to the engine — it is the engine's road that just proved itself.
function answeredEngineFor(customAgents, handle) {
  const entry = (customAgents ?? []).find((a) => (a?.handle || a?.id) === handle);
  const engine = String(entry?.provider ?? '').toLowerCase();
  if (!engine) return null;
  return normalizeProvider(engine) ?? engine;
}

export function createEnvoyMesh({ pool, now = () => Date.now(), publishImpl = null, nameLookup = null, agentStateImpl = null, guardWorkspace = undefined, guardStoreImpl = null, guardLogImpl = null, siteGuardLogImpl = null, siteGuardRateImpl = null, notebookImpl = null, notebookLogImpl = null, skillReadImpl = null, skillLogImpl = null, armingReadImpl = null, armingLogImpl = null, librarianImpl = null, librarianLogImpl = null, kbImpl = null, kbLogImpl = null } = {}) {
  const tx = (actor, work) => withTenantTransaction(pool, contextFor(actor), async (client, context) => {
    await requireActiveTenantMembership(client, context);
    return work(client);
  });
  const raw = async (work) => {
    const client = await pool.connect();
    try { await client.query('begin'); const out = await work(client); await client.query('commit'); return out; }
    catch (error) { try { await client.query('rollback'); } catch {} throw error; }
    finally { client.release(); }
  };
  // Helmian Site Guard (site-guard.mjs, bite A2): the intake rate
  // limiter — one per mesh instance, sharing the mesh's clock. Its
  // store is the in-process map inside the limiter itself; the
  // stated limits (per process, forgotten on restart) are written
  // where it is built, in site-guard.mjs.
  const siteGuardRate = siteGuardRateImpl ?? createSiteGuardRateLimiter({ now });

  return Object.freeze({
    async getConfig(actor, channelId) {
      return tx(actor, async (client) => {
        const channel = await channelRow(client, actor.tenantId, channelId);
        const config = await readConfig(client, actor.tenantId, channelId);
        return { channel: { id: String(channel.id), slug: channel.slug, title: channel.title, kind: channel.kind }, configured: Boolean(config), config: publicConfig(config, now()) };
      });
    },

    async changeConfig(actor, input) {
      const action = String(input?.action ?? '');
      const channelId = String(input?.channelId ?? '');
      const admin = ['owner', 'admin'].includes(String(actor.role));
      let posted = null; let linkCode = null;
      const result = await tx(actor, async (client) => {
        const channel = await channelRow(client, actor.tenantId, channelId);
        const config = (await readConfig(client, actor.tenantId, channelId)) ?? emptyConfig();
        if (action === 'add-agent' || action === 'remove-agent') {
          if (actor.role === 'auditor') throw fail(403, 'ENVOY_ROLE_FORBIDDEN');
          const customHandles = new Map((config.customAgents ?? []).map((a) => [a.handle || a.id, a]));
          const provider = normalizeProvider(input?.provider) ?? (customHandles.has(String(input?.provider ?? '').toLowerCase()) ? String(input?.provider).toLowerCase() : null);
          if (!provider) throw fail(400, 'ENVOY_AGENT_UNSUPPORTED');
          const has = config.agents.includes(provider);
          const label = customHandles.get(provider)?.name ?? AGENT_NAMES[provider] ?? provider;
          if (action === 'add-agent' && !has) {
            if (config.agents.length >= MAX_CHANNEL_AGENTS) throw fail(400, 'ENVOY_AGENT_LIMIT_REACHED');
            config.agents = [...config.agents, provider];
            config.joined = { ...(config.joined ?? {}), [provider]: new Date(now()).toISOString() };
            await writeConfig(client, actor.tenantId, channelId, config);
            posted = await notice(client, actor.tenantId, channelId, `${label} joined #${channel.title}.`);
          }
          if (action === 'remove-agent' && has) {
            config.agents = config.agents.filter((p) => p !== provider);
            await writeConfig(client, actor.tenantId, channelId, config);
            posted = await notice(client, actor.tenantId, channelId, `${label} left #${channel.title}.`);
          }
        } else if (action === 'create-custom-agent') {
          if (actor.role === 'auditor') throw fail(403, 'ENVOY_ROLE_FORBIDDEN');
          const custom = sanitizeCustomAgent(input?.agent ?? input);
          if (!custom) throw fail(400, 'ENVOY_CUSTOM_AGENT_INVALID');
          if ((config.customAgents ?? []).length >= MAX_CHANNEL_AGENTS) throw fail(400, 'ENVOY_AGENT_LIMIT_REACHED');
          const filtered = (config.customAgents ?? []).filter((a) => (a.handle || a.id) !== custom.handle);
          config.customAgents = [...filtered, custom];
          if (!config.agents.includes(custom.handle)) config.agents = [...config.agents, custom.handle];
          config.joined = { ...(config.joined ?? {}), [custom.handle]: new Date(now()).toISOString() };
          await writeConfig(client, actor.tenantId, channelId, config);
          const roleNote = custom.jobTitle ? ` (${custom.jobTitle})` : '';
          posted = await notice(client, actor.tenantId, channelId, `${custom.emoji} ${custom.name} (@${custom.handle})${roleNote} joined #${channel.title}.`);
        } else if (action === 'remove-custom-agent') {
          if (actor.role === 'auditor') throw fail(403, 'ENVOY_ROLE_FORBIDDEN');
          const handle = normalizeCustomHandle(input?.handle ?? input?.provider ?? input?.id);
          if (!handle) throw fail(400, 'ENVOY_CUSTOM_AGENT_INVALID');
          const existing = (config.customAgents ?? []).find((a) => (a.handle || a.id) === handle);
          config.customAgents = (config.customAgents ?? []).filter((a) => (a.handle || a.id) !== handle);
          config.agents = (config.agents ?? []).filter((p) => p !== handle);
          await writeConfig(client, actor.tenantId, channelId, config);
          if (existing) posted = await notice(client, actor.tenantId, channelId, `${existing.emoji} ${existing.name} (@${existing.handle}) retired from #${channel.title}.`);
        } else if (action === 'set-debate-mode') {
          if (actor.role === 'auditor') throw fail(403, 'ENVOY_ROLE_FORBIDDEN');
          const mode = input?.debateMode === 'free-willy' ? 'free-willy' : 'off';
          const turnsRaw = Number(input?.maxRoundTurns);
          const turns = Number.isFinite(turnsRaw) ? Math.max(1, Math.min(MAX_DEBATE_TURNS, Math.trunc(turnsRaw))) : (config.maxRoundTurns || DEFAULT_DEBATE_TURNS);
          config.debateMode = mode;
          config.maxRoundTurns = turns;
          await writeConfig(client, actor.tenantId, channelId, config);
          posted = await notice(client, actor.tenantId, channelId, mode === 'free-willy'
            ? `Free-Willy multi-agent debate mode enabled in #${channel.title} (up to ${turns} agent turns per round).`
            : `Free-Willy debate mode turned off in #${channel.title}.`);
        } else if (action === 'stop-debate') {
          if (actor.role === 'auditor') throw fail(403, 'ENVOY_ROLE_FORBIDDEN');
          config.debateMode = 'off';
          await writeConfig(client, actor.tenantId, channelId, config);
          posted = await notice(client, actor.tenantId, channelId, `Multi-agent debate stopped in #${channel.title}.`);
        } else if (action === 'set-armed-connectors') {
          if (actor.role === 'auditor') throw fail(403, 'ENVOY_ROLE_FORBIDDEN');
          // The plus menu's standing toggle list (Amendment 1 §2.3,
          // bite A2): the whole armed set for this channel, replaced
          // on every flip — the menu sends the full set, so the
          // stored set is exactly what the last flip left. A
          // non-array payload is refused outright; malformed pairs
          // are dropped by the sanitizer, never stored. No notice —
          // a connector choice is composer furniture, not a room
          // event (the channel-avatar precedent). Dispatch reads
          // the set at work-item time (agentWork below, Mirror M3
          // bite G4): this stored set, unioned with the message's
          // own metadata.connectors, is what gets resolved into
          // arming records for the seats due.
          if (!Array.isArray(input?.armedConnectors)) throw fail(400, 'ENVOY_ARMED_CONNECTORS_INVALID');
          config.armedConnectors = sanitizeArmedConnectors(input.armedConnectors);
          await writeConfig(client, actor.tenantId, channelId, config);
        } else if (action === 'set-channel-avatar') {
          if (actor.role === 'auditor') throw fail(403, 'ENVOY_ROLE_FORBIDDEN');
          // The channel's face (emoji bite 5): a sanitized avatar
          // choice, or null to clear back to the desk's default look.
          // No notice — a cosmetic change does not need a room event;
          // the config the caller gets back carries the new look.
          config.avatar = sanitizeChannelAvatar(input?.avatar);
          await writeConfig(client, actor.tenantId, channelId, config);
        } else if (action === 'link-github') {
          if (!admin) throw fail(403, 'ENVOY_ADMIN_REQUIRED');
          const gh = sanitizeGithubLink({ repo: input?.repo, events: input?.events, linkedAt: new Date(now()).toISOString() });
          if (!gh) throw fail(400, 'ENVOY_GITHUB_REPO_INVALID');
          config.github = gh;
          await writeConfig(client, actor.tenantId, channelId, config);
          posted = await notice(client, actor.tenantId, channelId, `#${channel.title} is now linked to GitHub repository ${gh.repo}.`);
        } else if (action === 'unlink-github') {
          if (!admin) throw fail(403, 'ENVOY_ADMIN_REQUIRED');
          if (config.github) {
            const was = config.github;
            config.github = null;
            await writeConfig(client, actor.tenantId, channelId, config);
            posted = await notice(client, actor.tenantId, channelId, `#${channel.title} is no longer linked to GitHub repository ${was.repo}.`);
          }
        } else if (action === 'link-discord') {
          if (!admin) throw fail(403, 'ENVOY_ADMIN_REQUIRED');
          linkCode = newLinkCode();
          config.pendingLink = { codeHash: sha256(linkCode), expiresAt: new Date(now() + LINK_CODE_TTL_MS).toISOString() };
          await writeConfig(client, actor.tenantId, channelId, config);
        } else if (action === 'unlink-discord') {
          if (!admin) throw fail(403, 'ENVOY_ADMIN_REQUIRED');
          if (config.discord || config.pendingLink) {
            const was = config.discord;
            config.discord = null; config.pendingLink = null;
            await writeConfig(client, actor.tenantId, channelId, config);
            if (was) posted = await notice(client, actor.tenantId, channelId, `#${channel.title} is no longer linked to Discord #${was.channelName || was.channelId}.`);
          }
        } else if (action === 'link-slack') {
          if (!admin) throw fail(403, 'ENVOY_ADMIN_REQUIRED');
          linkCode = newLinkCode();
          config.pendingLink = { codeHash: sha256(linkCode), expiresAt: new Date(now() + LINK_CODE_TTL_MS).toISOString() };
          await writeConfig(client, actor.tenantId, channelId, config);
        } else if (action === 'unlink-slack') {
          if (!admin) throw fail(403, 'ENVOY_ADMIN_REQUIRED');
          if (config.slack || config.pendingLink) {
            const was = config.slack;
            config.slack = null; config.pendingLink = null;
            await writeConfig(client, actor.tenantId, channelId, config);
            if (was) posted = await notice(client, actor.tenantId, channelId, `#${channel.title} is no longer linked to Slack #${was.channelName || was.channelId}.`);
          }
        } else {
          throw fail(400, 'ENVOY_CONFIG_ACTION_UNSUPPORTED');
        }
        return { config: publicConfig(config, now()), configured: true };
      });
      publish(actor.tenantId, posted, publishImpl);
      return linkCode ? { ...result, linkCode, linkCommand: `helmian link ${linkCode}` } : result;
    },

    // Messages in this tenant that one of `providers` should answer and has not.
    async agentWork(actor, providers) {
      if (actor.viaDeviceToken !== true) throw fail(403, 'ENVOY_DEVICE_TOKEN_REQUIRED');
      const rawTokens = String(providers ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
      const wantedStd = [...new Set(rawTokens.map(normalizeProvider).filter(Boolean))];
      const wantedHandles = new Set(rawTokens.map(normalizeCustomHandle).filter(Boolean));
      if (!wantedStd.length && !wantedHandles.size) throw fail(400, 'ENVOY_AGENT_UNSUPPORTED');
      // Guard refusals written inside the transaction (below) are
      // published only after it commits, like every other message this
      // store posts; the rows are collected here for that.
      const refusalRows = [];
      // Guard spine bite 3: every evaluation outcome from this poll —
      // allows and refusals alike — is collected here and witnessed
      // into the Guard findings feed after the transaction commits
      // (envoy-findings.mjs). The chat action leaves no job: it is
      // never evaluated, so there is nothing to record.
      const findingJobs = [];
      // Helmian Site Guard (site-guard.mjs, bite A1): every screen
      // from this poll that fired — an injection flag on a dispatched
      // message, or the destructive class that stopped one — is
      // collected here and witnessed into the same Guard findings
      // feed after the transaction commits, through the wrapper that
      // cannot throw. Collection is in-transaction only; the write
      // itself runs post-commit on the pool, like bite 3's.
      const siteGuardJobs = [];
      // Helmian Site Guard (site-guard.mjs, bite A2): every rate
      // TRIP from this poll — the flag crossing and the stop
      // crossing, one job each, never one per message — is collected
      // here and witnessed into the same feed in the same
      // post-commit block, through the same never-throw discipline.
      const siteGuardRateJobs = [];
      // Librarian (envoy-librarian.mjs): every dispatched human ask
      // this poll hands out — allowed or refused — is collected here
      // and filed into the shared notebook after the transaction
      // commits, beside the findings ingest, through wrappers that
      // cannot throw. A channel still carrying a generic fallback
      // title contributes one naming candidate per poll: its earliest
      // human message in the window, from which the librarian derives
      // the name. Collection is in-transaction only; all librarian
      // writes run post-commit on the pool, so a librarian failure
      // can never poison or veto a dispatch.
      const librarianJobs = [];
      const namingJobs = new Map();
      // Knowledge base incidents born in this poll: a Guard refusal
      // is an AI (or a human's ask) hitting a wall — the librarian
      // files it as an OPEN incident in the knowledge base
      // (envoy-librarian.mjs, sql/076), categorized by the filing
      // engine, so the refusal becomes a reviewable, solvable row
      // instead of a scrolled-past line. Collected in-transaction;
      // filed post-commit through the fail-soft wrapper, like every
      // librarian write.
      const incidentJobs = [];
      // Notebook block (envoy-notebook.mjs, coverage bite 2): the
      // tenant's shared-notebook content, read at dispatch time and
      // ridden on every work item this poll hands out. Loaded lazily
      // — a poll with no due work never touches the notebook — and at
      // most once per poll, however many items it builds. The read
      // runs on the pool, outside the dispatch transaction, and is
      // fail-soft in both layers: the reader itself never throws, and
      // a throwing injected reader is caught here and logged, so a
      // notebook failure changes nothing about dispatch — the work
      // items simply carry no block, exactly as before this bite.
      let notebookPromise = null;
      const loadNotebook = () => {
        if (!notebookPromise) {
          notebookPromise = (async () => {
            const log = notebookLogImpl ?? ((...args) => console.error(...args));
            try {
              return await (notebookImpl ?? ((p, t) => readNotebookBlock(p, t, { log })))(pool, actor.tenantId);
            } catch (error) {
              log(`[envoy-notebook] notebook read FAILED for tenant ${actor.tenantId}: ${error?.message ?? error} — seats answer without the notebook block this poll; dispatch is unchanged.`);
              return null;
            }
          })();
        }
        return notebookPromise;
      };
      // Knowledge base block (envoy-librarian.mjs): the tenant's
      // solved incidents — mistakes already made here, and the fixes
      // that worked — read once per poll that hands out work and
      // ridden on the work items beside the notebook block, so
      // recall is immediate: the seat sees the workspace's own
      // scar tissue in the same prompt as the ask. Same fail-soft
      // discipline as the notebook in both layers.
      let kbPromise = null;
      const loadKnowledgeBase = () => {
        if (!kbPromise) {
          kbPromise = (async () => {
            const log = kbLogImpl ?? ((...args) => console.error(...args));
            try {
              return await (kbImpl ?? ((p, a) => readKnowledgeBaseBlock(p, a, { log })))(pool, actor);
            } catch (error) {
              log(`[envoy-librarian] knowledge base read FAILED for tenant ${actor.tenantId}: ${error?.message ?? error} — seats answer without the knowledge base block this poll; dispatch is unchanged.`);
              return null;
            }
          })();
        }
        return kbPromise;
      };
      // Skills (skill-library.mjs, slash-skills bite S1): the records
      // behind a due message's metadata.skills, read at dispatch time
      // through the skill store over the pool (never the dispatch
      // transaction, the notebook's discipline) and cached per poll by
      // skill id, so a poll reads each named skill at most once
      // however many due messages name it. Fail-soft, with the
      // distinction kept sharp: a FAILED read (the store threw) is
      // sticky for the poll — loadSkillRecords returns null and work
      // items carry no skills, exactly as before this bite — while a
      // skill the read simply does not return (deleted, or another
      // tenant's; the tenant-scoped read makes the two
      // indistinguishable, which is the point) is cached as known-
      // missing and rides the work item as { missing: true } so the
      // turn states the honest line (DESIGN §2.4).
      const skillCache = new Map();
      let skillReadFailed = false;
      const loadSkillRecords = async (ids) => {
        if (skillReadFailed) return null;
        const wanted = [...new Set(ids)].filter((id) => !skillCache.has(id));
        if (wanted.length) {
          const log = skillLogImpl ?? ((...args) => console.error(...args));
          try {
            const found = await (skillReadImpl ?? readSkillRecords)(pool, actor.tenantId, wanted);
            const entries = found instanceof Map ? [...found.entries()] : (Array.isArray(found) ? found.map((r) => [r?.id, r]) : []);
            for (const id of wanted) skillCache.set(id, null);
            for (const [id, record] of entries) {
              if (record && skillCache.has(id)) skillCache.set(id, record);
            }
          } catch (error) {
            skillReadFailed = true;
            log(`[envoy-mesh] skill read FAILED for tenant ${actor.tenantId}: ${error?.message ?? error} — work items carry no skills this poll; dispatch is unchanged.`);
            return null;
          }
        }
        return skillCache;
      };
      // Connector arming (connector-arming-dispatch.mjs, Mirror M3
      // bite G4): the arming facts behind a due message's armed
      // connectors — the message author's own connection, its
      // posture, its frozen tool set, and the turn's token —
      // resolved at dispatch time over the pool (the connector
      // library and the credential service are cloud-side; the
      // runner has no road to either) and ridden on the work item
      // under connectorConnections, the field bin/pc-bridge.mjs
      // already forwards into the child's turn request. Cached per
      // poll by (channel, author, pair set). Same fail-soft
      // discipline as skills: a FAILED resolution (the store or the
      // credential service threw) is sticky for the poll —
      // loadArmingRecords returns null and work items carry no
      // arming, exactly as before this bite — while per-pair domain
      // outcomes (not connected, needs reconnect, freeze failed)
      // ride as state records so the turn states the honest reason
      // instead of the generic one.
      const armingCache = new Map();
      let armingReadFailed = false;
      const loadArmingRecords = async (channelId, personId, pairs) => {
        if (armingReadFailed || !pairs.length) return null;
        const cacheKey = `${channelId}|${personId}|${pairs.map((p) => `${p.seatId}:${p.entryId}`).join(',')}`;
        if (armingCache.has(cacheKey)) return armingCache.get(cacheKey);
        const log = armingLogImpl ?? ((...args) => console.error(...args));
        try {
          const records = await (armingReadImpl ?? ((input) => resolveDispatchArming({ pool, ...input })))({ tenantId: actor.tenantId, personId, pairs });
          armingCache.set(cacheKey, records);
          return records;
        } catch (error) {
          armingReadFailed = true;
          log(`[envoy-mesh] connector arming resolution FAILED for tenant ${actor.tenantId}: ${error?.message ?? error} — work items carry no connector arming this poll; dispatch is unchanged.`);
          return null;
        }
      };
      const result = await tx(actor, async (client) => {
        // Claim gate (tenant-agent-state.mjs): once a tenant has ANY
        // readiness signal — a registered runner, a presence report, a
        // stored connection — those signals are authoritative: work is
        // handed over only for providers the tenant itself has a
        // credential for, and withheld providers are named in the
        // response instead of the message silently sitting. A tenant
        // with no signals at all is the hand-wired case (the operator's
        // own runners resolve credentials locally); its claiming is
        // exactly what it was before this gate existed.
        const state = await (agentStateImpl ?? tenantAgentStateOn)(client, actor.tenantId);
        const gate = claimGateFor(state);
        const withheld = new Map();
        const cfgRows = await client.query(
          `select distinct on (channel_id) channel_id, body from helmion.envoy_messages where tenant_id=$1 and author_subject=$2 order by channel_id, created_at desc, id desc`,
          [actor.tenantId, CONFIG_SUBJECT],
        );
        const since = new Date(now() - WORK_WINDOW_MS).toISOString();
        const work = [];
        for (const cfgRow of cfgRows.rows) {
          const config = parseConfig(cfgRow.body);
          if (!config) continue;
          const customByHandle = new Map((config.customAgents ?? []).map((a) => [a.handle || a.id, a]));
          const isWanted = (p) => {
            if (wantedStd.includes(p) || wantedHandles.has(p)) return true;
            const c = customByHandle.get(p);
            return Boolean(c && wantedStd.includes(c.provider));
          };
          if (!config.agents.some(isWanted)) continue;
          const channel = await channelRow(client, actor.tenantId, String(cfgRow.channel_id));
          const recent = await client.query(
            `select ${MSG_COLS} from helmion.envoy_messages where tenant_id=$1 and channel_id=$2 and author_subject <> $3 and created_at > $4 order by created_at desc, id desc limit 40`,
            [actor.tenantId, channel.id, CONFIG_SUBJECT, since],
          );
          const rows = recent.rows.reverse();
          // Librarian naming candidate: a channel still carrying a
          // generic fallback title is named from its earliest human
          // message in this window at this dispatch (post-commit,
          // compare-and-swap on the observed title — a human-set
          // name is never overwritten, and once named the title is
          // no longer generic, so this fires once).
          if (isGenericChannelTitle(channel.title) && !namingJobs.has(String(channel.id))) {
            const firstHuman = rows.find((r) => r.author_kind === 'human');
            if (firstHuman && deriveChannelName(String(firstHuman.body ?? ''))) {
              namingJobs.set(String(channel.id), { channelId: String(channel.id), observedTitle: channel.title, fromBody: String(firstHuman.body ?? '') });
            }
          }
          const answered = new Set(rows.filter((r) => String(r.idempotency_key).startsWith('reply:')).map((r) => `${r.author_subject}|${String(r.idempotency_key).slice(6)}`));
          // Count consecutive agent turns since the last human message for Free-Willy debate mode.
          let roundTurns = 0;
          for (const r of rows) {
            if (r.author_kind === 'human') roundTurns = 0;
            else if (r.author_kind === 'agent') roundTurns += 1;
          }
          // Only messages after the agent joined count.
          for (const row of rows) {
            const message = messageOut(row);
            // Guard spine bite 2: a Guard refusal record (the outcome
            // rides in the message metadata, spread onto the message by
            // messageOut) is terminal. It is never itself a work source,
            // so a refusal can never route, join a debate, or be
            // re-evaluated as an ask.
            if (message.guard) continue;
            const at = new Date(row.created_at).getTime();
            // Maestro always-on (Troy's ruling, 2026-11-09): desk-style
            // dispatch is how EVERY channel routes now — an unnamed
            // human send reaches the channel's crew, a named send picks
            // the named seat. The desk flag and the retired per-channel
            // maestroFollow flag are no longer consulted here: a stored
            // maestroFollow:false must not restore the old silence.
            // A private agent room (kind 'agent') seats one agent, so
            // its crew is that agent either way.
            let due = agentsToAnswer(message, config.agents, {
              desk: true,
              room: channel.kind === 'agent',
              debateMode: config.debateMode ?? 'off',
              roundTurns,
              maxRoundTurns: config.maxRoundTurns ?? DEFAULT_DEBATE_TURNS,
              customAgents: config.customAgents ?? [],
            }).filter((p) => isWanted(p) && !answered.has(`agent:${p}|${message.id}`) && !(config.joined?.[p] && at < Date.parse(config.joined[p])));
            if (gate) {
              const gateAllows = (p) => {
                if (gate.has(p)) return true;
                const c = customByHandle.get(p);
                return Boolean(c && gate.has(c.provider));
              };
              for (const p of due) if (!gateAllows(p)) withheld.set(p, state.reason ?? 'no-provider');
              due = due.filter(gateAllows);
            }
            if (!due.length) continue;
            // Guard spine, bites 1 + 2: the ask is classified as a typed
            // action (envoy-actions.mjs) and, when it is typed, evaluated
            // through the governance kernel (envoy-guard.mjs) BEFORE the
            // work item is handed to an executor. An allow dispatches
            // unchanged apart from the evaluation record riding along;
            // a refuse dispatches nothing — each due seat's reply is the
            // refusal, written in its name with the outcome record in
            // its metadata, which also marks the ask answered for that
            // seat so no later poll can hand it out again. The chat
            // (null) action is never evaluated and carries no record.
            // Every typed outcome, allow or refuse, also becomes a
            // Guard finding after commit (bite 3, findingJobs below).
            const action = classifySeatAsk(message.body);
            const evaluation = evaluateSeatAction(action, { body: message.body, workspace: guardWorkspace });
            if (evaluation?.verdict === 'refuse') {
              const text = guardRefusalText(evaluation);
              for (const p of due) {
                const { row: refusal, replayed } = await insertMessage(client, {
                  tenantId: actor.tenantId,
                  channelId: String(channel.id),
                  subject: agentSubject(p, config.customAgents ?? []),
                  kind: 'agent',
                  body: text,
                  key: `reply:${message.id}`,
                  metadata: { guard: evaluation },
                });
                if (refusal && !replayed) refusalRows.push(refusal);
                findingJobs.push({ evaluation, seat: p, seatSubject: agentSubject(p, config.customAgents ?? []), channelId: String(channel.id), channelSlug: channel.slug, messageId: message.id });
              }
              // A refused ask was still dispatched — the librarian
              // files it with the Guard's decision riding along.
              if (message.authorKind === 'human') {
                librarianJobs.push({ channelId: String(channel.id), channelSlug: channel.slug, channelTitle: channel.title, messageId: message.id, humanSubject: message.authorSubject, humanName: message.authorName ?? null, seats: due, guardDecision: evaluation?.verdict ?? null, excerpt: message.body, at: new Date(now()).toISOString() });
                // …and into the knowledge base as an open incident:
                // a refusal is a wall an ask hit; filed once per
                // refused message (the key makes replays no-ops),
                // categorized by the filing engine, awaiting the
                // review that solves or supersedes it.
                incidentJobs.push({ key: `guard-ask:${message.id}`, title: `Guard refused an ask in ${channel.title}`, mistake: message.body, actor: message.authorSubject, source: 'guard', evidence: { channelId: String(channel.id), channelSlug: channel.slug, messageId: message.id, verdict: 'refuse' } });
              }
              continue;
            }
            // Helmian Site Guard (site-guard.mjs, bite A1): the
            // intake screen. It runs here — after the Guard spine's
            // evaluation above, so a spine refusal keeps the spine's
            // own record untouched, and before the work item is
            // built, so nothing reaches a seat unscreened. Every due
            // message is screened, whatever road it arrived by (the
            // desk, a bridge, a debate turn): the spine judges typed
            // asks, but content itself was never screened — a chat
            // message carrying prompt-injection markers, or a
            // kernel-shaped destruction the ask classifier's subset
            // never types, passed with no record at all.
            // A flag (the prompt-injection class) is witnessed into
            // the Guard findings feed after commit and changes
            // nothing about the turn. The destructive class is the
            // one stop — the Site Guard intake stop: no work item is
            // handed out, and each due seat's reply is the Site
            // Guard's refusal, written in its name with the stop
            // record in its metadata, marking the message answered
            // for that seat exactly as a spine refusal does.
            // Helmian Site Guard (site-guard.mjs, bite A2): the
            // intake rate limit. Every due message is observed
            // once, per tenant and per sender, BEFORE the content
            // screen: volume is the cheaper signal, and a sender
            // already over the stop line does not reach the screen
            // at all. A spine-refused ask never arrives here (it
            // continued above), so refused asks do not count toward
            // a sender's rate — the limit judges delivered intake,
            // the same set the screen judges. The flag crossing is
            // witnessed after commit and the turn proceeds exactly
            // as before; the stop line is the rate stop: no work
            // item is handed out, and each due seat's reply is the
            // Site Guard's rate refusal, written in its name with
            // the stop record in its metadata, marking the message
            // answered for that seat exactly as the intake stop
            // does. Any later message from the same sender is
            // stopped the same way while its count stands over the
            // line, and dispatched again once the window cools.
            const rateVerdict = siteGuardRate.observe({
              tenantId: actor.tenantId,
              senderKey: siteGuardSenderKey({ authorSubject: message.authorSubject, authorKind: message.authorKind }),
            });
            if (rateVerdict.tripped) {
              siteGuardRateJobs.push({ verdict: rateVerdict, tenantId: actor.tenantId, channelId: String(channel.id), channelSlug: channel.slug, messageId: message.id, authorKind: message.authorKind });
            }
            if (rateVerdict.stopped) {
              const text = siteGuardRateRefusalText(rateVerdict);
              for (const p of due) {
                const { row: refusal, replayed } = await insertMessage(client, {
                  tenantId: actor.tenantId,
                  channelId: String(channel.id),
                  subject: agentSubject(p, config.customAgents ?? []),
                  kind: 'agent',
                  body: text,
                  key: `reply:${message.id}`,
                  metadata: { guard: siteGuardRateStopRecord(rateVerdict) },
                });
                if (refusal && !replayed) refusalRows.push(refusal);
              }
              continue;
            }
            const screening = screenIntakeContent(message.body);
            if (screening.classes.length) {
              siteGuardJobs.push({ screening, channelId: String(channel.id), channelSlug: channel.slug, messageId: message.id, authorKind: message.authorKind });
              if (screening.blocked) {
                const text = siteGuardRefusalText(screening);
                for (const p of due) {
                  const { row: refusal, replayed } = await insertMessage(client, {
                    tenantId: actor.tenantId,
                    channelId: String(channel.id),
                    subject: agentSubject(p, config.customAgents ?? []),
                    kind: 'agent',
                    body: text,
                    key: `reply:${message.id}`,
                    metadata: { guard: siteGuardStopRecord(screening) },
                  });
                  if (refusal && !replayed) refusalRows.push(refusal);
                }
                continue;
              }
            }
            const context = rows.filter((r) => new Date(r.created_at) <= new Date(row.created_at) && r.author_kind !== 'system').slice(-12).map(messageOut);
            const notebook = await loadNotebook();
            const knowledgeBase = await loadKnowledgeBase();
            // Skills ride only when the message names them: resolve
            // its toggles against the records this poll read, clamped
            // to each record's own scope, for the seats due here. A
            // failed read leaves the item skill-less (loadSkillRecords
            // returned null); an untouched message never gains the
            // field, so its work item is exactly what it has always
            // been.
            const skillToggles = Array.isArray(message.metadata?.skills) ? message.metadata.skills : [];
            let skills;
            if (skillToggles.length) {
              const records = await loadSkillRecords(skillToggles.map((t) => t.skillId));
              if (records) skills = resolveDispatchSkills(skillToggles, records, due);
            }
            // Connector arming rides only on human asks: the
            // connections a turn may use are the AUTHOR's own, and
            // an agent-authored debate row names no person whose
            // connections they would be. The pair set is the
            // channel's standing armed set unioned with the
            // message's own toggles, filtered to the seats due here
            // (connector-arming-dispatch.mjs).
            let armingRecords;
            if (message.authorKind === 'human') {
              const pairs = armingPairsForDispatch({
                armedConnectors: config.armedConnectors,
                messageConnectors: message.metadata?.connectors,
                dueProviders: due,
                customAgents: config.customAgents ?? [],
              });
              if (pairs.length) armingRecords = await loadArmingRecords(String(channel.id), message.authorSubject, pairs);
            }
            work.push({
              channel: {
                id: String(channel.id),
                slug: channel.slug,
                title: channel.title,
                linkedToDiscord: Boolean(config.discord),
                linkedToSlack: Boolean(config.slack),
                linkedToGithub: Boolean(config.github),
                debateMode: config.debateMode ?? 'off',
                maxRoundTurns: config.maxRoundTurns ?? DEFAULT_DEBATE_TURNS,
              },
              members: config.agents,
              ...(config.customAgents?.length ? { customAgents: config.customAgents } : {}),
              ...(notebook ? { notebook } : {}),
              ...(knowledgeBase ? { knowledgeBase } : {}),
              ...(skills?.length ? { skills } : {}),
              ...(armingRecords?.length ? { connectorConnections: armingRecords } : {}),
              message,
              action,
              ...(evaluation ? { evaluation } : {}),
              agents: due,
              context,
            });
            if (evaluation) {
              for (const p of due) {
                findingJobs.push({ evaluation, seat: p, seatSubject: agentSubject(p, config.customAgents ?? []), channelId: String(channel.id), channelSlug: channel.slug, messageId: message.id });
              }
            }
            // Librarian: file every dispatched human ask (the chat
            // action included — an untyped ask is still an ask the
            // channel's memory should carry). Agent turns in debate
            // mode are not human asks and are not filed.
            if (message.authorKind === 'human') {
              librarianJobs.push({ channelId: String(channel.id), channelSlug: channel.slug, channelTitle: channel.title, messageId: message.id, humanSubject: message.authorSubject, humanName: message.authorName ?? null, seats: due, guardDecision: evaluation?.verdict ?? null, excerpt: message.body, at: new Date(now()).toISOString() });
            }
          }
        }
        return {
          work: work.slice(0, 20),
          agentState: { state: state.state, gated: state.gated },
          ...(withheld.size ? { withheld: [...withheld].map(([provider, reason]) => ({ provider, reason })) } : {}),
        };
      });
      for (const row of refusalRows) publish(actor.tenantId, row, publishImpl);
      // Guard spine bite 3: witness every evaluation this poll produced
      // into the Guard findings feed, allows and refusals alike. This
      // runs after the transaction commits and through a wrapper that
      // cannot throw, so a findings-write failure is logged loudly and
      // changes nothing about the work handed out or the refusals
      // posted above. The Helmian Site Guard's screens from this poll
      // (bite A1) and its rate trips (bite A2) are witnessed in the
      // same block, through the same kind of wrapper, into the same
      // feed.
      if (findingJobs.length || siteGuardJobs.length || siteGuardRateJobs.length) {
        const findings = guardStoreImpl ?? createGuardStore(pool);
        const evaluatedAt = new Date(now()).toISOString();
        for (const job of findingJobs) {
          await ingestEvaluationFinding(findings, actor, job.evaluation, { ...job, at: evaluatedAt }, guardLogImpl ? { log: guardLogImpl } : {});
        }
        for (const job of siteGuardJobs) {
          await ingestSiteGuardFindings(findings, actor, job.screening, { ...job, at: evaluatedAt }, siteGuardLogImpl ? { log: siteGuardLogImpl } : {});
        }
        for (const job of siteGuardRateJobs) {
          await ingestSiteGuardRateFinding(findings, actor, job.verdict, job, siteGuardLogImpl ? { log: siteGuardLogImpl } : {});
        }
      }
      // Librarian: file this poll's dispatched asks into the shared
      // notebook and name any still-generic channel from its first
      // human message. Post-commit and through the fail-soft
      // wrappers, like the findings ingest above: a librarian
      // failure is logged loudly and changes nothing about the work
      // handed out or the refusals posted.
      if (librarianJobs.length || namingJobs.size || incidentJobs.length) {
        const librarian = librarianImpl ?? createLibrarianStore(pool);
        const librarianOpts = librarianLogImpl ? { log: librarianLogImpl } : {};
        for (const job of librarianJobs) {
          await fileDispatchAsk(librarian, actor, job, librarianOpts);
        }
        for (const naming of namingJobs.values()) {
          await nameChannelIfGeneric(librarian, actor, naming, librarianOpts);
        }
        for (const incident of incidentJobs) {
          await fileIncidentFromDispatch(librarian, actor, incident, librarianOpts);
        }
      }
      return result;
    },

    async postAsAgent(actor, input) {
      if (actor.viaDeviceToken !== true) throw fail(403, 'ENVOY_DEVICE_TOKEN_REQUIRED');
      const stdProvider = normalizeProvider(input?.provider);
      const customHandle = normalizeCustomHandle(input?.provider);
      const provider = stdProvider ?? customHandle;
      if (!provider) throw fail(400, 'ENVOY_AGENT_UNSUPPORTED');
      // No reply is ever authored by Maestro: Maestro is the human's
      // seat, not an agent, so a 'maestro' post is refused outright —
      // even where a historical roster still lists it (Bite 2).
      if (provider === 'maestro') throw fail(400, 'ENVOY_AGENT_NOT_AN_AGENT');
      const body = String(input?.body ?? '').trim();
      if (!body || body.length > 4000) throw fail(400, 'ENVOY_MESSAGE_INVALID');
      const replyTo = input?.replyTo ? String(input.replyTo) : null;
      if (replyTo && !/^[0-9a-f-]{36}$/i.test(replyTo)) throw fail(400, 'ENVOY_REPLY_INVALID');
      const key = replyTo ? `reply:${replyTo}` : String(input?.idempotencyKey ?? '').trim();
      if (key.length < 8 || key.length > 200) throw fail(400, 'ENVOY_IDEMPOTENCY_INVALID');
      let out = null;
      let answeredProvider = null;
      const result = await tx(actor, async (client) => {
        const channel = await channelRow(client, actor.tenantId, String(input?.channelId ?? ''));
        const config = await readConfig(client, actor.tenantId, String(channel.id));
        if (!stdProvider && !(config?.customAgents ?? []).some((a) => (a.handle || a.id) === provider)) {
          throw fail(400, 'ENVOY_AGENT_UNSUPPORTED');
        }
        if (!config?.agents.includes(provider)) throw fail(403, 'ENVOY_AGENT_NOT_MEMBER');
        const { row, replayed } = await insertMessage(client, { tenantId: actor.tenantId, channelId: String(channel.id), subject: agentSubject(provider, config?.customAgents ?? []), kind: 'agent', body, key });
        if (!row) throw fail(500, 'ENVOY_RECEIPT_NOT_DURABLE');
        if (!replayed) {
          out = row;
          answeredProvider = stdProvider ?? answeredEngineFor(config?.customAgents ?? [], provider);
        }
        return { receipt: { durable: true, replayed, message: messageOut(row) } };
      });
      publish(actor.tenantId, out, publishImpl);
      // A fresh (non-replayed) reply just proved this provider's road:
      // stamp the answer time on its presence row, after the reply's own
      // transaction has committed.
      if (answeredProvider) await stampAgentAnswered(pool, actor.tenantId, answeredProvider);
      return result;
    },

    // Private agent rooms (envoy-rooms.mjs): a kind 'agent' channel is one
    // agent's own room, and its roster is exactly that agent, seeded once
    // when the room is created. An existing config is never rewritten —
    // if the room already has one, it stands as it is.
    async seedRoomAgent(actor, channelId, provider) {
      const p = normalizeProvider(provider);
      if (!p) throw fail(400, 'ENVOY_AGENT_UNSUPPORTED');
      // Maestro has no private room: it is the human's seat, not an agent.
      if (p === 'maestro') throw fail(400, 'ENVOY_AGENT_NOT_AN_AGENT');
      return tx(actor, async (client) => {
        const channel = await channelRow(client, actor.tenantId, channelId);
        if (channel.kind !== 'agent') throw fail(400, 'ENVOY_ROOM_KIND_INVALID');
        const existing = await readConfig(client, actor.tenantId, channelId);
        if (existing) return { seeded: false, configured: true };
        const config = emptyConfig();
        config.agents = [p];
        config.joined = { [p]: new Date(now()).toISOString() };
        await writeConfig(client, actor.tenantId, channelId, config);
        return { seeded: true, configured: true };
      });
    },

    // The Maestro desk (envoy-maestro.mjs): the tenant's one manager-seat
    // channel (reserved slug). Its config is seeded once and carries
    // desk:true — the flag that switches this channel's human sends to
    // dispatch routing in agentsToAnswer (see agentWork above). The
    // roster is the union of the agents seated in the tenant's other
    // channels, or every worker agent when the desk is the first thing
    // configured. 'maestro' is never on it: in the desk, Maestro is the
    // human sending. An existing config is never rewritten.
    async seedDesk(actor, channelId) {
      return tx(actor, async (client) => {
        const channel = await channelRow(client, actor.tenantId, channelId);
        if (channel.slug !== MAESTRO_DESK_SLUG) throw fail(400, 'ENVOY_DESK_INVALID');
        const existing = await readConfig(client, actor.tenantId, channelId);
        if (existing) return { seeded: false, configured: true, agents: existing.agents };
        const others = await client.query('select id from helmion.envoy_channels where tenant_id=$1 and id<>$2', [actor.tenantId, channel.id]);
        const seated = new Set();
        for (const row of others.rows) {
          const cfg = await readConfig(client, actor.tenantId, String(row.id));
          for (const p of cfg?.agents ?? []) if (p !== 'maestro') seated.add(p);
        }
        const roster = AGENT_PROVIDERS.filter((p) => seated.has(p));
        const config = emptyConfig();
        config.desk = true;
        config.agents = roster.length ? roster : [...DESK_ROSTER_FALLBACK];
        const stamp = new Date(now()).toISOString();
        config.joined = Object.fromEntries(config.agents.map((p) => [p, stamp]));
        await writeConfig(client, actor.tenantId, channelId, config);
        return { seeded: true, configured: true, agents: config.agents };
      });
    },

    // ---- Bridge services (Discord + Slack) ----
    async bridgeLinks() {
      return raw(async (client) => {
        const r = await client.query(
          `select distinct on (tenant_id, channel_id) tenant_id, channel_id, body from helmion.envoy_messages where author_subject=$1 order by tenant_id, channel_id, created_at desc, id desc`,
          [CONFIG_SUBJECT],
        );
        const links = [];
        const slackLinks = [];
        for (const row of r.rows) {
          const config = parseConfig(row.body);
          if (config?.discord) links.push({ tenantId: String(row.tenant_id), envoyChannelId: String(row.channel_id), guildId: config.discord.guildId, discordChannelId: config.discord.channelId, agents: config.agents });
          if (config?.slack) slackLinks.push({ tenantId: String(row.tenant_id), envoyChannelId: String(row.channel_id), teamId: config.slack.teamId, slackChannelId: config.slack.channelId, agents: config.agents });
        }
        return { links, slackLinks };
      });
    },

    async bridgeConfirmLink(input) {
      const code = String(input?.code ?? '').trim().toUpperCase();
      if (!/^[A-Z2-9]{8}$/.test(code)) throw fail(400, 'ENVOY_LINK_CODE_INVALID');
      if (String(input?.provider ?? 'discord') === 'slack') {
        const teamId = String(input?.teamId ?? ''); const slackChannelId = String(input?.channelId ?? '');
        if (!isSlackId(teamId) || !isSlackId(slackChannelId)) throw fail(400, 'SLACK_IDS_INVALID');
        const hash = sha256(code);
        let posted = null; let tenantId = null;
        const result = await raw(async (client) => {
          const r = await client.query(
            `select distinct on (tenant_id, channel_id) tenant_id, channel_id, body from helmion.envoy_messages where author_subject=$1 and body like $2 order by tenant_id, channel_id, created_at desc, id desc`,
            [CONFIG_SUBJECT, `%${hash}%`],
          );
          const hit = r.rows.map((row) => ({ row, config: parseConfig(row.body) })).find((x) => x.config?.pendingLink?.codeHash === hash && Date.parse(x.config.pendingLink.expiresAt) > now());
          if (!hit) throw fail(404, 'ENVOY_LINK_CODE_UNKNOWN');
          // The newest config for that channel must still be the one holding this code.
          tenantId = String(hit.row.tenant_id);
          await setTenant(client, tenantId);
          const current = await readConfig(client, tenantId, String(hit.row.channel_id));
          if (current?.pendingLink?.codeHash !== hash) throw fail(404, 'ENVOY_LINK_CODE_UNKNOWN');
          // One Envoy channel per Slack channel.
          const taken = (await this.bridgeLinks()).slackLinks.find((l) => l.slackChannelId === slackChannelId && !(l.tenantId === tenantId && l.envoyChannelId === String(hit.row.channel_id)));
          if (taken) throw fail(409, 'SLACK_CHANNEL_ALREADY_LINKED');
          const channel = await channelRow(client, tenantId, String(hit.row.channel_id));
          current.pendingLink = null;
          current.slack = { teamId, channelId: slackChannelId, channelName: String(input?.channelName ?? '').slice(0, 100), teamName: String(input?.teamName ?? '').slice(0, 100), linkedAt: new Date(now()).toISOString() };
          await writeConfig(client, tenantId, String(channel.id), current);
          posted = await notice(client, tenantId, String(channel.id), `#${channel.title} is now linked to Slack #${current.slack.channelName || slackChannelId}${current.slack.teamName ? ` in ${current.slack.teamName}` : ''}. Messages posted there now appear here.`);
          return { tenantId, envoyChannelId: String(channel.id), envoyChannelTitle: channel.title, agents: current.agents };
        });
        publish(tenantId, posted, publishImpl);
        return result;
      }
      const guildId = String(input?.guildId ?? ''); const discordChannelId = String(input?.channelId ?? '');
      if (!/^\d{5,25}$/.test(guildId) || !/^\d{5,25}$/.test(discordChannelId)) throw fail(400, 'DISCORD_IDS_INVALID');
      const hash = sha256(code);
      let posted = null; let tenantId = null;
      const result = await raw(async (client) => {
        const r = await client.query(
          `select distinct on (tenant_id, channel_id) tenant_id, channel_id, body from helmion.envoy_messages where author_subject=$1 and body like $2 order by tenant_id, channel_id, created_at desc, id desc`,
          [CONFIG_SUBJECT, `%${hash}%`],
        );
        const hit = r.rows.map((row) => ({ row, config: parseConfig(row.body) })).find((x) => x.config?.pendingLink?.codeHash === hash && Date.parse(x.config.pendingLink.expiresAt) > now());
        if (!hit) throw fail(404, 'ENVOY_LINK_CODE_UNKNOWN');
        // The newest config for that channel must still be the one holding this code.
        tenantId = String(hit.row.tenant_id);
        await setTenant(client, tenantId);
        const current = await readConfig(client, tenantId, String(hit.row.channel_id));
        if (current?.pendingLink?.codeHash !== hash) throw fail(404, 'ENVOY_LINK_CODE_UNKNOWN');
        // One Envoy channel per Discord channel.
        const taken = (await this.bridgeLinks()).links.find((l) => l.discordChannelId === discordChannelId && !(l.tenantId === tenantId && l.envoyChannelId === String(hit.row.channel_id)));
        if (taken) throw fail(409, 'DISCORD_CHANNEL_ALREADY_LINKED');
        const channel = await channelRow(client, tenantId, String(hit.row.channel_id));
        current.pendingLink = null;
        current.discord = { guildId, channelId: discordChannelId, channelName: String(input?.channelName ?? '').slice(0, 100), guildName: String(input?.guildName ?? '').slice(0, 100), linkedAt: new Date(now()).toISOString() };
        await writeConfig(client, tenantId, String(channel.id), current);
        posted = await notice(client, tenantId, String(channel.id), `#${channel.title} is now linked to Discord #${current.discord.channelName || discordChannelId}${current.discord.guildName ? ` in ${current.discord.guildName}` : ''}. Messages and agent replies mirror both ways.`);
        return { tenantId, envoyChannelId: String(channel.id), envoyChannelTitle: channel.title, agents: current.agents };
      });
      publish(tenantId, posted, publishImpl);
      return result;
    },

    async bridgeInbound(input) {
      const tenantId = String(input?.tenantId ?? ''); const envoyChannelId = String(input?.envoyChannelId ?? '');
      if (String(input?.provider ?? 'discord') === 'slack') {
        // A Slack message id is its ts: "1729900000.000100". It is the
        // idempotency anchor — Slack redelivers events, and the stored
        // key `slack:<ts>` makes a redelivery a replay, never a dupe.
        const messageId = String(input?.slackMessageId ?? '');
        if (!/^\d{5,20}\.\d{1,10}$/.test(messageId)) throw fail(400, 'SLACK_MESSAGE_ID_INVALID');
        const body = String(input?.body ?? '').trim();
        if (!body) return { skipped: 'empty' };
        const subject = slackSubject(input?.authorId, input?.authorName);
        let out = null;
        const result = await raw(async (client) => {
          await setTenant(client, tenantId);
          const config = await readConfig(client, tenantId, envoyChannelId);
          if (!config?.slack || config.slack.channelId !== String(input?.slackChannelId ?? '')) throw fail(403, 'SLACK_CHANNEL_NOT_LINKED');
          if (input?.teamId && config.slack.teamId !== String(input.teamId)) throw fail(403, 'SLACK_CHANNEL_NOT_LINKED');
          const metadata = { source: { provider: 'slack', teamId: config.slack.teamId, channelId: config.slack.channelId, channelName: config.slack.channelName } };
          const { row, replayed } = await insertMessage(client, { tenantId, channelId: envoyChannelId, subject, kind: 'human', body: body.slice(0, 4000), key: `slack:${messageId}`, metadata });
          if (!replayed) out = row;
          return { receipt: { durable: true, replayed, message: row ? messageOut(row) : null } };
        });
        publish(tenantId, out, publishImpl);
        return result;
      }
      const messageId = String(input?.discordMessageId ?? '');
      if (!/^\d{5,25}$/.test(messageId)) throw fail(400, 'DISCORD_MESSAGE_ID_INVALID');
      const body = String(input?.body ?? '').trim();
      if (!body) return { skipped: 'empty' };
      const subject = discordSubject(input?.authorId, input?.authorName);
      let out = null;
      const result = await raw(async (client) => {
        await setTenant(client, tenantId);
        const config = await readConfig(client, tenantId, envoyChannelId);
        if (!config?.discord || config.discord.channelId !== String(input?.discordChannelId ?? '')) throw fail(403, 'DISCORD_CHANNEL_NOT_LINKED');
        const { row, replayed } = await insertMessage(client, { tenantId, channelId: envoyChannelId, subject, kind: 'human', body: body.slice(0, 4000), key: `discord:${messageId}` });
        if (!replayed) out = row;
        return { receipt: { durable: true, replayed, message: row ? messageOut(row) : null } };
      });
      publish(tenantId, out, publishImpl);
      return result;
    },

    async bridgeOutbound(sinceValue) {
      const since = Number.isFinite(Date.parse(String(sinceValue ?? ''))) ? new Date(String(sinceValue)) : new Date(now() - 60_000);
      const { links, slackLinks } = await this.bridgeLinks();
      if (!links.length && !slackLinks.length) return { messages: [], links: 0, slackLinks: 0 };
      return raw(async (client) => {
        const out = [];
        for (const link of links) {
          await setTenant(client, link.tenantId);
          const r = await client.query(
            `select ${MSG_COLS} from helmion.envoy_messages where tenant_id=$1 and channel_id=$2 and created_at > $3 and author_subject <> $4 and author_subject not like 'discord:%' order by created_at asc, id asc limit 50`,
            [link.tenantId, link.envoyChannelId, since.toISOString(), CONFIG_SUBJECT],
          );
          for (const row of r.rows) {
            const m = messageOut(row);
            let displayName = m.authorName;
            if (!displayName && m.authorKind === 'human' && nameLookup) { try { displayName = await nameLookup(m.authorSubject); } catch {} }
            out.push({ ...m, tenantId: link.tenantId, discordChannelId: link.discordChannelId, guildId: link.guildId, displayName: displayName || 'Helmian member' });
          }
        }
        // Slack feed: same window, but a channel's Slack-born messages are
        // never echoed back to Slack (origin exclusion on 'slack:%').
        for (const link of slackLinks) {
          await setTenant(client, link.tenantId);
          const r = await client.query(
            `select ${MSG_COLS} from helmion.envoy_messages where tenant_id=$1 and channel_id=$2 and created_at > $3 and author_subject <> $4 and author_subject not like 'slack:%' order by created_at asc, id asc limit 50`,
            [link.tenantId, link.envoyChannelId, since.toISOString(), CONFIG_SUBJECT],
          );
          for (const row of r.rows) {
            const m = messageOut(row);
            let displayName = m.authorName;
            if (!displayName && m.authorKind === 'human' && nameLookup) { try { displayName = await nameLookup(m.authorSubject); } catch {} }
            out.push({ ...m, tenantId: link.tenantId, slackChannelId: link.slackChannelId, teamId: link.teamId, displayName: displayName || 'Helmian member' });
          }
        }
        out.sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
        return { messages: out.slice(0, 200), links: links.length, slackLinks: slackLinks.length };
      });
    },
  });
}

export function bridgeTokenOk(request, expected = process.env.HELMIAN_ENVOY_BRIDGE_TOKEN) {
  const want = String(expected ?? '').trim();
  if (want.length < 32) return null; // not configured
  const h = String(request?.headers?.authorization ?? '');
  const got = h.startsWith('Bearer ') ? h.slice(7).trim() : '';
  const a = Buffer.from(sha256(got)); const b = Buffer.from(sha256(want));
  return timingSafeEqual(a, b);
}

// Clerk display names for Helmian humans mirrored to Discord. Cached, best effort.
const nameCache = new Map();
export async function clerkDisplayName(subject, { secret = process.env.CLERK_SECRET_KEY, fetchImpl = fetch } = {}) {
  if (!/^user_[A-Za-z0-9]{10,64}$/.test(String(subject)) || !secret) return null;
  const hit = nameCache.get(subject);
  if (hit && hit.at > Date.now() - 10 * 60_000) return hit.name;
  const res = await fetchImpl(`https://api.clerk.com/v1/users/${subject}`, { headers: { authorization: `Bearer ${secret}` } });
  if (!res.ok) return null;
  const u = await res.json();
  const name = [u.first_name, u.last_name].filter(Boolean).join(' ').trim() || u.username || null;
  nameCache.set(subject, { name, at: Date.now() });
  return name;
}

export async function handleEnvoyMeshRoute({ request, response, requestUrl, activeTenantActor, send, TenantAuthorizationError, readJson, mesh = null } = {}) {
  const path = requestUrl?.pathname ?? '';
  const ours = path === CHANNEL_CONFIG_PATH || path === AGENT_WORK_PATH || path === AGENT_MESSAGES_PATH || path.startsWith(BRIDGE_PREFIX);
  if (!ours) return false;
  const reply = (status, body) => send(response, status, JSON.stringify(body));
  const failure = (error, fallback) => {
    const status = error?.status && error.status >= 400 && error.status < 600 ? error.status : (error instanceof TenantAuthorizationError ? 403 : 400);
    reply(status, { valid: false, code: error?.code ?? fallback });
  };
  let store;
  try { store = mesh ?? createEnvoyMesh({ pool: getPool(), nameLookup: (s) => clerkDisplayName(s) }); }
  catch (error) { reply(503, { valid: false, code: 'ENVOY_STORE_UNAVAILABLE' }); return true; }
  const body = async () => { try { return (await readJson(request)) ?? {}; } catch { throw fail(400, 'ENVOY_BODY_INVALID'); } };

  if (path.startsWith(BRIDGE_PREFIX)) {
    const ok = bridgeTokenOk(request);
    if (ok === null) { reply(503, { valid: false, code: 'ENVOY_BRIDGE_NOT_CONFIGURED' }); return true; }
    if (!ok) { reply(401, { valid: false, code: 'ENVOY_BRIDGE_UNAUTHORIZED' }); return true; }
    const sub = path.slice(BRIDGE_PREFIX.length);
    try {
      if (request.method === 'GET' && sub === 'links') reply(200, { valid: true, ...await store.bridgeLinks() });
      else if (request.method === 'GET' && sub === 'outbound') reply(200, { valid: true, ...await store.bridgeOutbound(requestUrl.searchParams.get('since')) });
      else if (request.method === 'POST' && sub === 'confirm-link') reply(200, { valid: true, ...await store.bridgeConfirmLink(await body()) });
      else if (request.method === 'POST' && sub === 'inbound') reply(200, { valid: true, ...await store.bridgeInbound(await body()) });
      else reply(404, { valid: false, code: 'ENVOY_BRIDGE_ROUTE_UNKNOWN' });
    } catch (error) { failure(error, 'ENVOY_BRIDGE_FAILED'); }
    return true;
  }

  try {
    const actor = await activeTenantActor(request);
    if (path === CHANNEL_CONFIG_PATH && request.method === 'GET') reply(200, { valid: true, ...await store.getConfig(actor, requestUrl.searchParams.get('channel_id')), discordBot: discordBotStatus(), slackBot: slackBotStatus() });
    else if (path === CHANNEL_CONFIG_PATH && request.method === 'POST') reply(200, { valid: true, ...await store.changeConfig(actor, await body()) });
    else if (path === AGENT_WORK_PATH && request.method === 'GET') reply(200, { valid: true, ...await store.agentWork(actor, requestUrl.searchParams.get('providers')) });
    else if (path === AGENT_MESSAGES_PATH && request.method === 'POST') reply(200, { valid: true, ...await store.postAsAgent(actor, await body()) });
    else reply(405, { valid: false, code: 'METHOD_NOT_ALLOWED' });
  } catch (error) { failure(error, 'ENVOY_MESH_FAILED'); }
  return true;
}
