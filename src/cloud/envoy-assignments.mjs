// Maestro's coordinator (Maestro, Helm, Librarian fix programme,
// bite M2; DESIGN section 2.3 and decisions D1, D6, D7): when a
// human message addressed to Maestro parses into explicitly
// enumerated parts, this module posts ONE assignment message as
// agent:maestro naming exactly one owner per part, and marks the
// human message with the parsed assignment record
// (metadata.maestroAssignment) for the mesh to dispatch per part
// (bite M3).
//
// The coordinator is deterministic cloud code, never a model
// (decision D1): it decomposes nothing it cannot read off the
// page, names no owner it cannot resolve, and answers no part
// itself. Its failure mode is a parse miss, which is visible and
// safe: no assignment post, no mark, and the message falls
// through to ordinary dispatch exactly as before (DESIGN 2.3:
// "the coordinator never swallows an ask it cannot structure").
//
// Bite M4 adds the settle watcher at the bottom of this file:
// on each poll the mesh asks it to check the channel's open
// assignments, post the one close line when every owned part
// has its owner's reply in the channel record, and name a part
// whose owner posted nothing within the work window — once per
// part, never as silence (DESIGN 2.3, 2.5, 5.6).
//
// The parser accepts explicit enumeration only, in the shapes
// DESIGN 2.3 names: "Part one / Part two / Part three" lines (or
// the same markers inline in one paragraph), numbered lists,
// lettered lists, and "parts:" shapes (a lead-in whose items ride
// on the same line separated by semicolons, or one plain line per
// part after a lead-in line). Enumeration must run in exact
// sequence (1, 2, 3 or a, b, c) inside one shape; a mixed or
// broken sequence is not a parse.
//
// Owner picking (DESIGN 2.3): an owner named in the message for a
// part is used when that seat can actually be handed work here:
// a member of the channel's roster (config order) that the claim
// gate allows, the same "connected and joined" test the mesh
// applies before handing out work (tenant-agent-state's
// claimGateFor; an ungated tenant gates nobody). A part naming a
// seat outside that set is left UNASSIGNED and the post says so
// (decision D7): a roster seat that is not connected reads
// "not connected in this workspace"; a seat that is not in the
// channel reads "not in this channel"; a name that is not a seat
// at all reads "not one of the seats here". Unnamed parts are
// filled from the assignable pool in roster order, one part each
// before any seat takes a second part; a named assignment counts
// toward its seat's share, so the round stays even. When no part
// at all can be assigned an owner, the coordinator posts nothing
// and marks nothing: the send falls through to the empty-desk
// answer or ordinary dispatch, and a fresh send still gets at
// most one Maestro message (the guide seam's rule).

import { AGENT_NAMES, CONFIG_SUBJECT, mentionsIn, normalizeProvider, parseConfig } from './envoy-agents.mjs';
import { claimGateFor, tenantAgentStateOn } from './tenant-agent-state.mjs';

export const MAESTRO_ASSIGNMENT_SUBJECT = 'agent:maestro';
export const MAESTRO_ASSIGNMENT_KEY_PREFIX = 'maestro-assignment:';

// The roles are never owners: Maestro coordinates and never works
// a part (DESIGN 2.1), and Helm and the Librarian are not seats.
const ROLE_OWNERS = new Set(['maestro', 'helm', 'librarian']);

// ---------- the part parser (pure) ----------

const PART_NUMBER_WORDS = Object.freeze({
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7,
  eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
});
const PART_NUMBER_SRC = 'one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|\\d{1,2}';
const PART_SEPARATOR_SRC = '(?:[:.)\\],]|\\s+-|\\s+\\u2014|\\s+\\u2013)';

const PART_LINE_RE = new RegExp(`^\\s*part\\s+(${PART_NUMBER_SRC})\\s*${PART_SEPARATOR_SRC}\\s*(.*)$`, 'i');
const NUMBERED_LINE_RE = /^\s*(\d{1,2})\s*[.)]\s+(.+)$/;
const LETTERED_LINE_RE = /^\s*([a-zA-Z])\s*[.)]\s+(.+)$/;
const PART_MARKER_GLOBAL_RE = new RegExp(`\\bpart\\s+(${PART_NUMBER_SRC})\\s*${PART_SEPARATOR_SRC}\\s*`, 'gi');
const PARTS_LEAD_RE = /\bparts?\s*:/i;

