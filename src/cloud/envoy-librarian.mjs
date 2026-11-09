// Envoy librarian: the coordinating memory layer at the dispatch
// choke point (maestro-librarian-check REPORT.md, Check 2).
//
// The database already held everything a librarian keeps — the
// shared notebook (helmion.context_entries), the audit trail
// (helmion.audit_events), the Guard findings (helmion.guard_findings),
// and the evidence on every message row — but all of it was passive:
// the notebook was read into every seat's prompt at dispatch while
// nothing in a channel ever wrote back, chats kept whatever generic
// name they were created with forever, and the three evidence piles
// were never joined per chat. This module is the missing middle. It
// rides roads that already run — the dispatch commit in
// envoy-mesh.mjs agentWork, beside the Guard findings ingest — and
// does three small duties:
//
//   1. File the ask. After a dispatch commits, one bounded entry per
//      dispatched human ask lands in the shared notebook, keyed
//      chat:<channelId>:<messageId> in the tenant's own slug, so the
//      next poll's notebook read carries the channel's own recent
//      life back to the seats. The write is the notebook store's own
//      shape (helmion.context_entries, unique on (project_slug, key))
//      — the same table the MCP door reads and writes, not a second
//      store. Re-filing an ask upserts the same key: one entry per
//      ask, however many polls hand it out before it is answered.
//   2. Name the chat. A channel still carrying a generic fallback
//      title ("New chat" — the create dialog's own fallback,
//      envoy-workspace.js) is named from its first human message's
//      opening words at the first dispatch that touches it. The
//      update is a compare-and-swap on the generic title the
//      dispatcher observed, so a name a human set — before, during,
//      or after — is never overwritten, and the rename fires once:
//      after it lands the title is no longer generic.
//   3. Roll up the evidence. One read joining, for a single channel,
//      the audit rows whose canonical target names the channel, the
//      channel's Guard findings, and its message counts — consumed
//      by the evidence surface (evidence.mjs getChannelEvidence),
//      owner/admin-gated like its neighbours.
//
// Fail-soft, in the Guard findings idiom: the store methods may
// throw; the wrappers the mesh calls (fileDispatchAsk,
// nameChannelIfGeneric) cannot. A librarian failure is logged loudly
// and changes nothing about the work handed out, exactly as a
// findings failure changes nothing about a dispatch. The librarian
// files and names; it never judges content and never gates a turn.

import { randomUUID } from 'node:crypto';
import { withTenantTransaction, requireActiveTenantMembership } from '../core/tenant-context.mjs';
import { CONFIG_SUBJECT, describeAuthor } from './envoy-agents.mjs';

export const LIBRARIAN_EXCERPT_MAX_CHARS = 200;
export const LIBRARIAN_ENTRY_MAX_CHARS = 1500;
export const LIBRARIAN_MAX_SEATS = 12;
export const LIBRARIAN_NAME_MAX_CHARS = 48;
export const LIBRARIAN_NAME_MAX_WORDS = 6;

// The generic fallback titles a channel can be created with and
// never properly named: 'New chat' is the create dialog's own
// fallback when the name field is left blank (envoy-workspace.js);
// the rest are the same class of placeholder. Anything outside this
// set is a name a human chose, and the librarian never touches it.
const GENERIC_CHANNEL_TITLES = new Set(['new chat', 'new channel', 'untitled', 'untitled chat', 'untitled channel']);