function partIndexOf(token) {
  const word = String(token ?? '').toLowerCase();
  return PART_NUMBER_WORDS[word] ?? Number(word);
}

function classifyLine(line) {
  let m = PART_LINE_RE.exec(line);
  if (m) return { shape: 'part', index: partIndexOf(m[1]), rest: m[2] };
  m = NUMBERED_LINE_RE.exec(line);
  if (m) return { shape: 'numbered', index: Number(m[1]), rest: m[2] };
  m = LETTERED_LINE_RE.exec(line);
  if (m) return { shape: 'lettered', index: m[1].toLowerCase().charCodeAt(0) - 96, rest: m[2] };
  return null;
}

function finishParts(rawParts) {
  const parts = rawParts.map((text, i) => ({ n: i + 1, text: String(text ?? '').replace(/\s+/g, ' ').trim() }));
  if (parts.length < 2) return null;
  if (parts.some((p) => !p.text)) return null;
  return parts;
}

// Line-shaped enumeration: every item opens with a marker line of
// one shape, indices run 1..N in order, and any other non-empty
// line continues the open item. A marker line of a second shape,
// or a sequence break, is not a parse at all.
function scanEnumeratedLines(lines) {
  const items = [];
  let shape = null;
  for (const line of lines) {
    const hit = classifyLine(line);
    if (hit) {
      if (shape === null) shape = hit.shape;
      if (hit.shape !== shape) return null;
      items.push({ index: hit.index, lines: [hit.rest] });
    } else if (items.length) {
      const trimmed = line.trim();
      if (trimmed) items[items.length - 1].lines.push(trimmed);
    }
  }
  if (items.length < 2) return null;
  for (let i = 0; i < items.length; i++) if (items[i].index !== i + 1) return null;
  return finishParts(items.map((item) => item.lines.join(' ')));
}

// The "Part one: ... Part two: ..." shape written as one
// paragraph: the same markers, inline. The text before the first
// marker is the job's intro and is not a part.
function scanInlineParts(text) {
  const marks = [...text.matchAll(PART_MARKER_GLOBAL_RE)];
  if (marks.length < 2) return null;
  const raw = [];
  for (let i = 0; i < marks.length; i++) {
    if (partIndexOf(marks[i][1]) !== i + 1) return null;
    const start = marks[i].index + marks[i][0].length;
    const end = i + 1 < marks.length ? marks[i + 1].index : text.length;
    raw.push(text.slice(start, end).replace(/;\s*$/, ''));
  }
  return finishParts(raw);
}

// The "parts:" shapes: a lead-in the human wrote to declare the
// enumeration. Items ride either on the lead-in's own line,
// separated by semicolons, or as one plain line per part after a
// lead-in line that ends at the colon. A following line carrying
// its own marker belongs to the marked scans above, never to
// this one: if they had a valid parse they already won.
function scanPartsLead(lines) {
  const leadIdx = lines.findIndex((line) => PARTS_LEAD_RE.test(line));
  if (leadIdx === -1) return null;
  const leadLine = lines[leadIdx];
  const match = PARTS_LEAD_RE.exec(leadLine);
  const after = leadLine.slice(match.index + match[0].length).trim();
  if (after) {
    return finishParts(after.split(/\s*;\s*/));
  }
  const rest = lines.slice(leadIdx + 1).map((line) => line.trim()).filter(Boolean);
  if (rest.some((line) => classifyLine(line))) return null;
  return finishParts(rest);
}

/**
 * Parse a message body into explicitly enumerated parts, or
 * null. Pure. The addressee is not this function's question (the
 * caller checks roleAddresseeIn); the whole body is scanned, so
 * the vocative and any intro lines ride along as context, never
 * as parts. Returns { parts: [{ n, text }] } with parts in order.
 */
export function parseMaestroParts(body) {
  const text = String(body ?? '');
  if (!text.trim()) return null;
  const lines = text.split(/\r?\n/);
  const parts = scanEnumeratedLines(lines) ?? scanInlineParts(text) ?? scanPartsLead(lines);
  return parts ? { parts } : null;
}

// ---------- named owners (pure) ----------

function customMaps(customAgents) {
  const byHandle = new Map();
  const byName = new Map();
  for (const agent of customAgents ?? []) {
    const handle = String(agent?.handle || agent?.id || '');
    if (!handle) continue;
    byHandle.set(handle.toLowerCase(), agent);
    const name = String(agent?.name ?? '').trim().toLowerCase();
    if (name) byName.set(name, agent);
  }
  return { byHandle, byName };
}

function resolveSeatToken(token, maps) {
  const raw = String(token ?? '').trim().replace(/^@/, '').toLowerCase();
  if (!raw) return null;
  const custom = maps.byHandle.get(raw) ?? maps.byName.get(raw);
  if (custom) return { owner: String(custom.handle || custom.id), name: String(custom.name ?? custom.handle ?? custom.id) };
  const provider = normalizeProvider(raw);
  if (provider && !ROLE_OWNERS.has(provider)) return { owner: provider, name: AGENT_NAMES[provider] ?? provider };
  return null;
}

/**
 * The owner one part's text names, or null. Three shapes, in
 * order: an @mention of a seat anywhere in the part; explicit
 * assignment words ("assigned to X", "owner: X", "goes to X"),
 * where a name that resolves to no seat is still a naming and
 * comes back as { owner: null, name, unresolved: true } so the
 * post can say so; and a leading name ("Claude: ...",
 * "Claude to ...", a custom agent's full name before a colon),
 * which counts only when it resolves to a real seat, so an
 * ordinary opening word before a colon is never mistaken for an
 * owner. A role named as owner (Maestro, Helm, the Librarian)
 * is not a naming: roles never work parts. Pure.
 */
export function namedOwnerForPart(text, customAgents = []) {
  const body = String(text ?? '');
  const maps = customMaps(customAgents);
  const handles = (customAgents ?? []).map((a) => a?.handle || a?.id).filter(Boolean);
  const { providers } = mentionsIn(body, handles);
  for (const provider of providers) {
    if (ROLE_OWNERS.has(provider)) continue;
    const resolved = resolveSeatToken(provider, maps);
    if (resolved) return resolved;
  }
  const explicit = /\b(?:assigned\s+to|owner\s*:|goes\s+to)\s+@?([A-Za-z][A-Za-z0-9_-]*)/i.exec(body);
  if (explicit) {
    const resolved = resolveSeatToken(explicit[1], maps);
    if (resolved) return resolved;
    if (!ROLE_OWNERS.has(String(explicit[1]).toLowerCase())) {
      return { owner: null, name: explicit[1], unresolved: true };
    }
  }
  const trimmed = body.trim();
  const lower = trimmed.toLowerCase();
  for (const agent of customAgents ?? []) {
    const name = String(agent?.name ?? '').trim();
    if (!name || !name.includes(' ')) continue;
    const lowered = name.toLowerCase();
    if (lower.startsWith(`${lowered}:`) || lower.startsWith(`${lowered} \u2014`) || lower.startsWith(`${lowered} -`)) {
      return { owner: String(agent.handle || agent.id), name };
    }
  }
  const lead = /^@?([A-Za-z][A-Za-z0-9_-]*)\s*(?::|\u2014|\u2013|-|\bto\b|\btakes\b|\bwill\b)/.exec(trimmed);
  if (lead) {
    const resolved = resolveSeatToken(lead[1], maps);
    if (resolved) return resolved;
  }
  return null;
}

// ---------- owner picking (pure) ----------

/**
 * Build the assignment record from a parse: one owner per part,
 * or an unassigned part with the reason named. `members` is the
 * channel roster in config order (providers and custom handles);
 * `gate` is tenant-agent-state's claimGateFor result (null when
 * the tenant is ungated, in which case every roster seat is
 * assignable). The record is what the assignment post is rendered
 * from and what metadata.maestroAssignment carries for bite M3.
 * Pure.
 */