export function isGenericChannelTitle(title) {
  const normalized = String(title ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
  return GENERIC_CHANNEL_TITLES.has(normalized);
}

// One bounded line of text: control-free, whitespace-collapsed,
// capped. Shared by the excerpt and the derived chat name.
function boundedLine(text, max) {
  return String(text ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

/**
 * Derive a chat name from a human message's opening words: leading
 * @mentions are routing, not content, so they are dropped first;
 * what remains is capped at LIBRARIAN_NAME_MAX_WORDS words and
 * LIBRARIAN_NAME_MAX_CHARS characters, with the first letter raised
 * the way a title sits in the channel list. Returns null when the
 * message carries no words to name from (a bare mention, an empty
 * body) — a channel the librarian cannot name stays generic until a
 * message with words is dispatched in it.
 */
export function deriveChannelName(body) {
  const words = boundedLine(body, 400).split(' ').filter((w) => w && !/^@\S+$/.test(w));
  if (!words.length) return null;
  let name = words.slice(0, LIBRARIAN_NAME_MAX_WORDS).join(' ');
  if (name.length > LIBRARIAN_NAME_MAX_CHARS) {
    name = name.slice(0, LIBRARIAN_NAME_MAX_CHARS).replace(/\s+\S*$/, '').trim();
  }
  if (!name) return null;
  return name.charAt(0).toUpperCase() + name.slice(1);
}

/**
 * Shape one dispatched human ask into its notebook entry. Pure.
 * Returns { key, value } or null for a job missing the ids the key
 * is built from. The value is ordered so the notebook's own line cap
 * starves the excerpt first and the evidence — channel, human,
 * seats, Guard decision — survives; the whole entry is capped at
 * LIBRARIAN_ENTRY_MAX_CHARS by shrinking the excerpt to fit.
 */
export function librarianEntryFor(job) {
  const channelId = String(job?.channelId ?? '');
  const messageId = String(job?.messageId ?? '');
  if (!channelId || !messageId) return null;
  const build = (excerpt) => ({
    channel: boundedLine(job?.channelTitle ?? '', 120) || null,
    ...(job?.channelSlug ? { slug: String(job.channelSlug) } : {}),
    human: boundedLine(job?.humanName ?? '', 120) || String(job?.humanSubject ?? '') || null,
    ...(job?.humanSubject ? { subject: String(job.humanSubject) } : {}),
    seats: [...new Set((job?.seats ?? []).map((s) => String(s)).filter(Boolean))].slice(0, LIBRARIAN_MAX_SEATS),
    guard: job?.guardDecision ? String(job.guardDecision) : null,
    ask: excerpt,
    at: String(job?.at ?? ''),
  });
  let excerpt = boundedLine(job?.excerpt ?? '', LIBRARIAN_EXCERPT_MAX_CHARS);
  let value = build(excerpt);
  let json = JSON.stringify(value);
  while (json.length > LIBRARIAN_ENTRY_MAX_CHARS && excerpt.length) {
    excerpt = excerpt.slice(0, Math.max(0, excerpt.length - (json.length - LIBRARIAN_ENTRY_MAX_CHARS) - 1)).trim();
    value = build(excerpt);
    json = JSON.stringify(value);
  }
  return Object.freeze({ key: `chat:${channelId}:${messageId}`, value });
}

function contextFor(actor) {
  return { tenantId: actor.tenantId, actorSubject: actor.subject, actorRole: actor.role, sessionId: randomUUID(), requestId: randomUUID() };
}

export function createLibrarianStore(pool) {
  if (!pool?.connect) throw new Error('librarian store needs a Postgres pool');
  return Object.freeze({
    /**
     * File one dispatched ask into the shared notebook, under the
     * tenant's own slug (the notebook's scoping: the tenant id IS
     * the project slug, envoy-notebook.mjs). The projects row is
     * ensured first — context_entries.project_slug references it —
     * with the adapter's own insert shape (on conflict do nothing:
     * an existing project's name is never the librarian's business).
     * The entry insert upserts on (project_slug, key), so filing the
     * same ask twice leaves exactly one entry. Throws on failure;
     * the fail-soft wrapper below is the mesh's road in.
     */
    async fileAsk(actor, job) {
      const entry = librarianEntryFor(job);
      if (!entry) return { filed: false, reason: 'unkeyed' };
      const slug = String(actor.tenantId);
      const context = contextFor(actor);
      return withTenantTransaction(pool, context, async (client) => {
        await requireActiveTenantMembership(client, context);
        await client.query(
          `insert into helmion.projects(slug, name, root_path) values ($1,$2,null) on conflict (slug) do nothing`,
          [slug, slug],
        );
        const result = await client.query(
          `insert into helmion.context_entries(project_slug, key, value) values ($1,$2,$3::jsonb)
           on conflict (project_slug, key) do update set value = excluded.value, updated_at = clock_timestamp()`,
          [slug, entry.key, JSON.stringify(entry.value)],
        );
        return { filed: result.rowCount === 1, key: entry.key };
      });
    },

    /**
     * Rename a channel whose title is still the generic fallback the
     * dispatcher observed. Compare-and-swap: the update lands only
     * where the stored title still equals observedTitle, so a name
     * set by a human at any point — including after the dispatch
     * that collected this job — is never overwritten, and a second
     * filing of the same job (the title now real) renames nothing.
     * Returns true when this call set the name. Throws on failure;
     * the wrapper below is the fail-soft road in.
     */
    async renameChannelIfGeneric(actor, { channelId, observedTitle, name } = {}) {
      const title = boundedLine(name ?? '', LIBRARIAN_NAME_MAX_CHARS);
      if (!channelId || !title || !isGenericChannelTitle(observedTitle)) return false;
      const context = contextFor(actor);
      const out = await withTenantTransaction(pool, context, async (client) => {
        await requireActiveTenantMembership(client, context);
        const result = await client.query(
          `update helmion.envoy_channels set title = $3 where tenant_id = $1 and id = $2 and title = $4`,
          [String(actor.tenantId), String(channelId), title, String(observedTitle)],
        );
        return { renamed: result.rowCount === 1 };
      });
      return out.renamed === true;
    },

    /**
     * File one incident into the knowledge base (sql/076). The
     * category is the caller's when given; otherwise the filing
     * engine (classifyIncident — the Scribe librarian's rule engine,
     * ported below) chooses it from the preset rules plus this
     * tenant's stored custom/learned rules, and the hits ride the
     * result so the filing is explainable (Scribe's explain_filing).
     * An incident carrying a solution files as 'solved', without one
     * as 'open'. Idempotent on (tenant_id, key) when a key is given:
     * re-filing the same key leaves exactly one row. Throws on
     * failure; fileIncidentFromDispatch is the fail-soft road in.
     */
    async fileIncident(actor, incident) {
      const context = contextFor(actor);
      return withTenantTransaction(pool, context, async (client) => {
        await requireActiveTenantMembership(client, context);
        return insertIncident(client, actor, incident, context);
      });
    },

    /**
     * Land the verdict on an open incident: the solution that
     * worked. Only an OPEN incident can be solved — a superseded
     * one keeps pointing at its replacement, untouched. Returns
     * true when this call solved it.
     */
    async solveIncident(actor, { id, solution } = {}) {
      const fix = boundedLine(solution ?? '', KB_TEXT_MAX_CHARS);
      if (!id || !fix) return false;
      const context = contextFor(actor);
      const out = await withTenantTransaction(pool, context, async (client) => {
        await requireActiveTenantMembership(client, context);
        const result = await client.query(
          `update helmion.librarian_incidents set solution = $3, status = 'solved', updated_at = clock_timestamp()
           where tenant_id = $1 and id = $2 and status = 'open'`,
          [String(actor.tenantId), String(id), fix],
        );
        return { solved: result.rowCount === 1 };
      });
      return out.solved === true;
    },

    /**
     * Supersede an incident with its replacement (the flywheel's
     * struck-rule discipline): the new incident files with
     * supersedes_id pointing back, the old one flips to
     * 'superseded' with superseded_by_id pointing forward — neither
     * is edited into the other, and the chain stays readable both
     * ways. One transaction: if the old incident is not there to
     * supersede, nothing files.
     */
    async supersedeIncident(actor, { oldId, incident } = {}) {
      if (!oldId) throw new Error('supersedeIncident needs the incident being replaced');
      const context = contextFor(actor);
      return withTenantTransaction(pool, context, async (client) => {
        await requireActiveTenantMembership(client, context);
        const filed = await insertIncident(client, actor, { ...incident, supersedesId: oldId }, context);
        if (!filed.filed) throw new Error('replacement incident did not file (duplicate key?)');
        const result = await client.query(
          `update helmion.librarian_incidents set status = 'superseded', superseded_by_id = $3, updated_at = clock_timestamp()
           where tenant_id = $1 and id = $2 and status <> 'superseded'`,
          [String(actor.tenantId), String(oldId), filed.id],
        );
        if (result.rowCount !== 1) throw new Error(`incident ${String(oldId)} is not there to supersede`);
        return filed;
      });
    },

    /**
     * A human re-files an incident into another category — the
     * Scribe librarian's learning moment (learnFromMove), ported:
     * the category updates, and the librarian derives ONE learned
     * rule that would have filed it there (a distinctive trigger
     * word, collision-checked against the tenant's recent
     * incidents), stored in librarian_rules at the learned layer,
     * where it outranks every preset. Returns the learned rule's id
     * when one was derived.
     */
    async refileIncident(actor, { id, toCategory } = {}) {
      const category = String(toCategory ?? '').trim().toLowerCase();
      if (!id || !INCIDENT_CATEGORIES.includes(category)) return { refiled: false, learnedRule: null };
      const context = contextFor(actor);
      return withTenantTransaction(pool, context, async (client) => {
        await requireActiveTenantMembership(client, context);
        const found = await client.query(
          `select id, title, mistake, source from helmion.librarian_incidents where tenant_id = $1 and id = $2`,
          [String(actor.tenantId), String(id)],
        );
        const row = found.rows[0];
        if (!row) return { refiled: false, learnedRule: null };
        await client.query(
          `update helmion.librarian_incidents set category = $3, updated_at = clock_timestamp() where tenant_id = $1 and id = $2`,
          [String(actor.tenantId), String(id), category],
        );
        const stored = await loadStoredRules(client, String(actor.tenantId));
        // The reference sample excludes the refiled incident itself —
        // Scribe's learnFromMove filters it by id, or the incident's
        // own trigger word would always "collide" with itself.
        const reference = await client.query(
          `select title, mistake, source from helmion.librarian_incidents where tenant_id = $1 and id <> $2 order by created_at desc limit 50`,
          [String(actor.tenantId), String(id)],
        );
        const rule = learnKbRule(
          { title: row.title, mistake: row.mistake, source: row.source },
          category,
          [...KB_PRESET_RULES, ...stored],
          reference.rows,
        );
        if (rule) {
          await client.query(
            `insert into helmion.librarian_rules(tenant_id, id, layer, rule) values ($1,$2,$3,$4::jsonb) on conflict (tenant_id, id) do nothing`,
            [String(actor.tenantId), rule.id, rule.layer, JSON.stringify(rule)],
          );
        }
        return { refiled: true, learnedRule: rule?.id ?? null };
      });
    },

    /**
     * The lookup any seat can ask for (Troy: "immediate recall for
     * any AI"): the tenant's incidents, newest first, filtered by
     * category and/or a word search over title, mistake and
     * solution. Tenant membership is the whole gate — the knowledge
     * base is the tenant's own memory. Bounded like every librarian
     * read.
     */
    async lookupIncidents(actor, { category = null, query = null, limit = 20 } = {}) {
      const n = Math.min(Math.max(Math.trunc(Number(limit)) || 20, 1), 100);
      const context = contextFor(actor);
      const out = await withTenantTransaction(pool, context, async (client) => {
        await requireActiveTenantMembership(client, context);
        const params = [String(actor.tenantId)];
        let where = 'tenant_id = $1';
        if (category) { params.push(String(category)); where += ` and category = $${params.length}`; }
        if (query) {
          params.push(`%${String(query).replace(/[%_]/g, '')}%`);
          where += ` and (title ilike $${params.length} or mistake ilike $${params.length} or solution ilike $${params.length})`;
        }
        params.push(n);
        const result = await client.query(
          `select id, key, category, title, mistake, solution, actor, source, evidence, status, supersedes_id, superseded_by_id, created_at
           from helmion.librarian_incidents where ${where} order by created_at desc, id desc limit $${params.length}`,
          params,
        );
        return { incidents: result.rows.map(incidentOut) };
      });
      return out.incidents;
    },
  });
}

/**
 * File one dispatched ask through the librarian store, as the
 * acting tenant identity. Returns true when the entry landed.
 * NEVER throws: the dispatch outcome was decided before this runs,
 * and a filing failure is a gap in the shared memory, announced in
 * the log — never a failed dispatch. Mirrors ingestEvaluationFinding.
 */
export async function fileDispatchAsk(store, actor, job, { log = (...args) => console.error(...args) } = {}) {
  const entry = librarianEntryFor(job);
  if (!entry) return false;
  try {
    const result = await store.fileAsk(actor, job);
    return result?.filed === true;
  } catch (error) {
    log(
      `[envoy-librarian] notebook filing FAILED (key ${entry.key}, channel ${String(job?.channelId)}, `
      + `message ${String(job?.messageId)}): ${error?.message ?? error} `
      + '— the dispatch stands unchanged; the shared notebook has a gap for this ask.',
    );
    return false;
  }
}

/**
 * Name one still-generic channel through the librarian store.
 * Returns true when the name landed. NEVER throws — same contract
 * as fileDispatchAsk: a naming failure leaves the generic title and
 * a loud log line, and changes nothing about the dispatch.
 */
export async function nameChannelIfGeneric(store, actor, naming, { log = (...args) => console.error(...args) } = {}) {
  const name = deriveChannelName(naming?.fromBody ?? '');
  if (!name || !isGenericChannelTitle(naming?.observedTitle)) return false;
  try {
    return await store.renameChannelIfGeneric(actor, { channelId: naming.channelId, observedTitle: naming.observedTitle, name }) === true;
  } catch (error) {
    log(
      `[envoy-librarian] channel naming FAILED (channel ${String(naming?.channelId)}): ${error?.message ?? error} `
      + '— the dispatch stands unchanged; the channel keeps its generic name for now.',
    );
    return false;
  }
}

const ROLLUP_DEFAULT_LIMIT = 20;
const ROLLUP_MAX_LIMIT = 100;

function rollupLimit(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return ROLLUP_DEFAULT_LIMIT;
  return Math.min(Math.max(Math.trunc(n), 1), ROLLUP_MAX_LIMIT);
}

function isoOrNull(value) {
  if (value == null) return null;
  const d = new Date(value);
  return Number.isNaN(d.valueOf()) ? null : d.toISOString();
}

/**
 * The per-chat evidence roll-up (REPORT.md Check 2, duty 3): for one
 * channel in the actor's tenant — the channel row with its creator
 * resolved through describeAuthor, the newest audit rows whose
 * canonical target names the channel, the channel's Guard findings
 * with counts by severity, and the channel's message counts by
 * author kind (config rows excluded, as every chat read excludes
 * them). Read-only. Owner/admin only, like every evidence read.
 *
 * Each source is read in its own tenant transaction, the evidence
 * surface's own discipline (listRunLedger): a missing table (42P01)
 * contributes nothing and flags migrationPending instead of failing
 * the read — in a shared transaction the failed query would poison
 * every source after it. A channel the tenant does not have reads
 * as channel: null with empty piles, never another tenant's data:
 * every query is tenant_id-scoped.
 */
export async function readChannelEvidence(pool, actor, channelId, { limit = ROLLUP_DEFAULT_LIMIT } = {}) {
  if (!['owner', 'admin'].includes(String(actor?.role ?? '').toLowerCase())) {
    throw Object.assign(new Error('Owner or admin membership required'), { status: 403 });
  }
  const n = rollupLimit(limit);
  const id = String(channelId ?? '');
  const context = contextFor(actor);
  const readSource = async (sql, params) => {
    try {
      return await withTenantTransaction(pool, context, async (client) => {
        await requireActiveTenantMembership(client, context);
        const result = await client.query(sql, params);
        return { rows: result.rows, migrationPending: false };
      });
    } catch (error) {
      if (error?.code === '42P01') return { rows: [], migrationPending: true };
      throw error;
    }
  };

  const channelRead = await readSource(
    `select id, slug, title, kind, created_by_subject, created_at from helmion.envoy_channels where tenant_id = $1 and id = $2`,
    [String(actor.tenantId), id],
  );
  const channelRow = channelRead.rows[0] ?? null;
  if (!channelRow) {
    return Object.freeze({
      channel: null,
      audit: [],
      guardFindings: [],
      guardCounts: Object.freeze({ info: 0, warning: 0, critical: 0 }),
      messages: Object.freeze({ total: 0, byKind: Object.freeze({}) }),
      migrationPending: channelRead.migrationPending,
    });
  }
  const creator = describeAuthor(channelRow.created_by_subject, 'human');
  const [auditRead, findingsRead, messagesRead] = await Promise.all([
    readSource(
      `select id, actor_subject, actor_role, action_type, decision, privacy_summary, created_at
       from helmion.audit_events
       where tenant_id = $1 and canonical_target->>'channelId' = $2
       order by created_at desc, id desc limit $3`,
      [String(actor.tenantId), id, n],
    ),
    readSource(
      `select id, fingerprint, severity, title, first_seen_at, last_seen_at, sighting_count
       from helmion.guard_findings
       where tenant_id = $1 and detail->>'channelId' = $2
       order by last_seen_at desc, id desc limit $3`,
      [String(actor.tenantId), id, n],
    ),
    readSource(
      `select author_kind, count(*)::int as n from helmion.envoy_messages
       where tenant_id = $1 and channel_id = $2 and author_subject <> $3
       group by author_kind`,
      [String(actor.tenantId), id, CONFIG_SUBJECT],
    ),
  ]);
  const guardCounts = { info: 0, warning: 0, critical: 0 };
  for (const row of findingsRead.rows) {
    if (Object.hasOwn(guardCounts, String(row.severity))) guardCounts[String(row.severity)] += 1;
  }
  const byKind = {};
  let total = 0;
  for (const row of messagesRead.rows) {
    byKind[String(row.author_kind)] = Number(row.n);
    total += Number(row.n);
  }
  return Object.freeze({
    channel: Object.freeze({
      id: String(channelRow.id),
      slug: String(channelRow.slug),
      title: String(channelRow.title),
      kind: String(channelRow.kind),
      createdBySubject: String(channelRow.created_by_subject),
      ...(creator.name ? { createdByName: creator.name } : {}),
      createdAt: isoOrNull(channelRow.created_at),
    }),
    audit: auditRead.rows.map((row) => Object.freeze({
      id: String(row.id),
      actor: String(row.actor_subject),
      actorRole: String(row.actor_role),
      actionType: String(row.action_type),
      decision: String(row.decision),
      summary: String(row.privacy_summary),
      createdAt: isoOrNull(row.created_at),
    })),
    guardFindings: findingsRead.rows.map((row) => Object.freeze({
      id: String(row.id),
      fingerprint: String(row.fingerprint),
      severity: String(row.severity),
      title: String(row.title),
      sightingCount: Number(row.sighting_count),
      firstSeenAt: isoOrNull(row.first_seen_at),
      lastSeenAt: isoOrNull(row.last_seen_at),
    })),
    guardCounts: Object.freeze(guardCounts),
    messages: Object.freeze({ total, byKind: Object.freeze(byKind) }),
    migrationPending: channelRead.migrationPending || auditRead.migrationPending || findingsRead.migrationPending || messagesRead.migrationPending,
  });
}

// ---------------------------------------------------------------------------
// The knowledge base (Troy's spec, 2026-11-09): every mistake an AI
// in this workspace has made, and the solution that worked,
// categorized, in rows (sql/076) — with the self-learning flywheel's
// logic inside the filing itself.
//
// CLONED FROM SCRIBE, NOT INVENTED. A working librarian already
// existed: the memory service's librarian on the Hetzner box
// (/opt/claude-memory-mcp/app/src/librarian/, TypeScript, deployed
// by deploy-librarian.sh, verified by verify-librarian.mjs; source
// copied to ~/workspace/helmian-room-build/librarian/
// scribe-librarian-source/ for the record). It files memory items
// into categories with a layered, explainable rule engine and
// learns from human re-files. What follows is that engine ADAPTED
// to Helmian's store and subject: the Rule shape, the layer ranks,
// the priority bands, the whole-word matcher and the learning
// derivation are the Scribe code's, ported from TypeScript; the
// categories and preset rules are Helmian's (seeded from the
// flywheel's RULES.md themes); the storage is helmion tables, not
// the memory service's. What the Scribe librarian never had —
// dispatch write-back, chat naming, the evidence roll-up above, and
// an incidents table — is the Helmian-built half of this module.
// ---------------------------------------------------------------------------

export const KB_TITLE_MAX_CHARS = 160;
export const KB_TEXT_MAX_CHARS = 600;
export const KB_RECALL_DEFAULT_LIMIT = 8;
export const KB_RECALL_MAX_LIMIT = 20;
export const KB_BLOCK_MAX_CHARS = 2400;
export const KB_BLOCK_LINE_MAX_CHARS = 300;

// The mistake categories. 'unsorted' is where an incident lands
// when no rule files it — Scribe's UNSORTED, kept loud on purpose:
// an unsorted incident is a filing rule waiting to be learned.
export const INCIDENT_CATEGORIES = Object.freeze([
  'verification', 'deploy', 'credentials', 'connectors', 'data',
  'voice', 'ui', 'memory', 'tooling', 'process', 'unsorted',
]);

// --- match.ts, ported: whole-word / whole-phrase matching,
// case-insensitive, a trailing plural "s"/"es" allowed. ---
const kbWordRegexCache = new Map();
function kbWordRegex(word) {
  const key = String(word).toLowerCase();
  let r = kbWordRegexCache.get(key);
  if (!r) {
    const body = key.trim().split(/\s+/).map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('[\\s_-]+');
    r = new RegExp(`(?<![\\p{L}\\p{N}])${body}(?:e?s)?(?![\\p{L}\\p{N}])`, 'iu');
    kbWordRegexCache.set(key, r);
  }
  return r;
}
export function kbFindWords(text, words = []) {
  const t = String(text ?? '');
  return (words ?? []).filter((w) => kbWordRegex(w).test(t));
}

// --- shape.ts, adapted: Scribe classifies the item's form (code /
// pr / commit / error / chat); an incident's form is narrower —
// 'error' when it carries real error markers, 'note' otherwise.
// The ERROR marker list is Scribe's. ---
const KB_ERROR_MARKERS = [
  /\bTraceback \(most recent call last\)/,
  /^\s*at [\w$.<>]+ \(.+:\d+:\d+\)/m,
  /\b(?:[A-Z]\w*Error|Exception)\b:\s/,
  /\bERR_[A-Z_]+\b/,
  /\b(?:HTTP\s*)?(?:500|502|503|504)\b.*\b(error|failed)\b/i,
  /\bstack trace\b/i,
];
export function detectIncidentShape(text) {
  const t = String(text ?? '');
  return KB_ERROR_MARKERS.some((r) => r.test(t)) ? 'error' : 'note';
}

// --- engine.ts, ported: every condition a rule states must hold;
// the matched strings are the explanation (explain_filing). Layer
// ranks break priority ties, the more specific layer winning:
// learned 5, custom 4, content 3, shape 2, source 1. Adapted:
// incidents carry no [tags:] line and no conversation name, so the
// tags / conversationWords conditions are not part of this port. ---
const KB_LAYER_RANK = { learned: 5, custom: 4, content: 3, shape: 2, source: 1 };

export function evaluateKbRule(rule, ctx) {
  if (!rule || rule.enabled === false) return null;
  const w = rule.when ?? {};
  const matched = [];
  let conditions = 0;
  const normalise = (s) => String(s ?? '').trim().toLowerCase();
  if (w.source?.length) {
    conditions++;
    const hit = ctx.source ? w.source.find((x) => normalise(x) === ctx.source) : undefined;
    if (!hit) return null;
    matched.push(`source "${hit}"`);
  }
  if (w.shape?.length) {
    conditions++;
    if (!w.shape.includes(ctx.shape)) return null;
    matched.push(`shape ${ctx.shape}`);
  }
  if (w.anyWords?.length) {
    conditions++;
    const hits = kbFindWords(ctx.text, w.anyWords);
    if (!hits.length) return null;
    matched.push(...hits.map((h) => `word "${h}"`));
  }
  if (w.allWords?.length) {
    conditions++;
    const hits = kbFindWords(ctx.text, w.allWords);
    if (hits.length !== w.allWords.length) return null;
    matched.push(...hits.map((h) => `word "${h}"`));
  }
  if (w.noneWords?.length) {
    if (kbFindWords(ctx.text, w.noneWords).length) return null;
  }
  if (w.withAny?.length) {
    conditions++;
    const hits = kbFindWords(ctx.text, w.withAny);
    if (!hits.length) return null;
    matched.push(...hits.map((h) => `context word "${h}"`));
  }
  return conditions ? matched : null;
}

/**
 * File one incident: returns { category, hits, tags } — the winning
 * rule's category (or 'unsorted' when nothing files it), EVERY
 * matching rule's hit (the explanation), and the tags accumulated
 * across all matching rules (Scribe semantics: tags accumulate;
 * the category is the single best rule's, by priority, then layer
 * rank, then rule id). Pure; extraRules are the tenant's stored
 * custom/learned rules riding over the presets.
 */
export function classifyIncident(incident, extraRules = []) {
  const text = `${String(incident?.title ?? '')}\n${String(incident?.mistake ?? '')}`;
  const ctx = {
    text,
    source: incident?.source ? String(incident.source).trim().toLowerCase() : null,
    shape: detectIncidentShape(text),
  };
  const rules = [...(extraRules ?? []), ...KB_PRESET_RULES];
  const hits = [];
  const tags = new Set();
  let best = null;
  for (const rule of rules) {
    const matched = evaluateKbRule(rule, ctx);
    if (!matched) continue;
    hits.push(Object.freeze({ ruleId: rule.id, layer: rule.layer, ...(rule.category ? { category: rule.category } : {}), priority: rule.priority ?? 0, matched }));
    for (const t of rule.addTags ?? []) tags.add(t);
    if (!rule.category) continue;
    const candidate = { category: rule.category, priority: rule.priority ?? 0, rank: KB_LAYER_RANK[rule.layer] ?? 0, id: rule.id };
    if (!best
      || candidate.priority > best.priority
      || (candidate.priority === best.priority && candidate.rank > best.rank)
      || (candidate.priority === best.priority && candidate.rank === best.rank && candidate.id < best.id)) {
      best = candidate;
    }
  }
  return Object.freeze({ category: best?.category ?? 'unsorted', hits: Object.freeze(hits), tags: Object.freeze([...tags]) });
}

// --- presets.ts, adapted: Helmian's preset rulebook. Priority
// bands follow Scribe's: learned/custom 800-900+, content topics
// 300-400, shape 200, source 100. Descriptions name the flywheel
// rule each preset carries, in the flywheel's own evidence style. ---
export const KB_PRESET_RULES = Object.freeze([
  { id: 'source.guard', layer: 'source', when: { source: ['guard'] }, addTags: ['guard-refusal'], priority: 100, description: 'Filed by the Executive Guard road (a refused ask).' },
  { id: 'shape.error', layer: 'shape', when: { shape: ['error'] }, addTags: ['error'], priority: 200, description: 'Carries real error markers (a stack, an Error:, an ERR_ code).' },
  { id: 'content.verification', layer: 'content', when: { anyWords: ['screenshot', 'unverified', 'never tested', 'not tested', 'claimed it works'] }, category: 'verification', priority: 340, description: 'A done/working claim without the real path exercised (flywheel R1).' },
  { id: 'content.credentials', layer: 'content', when: { anyWords: ['password', 'credential', 'api key', 'passphrase', 'sign-in failed', 'login failed', 'token expired'] }, category: 'credentials', priority: 335, description: 'Sign-ins, keys, tokens and secrets.' },
  { id: 'content.deploy', layer: 'content', when: { anyWords: ['deploy', 'vercel', 'rollback', 'bundle hash', 'redeploy'] }, category: 'deploy', priority: 330, description: 'Deploys, rollbacks and build-time baking (flywheel R21).' },
  { id: 'content.connectors', layer: 'content', when: { anyWords: ['connector', 'base64', 'approval card', 'allow popup'] }, category: 'connectors', priority: 325, description: 'Connector roads: batched writes, payload limits, grants (flywheel R15/R19/R24).' },
  { id: 'content.data', layer: 'content', when: { anyWords: ['database', 'migration', 'wrong tenant', 'rls', 'rows deleted', 'sql'] }, category: 'data', priority: 320, description: 'Data, migrations and tenant separation.' },
  { id: 'content.voice', layer: 'content', when: { anyWords: ['voice memo', 'kokoro', 'microphone', 'tts'] }, category: 'voice', priority: 315, description: 'Voice: memos, speech, the microphone.' },
  { id: 'content.ui', layer: 'content', when: { anyWords: ['scrollbar', 'layout', 'overflows', 'button'] }, category: 'ui', priority: 310, description: 'What the screen shows: layout, controls, overflow.' },
  { id: 'content.memory', layer: 'content', when: { anyWords: ['notebook', 'forgot', 'context lost', 'memory'] }, category: 'memory', priority: 305, description: 'Shared memory and lost context.' },
  { id: 'content.tooling', layer: 'content', when: { anyWords: ['rate limit', '429', 'timed out', 'timeout', 'flaky'] }, category: 'tooling', priority: 300, description: 'Tool and transport behaviour: limits, timeouts, flakes.' },
]);

// --- learn.ts, ported: candidate trigger words (the Scribe
// stopword set, its ranking — capitalised words first, then
// frequency) and the one-rule derivation with its collision check.
const KB_STOP = new Set(('the a an and or but if then of to in on at for with from by is are was were be been it this that these those '
  + 'i you he she we they me my your our their not no yes so as do did does done have has had just can will would should could '
  + 'about into over also more most some any all what when where which who how than there here out up down get got make made '
  + 'like okay ok yeah hey please thanks thank need want going let lets now today tomorrow yesterday one two three').split(' '));

export function kbCandidateTriggers(text) {
  const t = String(text ?? '');
  const counts = new Map();
  for (const w of t.toLowerCase().match(/[\p{L}][\p{L}\p{N}_-]{3,}/gu) ?? []) {
    if (KB_STOP.has(w)) continue;
    counts.set(w, (counts.get(w) ?? 0) + 1);
  }
  const proper = new Set((t.match(/\b[A-Z][a-zA-Z0-9]{3,}\b/g) ?? []).map((w) => w.toLowerCase()).filter((w) => !KB_STOP.has(w)));
  return [...counts.entries()]
    .sort((a, b) => Number(proper.has(b[0])) - Number(proper.has(a[0])) || b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([w]) => w);
}

/**
 * The learning derivation (Scribe's learnFromMove): a human filed
 * `incident` into `toCategory`; derive ONE learned rule — the most
 * distinctive trigger word that does not already push other items
 * elsewhere and does not appear in reference incidents currently
 * filed into a different category. Returns the Rule, or null when
 * the incident already files there or no clean word exists.
 */
export function learnKbRule(incident, toCategory, existingRules = [], reference = []) {
  const all = existingRules ?? [];
  const current = classifyIncident(incident, all);
  if (current.category === toCategory) return null;
  const taken = new Set(all.flatMap((r) => r.when?.anyWords ?? []));
  const text = `${String(incident?.title ?? '')} ${String(incident?.mistake ?? '')}`;
  for (const word of kbCandidateTriggers(text).slice(0, 15)) {
    if (taken.has(word)) continue;
    const collisions = (reference ?? []).filter((r) => kbFindWords(`${r.title ?? ''} ${r.mistake ?? ''}`, [word]).length
      && classifyIncident(r, all).category !== toCategory).length;
    if (collisions > 0) continue;
    return Object.freeze({
      id: `learned.${toCategory}.${word}`.replace(/[^a-z0-9._/-]/gi, '_'),
      layer: 'learned',
      when: { anyWords: [word] },
      category: toCategory,
      priority: 900,
      description: `Learned: a human filed an incident mentioning "${word}" into "${toCategory}".`,
    });
  }
  return null;
}

// --- store helpers (the createLibrarianStore KB methods' innards).

async function loadStoredRules(client, tenantId) {
  const result = await client.query(
    `select rule from helmion.librarian_rules where tenant_id = $1 and status = 'active'`,
    [tenantId],
  );
  return result.rows.map((r) => (typeof r.rule === 'string' ? JSON.parse(r.rule) : r.rule)).filter((r) => r && typeof r === 'object');
}

function incidentOut(row) {
  return Object.freeze({
    id: String(row.id),
    key: row.key != null ? String(row.key) : null,
    category: String(row.category),
    title: String(row.title),
    mistake: String(row.mistake),
    solution: row.solution != null ? String(row.solution) : null,
    actor: row.actor != null ? String(row.actor) : null,
    source: row.source != null ? String(row.source) : null,
    evidence: row.evidence && typeof row.evidence === 'object' ? row.evidence : {},
    status: String(row.status),
    supersedesId: row.supersedes_id != null ? String(row.supersedes_id) : null,
    supersededById: row.superseded_by_id != null ? String(row.superseded_by_id) : null,
    createdAt: isoOrNull(row.created_at),
  });
}

async function insertIncident(client, actor, incident, context) {
  const title = boundedLine(incident?.title ?? '', KB_TITLE_MAX_CHARS);
  const mistake = boundedLine(incident?.mistake ?? '', KB_TEXT_MAX_CHARS);
  if (!title || !mistake) return { filed: false, reason: 'empty', category: 'unsorted', hits: [] };
  const stored = await loadStoredRules(client, String(actor.tenantId));
  const filing = classifyIncident({ title, mistake, source: incident?.source ?? null }, stored);
  const category = INCIDENT_CATEGORIES.includes(String(incident?.category ?? '').toLowerCase())
    ? String(incident.category).toLowerCase()
    : filing.category;
  const solution = incident?.solution ? boundedLine(incident.solution, KB_TEXT_MAX_CHARS) : null;
  const status = ['open', 'solved', 'superseded'].includes(String(incident?.status ?? '').toLowerCase())
    ? String(incident.status).toLowerCase()
    : (solution ? 'solved' : 'open');
  const id = randomUUID();
  const result = await client.query(
    `insert into helmion.librarian_incidents(id, tenant_id, key, category, title, mistake, solution, actor, source, evidence, status, supersedes_id, filed_by)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12,$13)
     on conflict (tenant_id, key) where key is not null do nothing`,
    [
      id,
      String(actor.tenantId),
      incident?.key ? String(incident.key) : null,
      category,
      title,
      mistake,
      solution,
      incident?.actor ? boundedLine(incident.actor, 120) : null,
      incident?.source ? boundedLine(incident.source, 60) : null,
      JSON.stringify(incident?.evidence && typeof incident.evidence === 'object' ? incident.evidence : {}),
      status,
      incident?.supersedesId ? String(incident.supersedesId) : null,
      String(context.actorSubject ?? ''),
    ],
  );
  if (result.rowCount !== 1) return { filed: false, reason: 'duplicate', category, hits: filing.hits };
  return { filed: true, id, category, hits: filing.hits };
}

/**
 * File one incident through the librarian store, fail-soft — the
 * mesh's road in for dispatch-born incidents (a Guard refusal).
 * NEVER throws: the dispatch stands whatever the knowledge base
 * does, and a filing failure is a loud log line.
 */
export async function fileIncidentFromDispatch(store, actor, incident, { log = (...args) => console.error(...args) } = {}) {
  try {
    const result = await store.fileIncident(actor, incident);
    return result?.filed === true;
  } catch (error) {
    log(
      `[envoy-librarian] incident filing FAILED (key ${String(incident?.key ?? '')}): ${error?.message ?? error} `
      + '— the dispatch stands unchanged; the knowledge base has a gap for this incident.',
    );
    return false;
  }
}

/**
 * The dispatch-carried recall (Troy: "immediate recall for any
 * AI"): a bounded block of the tenant's SOLVED incidents — mistake
 * and fix, newest first — rendered to ride a work item beside the
 * notebook block, in the notebook's discipline: at most
 * KB_RECALL_DEFAULT_LIMIT lines, each line capped, the whole block
 * capped, an open-incident count line when unsolved incidents
 * exist, and NOTHING (null) when the tenant has no solved
 * incidents — a tenant without a knowledge base gets the prompt it
 * has always gotten, byte for byte. NEVER throws: a failed read
 * (including sql/076 not yet applied — 42P01) logs loudly and
 * returns null.
 */
export async function readKnowledgeBaseBlock(pool, actor, { limit = KB_RECALL_DEFAULT_LIMIT, log = (...args) => console.error(...args) } = {}) {
  const n = Math.min(Math.max(Math.trunc(Number(limit)) || KB_RECALL_DEFAULT_LIMIT, 1), KB_RECALL_MAX_LIMIT);
  const context = contextFor(actor);
  try {
    const out = await withTenantTransaction(pool, context, async (client) => {
      await requireActiveTenantMembership(client, context);
      const solved = await client.query(
        `select category, title, solution from helmion.librarian_incidents
         where tenant_id = $1 and status = 'solved' order by created_at desc, id desc limit $2`,
        [String(actor.tenantId), n],
      );
      const open = await client.query(
        `select count(*)::int as n from helmion.librarian_incidents where tenant_id = $1 and status = 'open'`,
        [String(actor.tenantId)],
      );
      return { solved: solved.rows, openCount: Number(open.rows[0]?.n ?? 0) };
    });
    if (!out.solved.length) return null;
    const lines = ['Knowledge base (mistakes already made in this workspace, and the fixes that worked — do not repeat them):'];
    for (const row of out.solved) {
      lines.push(boundedLine(`- [${row.category}] ${row.title} — Fix: ${row.solution ?? ''}`, KB_BLOCK_LINE_MAX_CHARS));
    }
    if (out.openCount > 0) lines.push(`(${out.openCount} more incident${out.openCount === 1 ? ' is' : 's are'} filed without a fix yet.)`);
    let block = lines.join('\n');
    while (block.length > KB_BLOCK_MAX_CHARS && lines.length > 2) {
      lines.splice(lines.length - (out.openCount > 0 ? 2 : 1), 1);
      block = lines.join('\n');
    }
    return block.length > KB_BLOCK_MAX_CHARS ? block.slice(0, KB_BLOCK_MAX_CHARS) : block;
  } catch (error) {
    log(`[envoy-librarian] knowledge base recall FAILED for tenant ${String(actor?.tenantId)}: ${error?.message ?? error} — seats answer without the knowledge base block this poll; dispatch is unchanged.`);
    return null;
  }
}