export function buildMaestroAssignment(parsed, { members = [], customAgents = [], gate = null } = {}) {
  const customs = customAgents ?? [];
  const maps = customMaps(customs);
  const roster = [...new Set((members ?? []).map((m) => String(m)))].filter((p) => !ROLE_OWNERS.has(p));
  const rosterSet = new Set(roster);
  const gateAllows = (seat) => {
    if (!gate) return true;
    if (gate.has(seat)) return true;
    const custom = maps.byHandle.get(seat.toLowerCase());
    return Boolean(custom && gate.has(custom.provider));
  };
  const pool = roster.filter(gateAllows);
  const poolSet = new Set(pool);
  const nameOf = (seat) => {
    const custom = maps.byHandle.get(seat.toLowerCase());
    return custom ? String(custom.name ?? seat) : (AGENT_NAMES[seat] ?? seat);
  };
  const parts = (parsed?.parts ?? []).map((part) => {
    const built = {
      n: part.n,
      text: part.text,
      owner: null,
      ownerName: null,
      namedOwner: null,
      namedOwnerName: null,
      unassignedReason: null,
    };
    const named = namedOwnerForPart(part.text, customs);
    if (named?.unresolved) {
      built.namedOwnerName = named.name;
      built.unassignedReason = 'not-a-seat';
    } else if (named) {
      built.namedOwner = named.owner;
      built.namedOwnerName = named.name;
      if (poolSet.has(named.owner)) {
        built.owner = named.owner;
        built.ownerName = named.name;
      } else {
        built.unassignedReason = rosterSet.has(named.owner) ? 'not-connected' : 'not-a-member';
      }
    }
    return built;
  });
  // The fallback round: unnamed, unassigned parts take pool seats
  // in roster order, fewest parts held first, so every seat holds
  // one part before any seat holds a second (DESIGN 2.3). Named
  // assignments already made count toward their seat's share.
  const counts = new Map(pool.map((seat) => [seat, 0]));
  for (const part of parts) if (part.owner) counts.set(part.owner, (counts.get(part.owner) ?? 0) + 1);
  for (const part of parts) {
    if (part.owner || part.unassignedReason) continue;
    if (!pool.length) { part.unassignedReason = 'no-seat-available'; continue; }
    let best = pool[0];
    for (const seat of pool) if ((counts.get(seat) ?? 0) < (counts.get(best) ?? 0)) best = seat;
    part.owner = best;
    part.ownerName = nameOf(best);
    counts.set(best, (counts.get(best) ?? 0) + 1);
  }
  return Object.freeze({ v: 1, sequential: false, parts: Object.freeze(parts) });
}

/**
 * The assignment post's words: one line per part, in order, the
 * owner named and the part text quoted; an unassigned part says
 * why, in the open. The post answers nothing itself. Pure.
 */
export function maestroAssignmentBody(assignment) {
  const parts = assignment?.parts ?? [];
  const lines = [`Maestro here. This job has ${parts.length} parts, one owner per part:`];
  for (const part of parts) {
    if (part.owner) {
      lines.push(`Part ${part.n}: ${part.ownerName}: "${part.text}"`);
    } else if (part.unassignedReason === 'not-a-member') {
      lines.push(`Part ${part.n}: unassigned: the part names ${part.namedOwnerName}, who is not in this channel: "${part.text}"`);
    } else if (part.unassignedReason === 'not-connected') {
      lines.push(`Part ${part.n}: unassigned: the part names ${part.namedOwnerName}, who is not connected in this workspace: "${part.text}"`);
    } else if (part.unassignedReason === 'not-a-seat') {
      lines.push(`Part ${part.n}: unassigned: the part names ${part.namedOwnerName}, who is not one of the seats here: "${part.text}"`);
    } else {
      lines.push(`Part ${part.n}: unassigned: "${part.text}"`);
    }
  }
  return lines.join('\n');
}

// ---------- the coordinator, on the message path ----------

async function readChannelConfig(client, tenantId, channelId) {
  const r = await client.query(
    `select body from helmion.envoy_messages where tenant_id=$1 and channel_id=$2 and author_subject=$3 order by created_at desc, id desc limit 1`,
    [String(tenantId), String(channelId), CONFIG_SUBJECT],
  );
  return r.rowCount ? parseConfig(r.rows[0].body) : null;
}

/**
 * Coordinate one durable human message addressed to Maestro, if
 * it parses into explicitly enumerated parts. Runs in its own
 * tenant transaction after the send is durable (the guide and
 * empty-desk pattern): a failure is the caller's to log and never
 * fails the send. On a parse with at least one assignable part,
 * posts the one assignment message as agent:maestro (idempotency
 * key maestro-assignment:<messageId>) and merges the assignment
 * record onto the human message's metadata as maestroAssignment.
 * On anything else (no parse, no roster, no part assignable)
 * posts nothing, marks nothing, and returns { assigned: false }:
 * the send falls through to the hooks after the coordinator in
 * the precedence order, unchanged. `stateOn` is injectable for
 * tests, the empty-desk pattern.
 */
export async function postMaestroAssignmentIfNeeded({ pool, tenantId, channelId, messageId, senderSubject, body, stateOn = tenantAgentStateOn } = {}) {
  const parsed = parseMaestroParts(body);
  if (!parsed) return { assigned: false };
  const client = await pool.connect();
  try {
    await client.query('begin');
    await client.query(`select set_config('helmion.tenant_id', $1, true)`, [String(tenantId)]);
    const config = await readChannelConfig(client, tenantId, channelId);
    const state = await stateOn(client, tenantId);
    const assignment = buildMaestroAssignment(parsed, {
      members: config?.agents ?? [],
      customAgents: config?.customAgents ?? [],
      gate: claimGateFor(state),
    });
    if (!assignment.parts.some((part) => part.owner)) {
      await client.query('commit');
      return { assigned: false };
    }
    const inserted = await client.query(
      `insert into helmion.envoy_messages(tenant_id, channel_id, author_subject, author_kind, body, idempotency_key, metadata)
       values ($1,$2,$3,'agent',$4,$5,$6)
       on conflict (tenant_id, channel_id, author_subject, idempotency_key) do nothing
       returning id`,
      [String(tenantId), String(channelId), MAESTRO_ASSIGNMENT_SUBJECT, maestroAssignmentBody(assignment), `${MAESTRO_ASSIGNMENT_KEY_PREFIX}${messageId}`,
        JSON.stringify({ maestroAssignment: assignment })],
    );
    if (inserted.rowCount !== 1) {
      await client.query('commit');
      return { assigned: false };
    }
    await client.query(
      `update helmion.envoy_messages
          set metadata = coalesce(metadata, '{}'::jsonb) || $5::jsonb
        where tenant_id=$1 and channel_id=$2 and id=$3 and author_subject=$4`,
      [String(tenantId), String(channelId), messageId, String(senderSubject),
        JSON.stringify({ maestroAssignment: assignment })],
    );
    await client.query('commit');
    return { assigned: true, messageId: String(inserted.rows[0].id), assignment };
  } catch (error) {
    try { await client.query('rollback'); } catch {}
    throw error;
  } finally { client.release(); }
}

// ---------- settle watching and close-out (bite M4) ----------

export const MAESTRO_CLOSEOUT_KEY_PREFIX = 'maestro-closeout:';
export const MAESTRO_UNSETTLED_KEY_PREFIX = 'maestro-unsettled:';
export const MAESTRO_CLOSEOUT_BODY = 'All parts are in';
// The window a part's owner has to post before the part is
// named unanswered: the mesh's work window (WORK_WINDOW_MS in
// envoy-mesh.mjs), the same span in which the part is handed
// out. The mesh passes its own constant in; this default keeps
// the two in step when the watcher is called without one.
export const MAESTRO_SETTLE_WINDOW_MS = 30 * 60 * 1000;

/**
 * The unsettled line for one part: it names the part and its
 * owner, and says the observable truth — no answer was posted
 * (DESIGN 2.5). A seat that answered but whose send failed to
 * verify is indistinguishable in the channel record from a
 * seat that never answered, and the line claims nothing the
 * record cannot show. Pure.
 */
export function maestroUnsettledBody(part) {
  return `Part ${part.n}: no answer posted from ${part.ownerName || part.owner}.`;
}

/**
 * Decide what one marked message's settle state calls for.
 * Pure. `settledOwners` is the set of owners with a reply in
 * the channel record (the reply record is per seat per
 * message, so one reply settles every part that seat owns —
 * the M3 rule); `closed` says the close line already stands;
 * `namedUnsettled` is the set of part numbers already named
 * unanswered; `ageMs` is the marked message's age. A part the
 * coordinator left unassigned is not this function's concern:
 * it has no owner to settle or to name, and the assignment
 * post already named it in the open. The close line is due
 * when every part WITH an owner has that owner's reply. An
 * unsettled line is due for an owned, unanswered part only
 * once the message is as old as the work window — the owner
 * had the whole window the part was handed out in, and posted
 * nothing (DESIGN 2.3: "has not posted within the window").
 */
export function maestroSettlePlan(assignment, { settledOwners = new Set(), closed = false, namedUnsettled = new Set(), ageMs = 0, workWindowMs = MAESTRO_SETTLE_WINDOW_MS } = {}) {
  const parts = Array.isArray(assignment?.parts) ? assignment.parts : [];
  const owned = parts.filter((p) => p && typeof p.owner === 'string' && p.owner);
  if (!owned.length) return { allSettled: false, closeOut: false, unsettled: [] };
  if (owned.every((p) => settledOwners.has(p.owner))) {
    return { allSettled: true, closeOut: !closed, unsettled: [] };
  }
  const unsettled = ageMs >= workWindowMs
    ? owned.filter((p) => !settledOwners.has(p.owner) && !namedUnsettled.has(p.n))
    : [];
  return { allSettled: false, closeOut: false, unsettled };
}

const SETTLE_ROW_COLS = 'id, channel_id, author_subject, author_kind, body, idempotency_key, created_at, metadata';

async function insertSettleLine(client, { tenantId, channelId, body, key, metadata }) {
  const r = await client.query(
    `insert into helmion.envoy_messages(tenant_id, channel_id, author_subject, author_kind, body, idempotency_key, metadata)
     values ($1,$2,$3,'agent',$4,$5,$6)
     on conflict (tenant_id, channel_id, author_subject, idempotency_key) do nothing
     returning ${SETTLE_ROW_COLS}`,
    [String(tenantId), String(channelId), MAESTRO_ASSIGNMENT_SUBJECT, body, key, JSON.stringify(metadata)],
  );
  return r.rowCount === 1 ? r.rows[0] : null;
}

/**
 * Check the open assignments in the channels one poll served
 * and post what is due (bite M4, DESIGN 2.3): the one close
 * line for an assignment whose owned parts all have replies,
 * and one unsettled line per owned part whose owner posted
 * nothing within the work window. Runs in ONE tenant
 * transaction for the whole poll — the coordinator's
 * transaction pattern, at the poll's scale: a poll on a
 * four-second loop cannot afford a transaction per channel
 * (the pool-bounds discipline the 504 fixes bought), so the
 * watcher reads every served channel's marked messages in a
 * single query and writes only the lines that are due. The
 * mesh calls it from the poll's deferred tail, so a failure
 * is the caller's to log and never fails the poll.
 *
 * Exactly-once is durable, not remembered: the close line and
 * each unsettled line insert under their own idempotency keys
 * (maestro-closeout:<messageId>,
 * maestro-unsettled:<messageId>:<part>) on the same unique
 * constraint the assignment post uses, so a re-run, a duplicate
 * trigger, or two racing polls can never post a second line.
 * The watcher reads marked messages up to two work windows
 * old: one window for the owners to answer in, and one more in
 * which a poll can still see the assignment to name its
 * unsettled parts and catch a late-landing reply for the
 * close line. Beyond that the record stands as posted.
 *
 * Returns { posted, completions }: the rows this call actually
 * inserted (the caller publishes them), and one completion job
 * per fully settled assignment — settled state, not insert
 * state, so a completion whose Librarian filing failed on an
 * earlier poll is offered again until it lands; the store's
 * own key keeps the record to exactly one.
 */
export async function settleMaestroAssignmentsIfNeeded({ pool, tenantId, channelIds, now = Date.now(), workWindowMs = MAESTRO_SETTLE_WINDOW_MS } = {}) {
  const posted = [];
  const completions = [];
  const channels = [...new Set((channelIds ?? []).map((id) => String(id ?? '')).filter(Boolean))];
  if (!channels.length) return { posted, completions };
  const since = new Date(now - 2 * workWindowMs).toISOString();
  const client = await pool.connect();
  try {
    await client.query('begin');
    await client.query(`select set_config('helmion.tenant_id', $1, true)`, [String(tenantId)]);
    const marked = await client.query(
      `select m.id, m.channel_id, m.author_subject, m.created_at, m.metadata,
              c.slug as channel_slug, c.title as channel_title
         from helmion.envoy_messages m
         join helmion.envoy_channels c on c.tenant_id = m.tenant_id and c.id = m.channel_id
        where m.tenant_id=$1 and m.channel_id = any($2::uuid[]) and m.author_kind='human'
          and m.created_at > $3 and m.metadata -> 'maestroAssignment' is not null
        order by m.created_at asc, m.id asc`,
      [String(tenantId), channels, since],
    );
    if (!marked.rowCount) {
      await client.query('commit');
      return { posted, completions };
    }
    const replyKeys = marked.rows.map((r) => `reply:${r.id}`);
    const settleKeys = [];
    for (const r of marked.rows) {
      settleKeys.push(`${MAESTRO_CLOSEOUT_KEY_PREFIX}${r.id}`);
      let meta = r.metadata ?? null;
      if (typeof meta === 'string') { try { meta = JSON.parse(meta); } catch { meta = null; } }
      const count = Array.isArray(meta?.maestroAssignment?.parts) ? meta.maestroAssignment.parts.length : 0;
      for (let n = 1; n <= count; n++) settleKeys.push(`${MAESTRO_UNSETTLED_KEY_PREFIX}${r.id}:${n}`);
    }
    const replies = await client.query(
      `select author_subject, idempotency_key from helmion.envoy_messages
        where tenant_id=$1 and channel_id = any($2::uuid[]) and idempotency_key = any($3)`,
      [String(tenantId), channels, replyKeys],
    );
    const settledBy = new Map();
    for (const r of replies.rows) {
      const messageId = String(r.idempotency_key).slice('reply:'.length);
      const subject = String(r.author_subject ?? '');
      if (!subject.startsWith('agent:')) continue;
      if (!settledBy.has(messageId)) settledBy.set(messageId, new Set());
      settledBy.get(messageId).add(subject.slice('agent:'.length));
    }
    const existing = await client.query(
      `select idempotency_key from helmion.envoy_messages
        where tenant_id=$1 and channel_id = any($2::uuid[]) and author_subject=$3 and idempotency_key = any($4)`,
      [String(tenantId), channels, MAESTRO_ASSIGNMENT_SUBJECT, settleKeys],
    );
    const existingKeys = new Set(existing.rows.map((r) => String(r.idempotency_key)));
    for (const r of marked.rows) {
      const messageId = String(r.id);
      const channelId = String(r.channel_id);
      let meta = r.metadata ?? null;
      if (typeof meta === 'string') { try { meta = JSON.parse(meta); } catch { meta = null; } }
      const assignment = meta?.maestroAssignment ?? null;
      const namedUnsettled = new Set();
      for (const part of assignment?.parts ?? []) {
        if (part && existingKeys.has(`${MAESTRO_UNSETTLED_KEY_PREFIX}${messageId}:${part.n}`)) namedUnsettled.add(part.n);
      }
      const plan = maestroSettlePlan(assignment, {
        settledOwners: settledBy.get(messageId) ?? new Set(),
        closed: existingKeys.has(`${MAESTRO_CLOSEOUT_KEY_PREFIX}${messageId}`),
        namedUnsettled,
        ageMs: now - new Date(r.created_at).getTime(),
        workWindowMs,
      });
      if (plan.allSettled) {
        if (plan.closeOut) {
          const row = await insertSettleLine(client, {
            tenantId, channelId,
            body: MAESTRO_CLOSEOUT_BODY,
            key: `${MAESTRO_CLOSEOUT_KEY_PREFIX}${messageId}`,
            metadata: { maestroCloseout: { messageId } },
          });
          if (row) posted.push(row);
        }
        completions.push({
          channelId,
          channelSlug: r.channel_slug,
          channelTitle: r.channel_title,
          messageId,
          humanSubject: String(r.author_subject ?? ''),
          assignment,
          at: new Date(now).toISOString(),
        });
        continue;
      }
      for (const part of plan.unsettled) {
        const row = await insertSettleLine(client, {
          tenantId, channelId,
          body: maestroUnsettledBody(part),
          key: `${MAESTRO_UNSETTLED_KEY_PREFIX}${messageId}:${part.n}`,
          metadata: { maestroUnsettled: { messageId, part: part.n } },
        });
        if (row) posted.push(row);
      }
    }
    await client.query('commit');
    return { posted, completions };
  } catch (error) {
    try { await client.query('rollback'); } catch {}
    throw error;
  } finally { client.release(); }
}
