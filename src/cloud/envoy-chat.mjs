import { publishEnvoyMessage } from './envoy-ably.mjs';

const KINDS = new Set(['team', 'direct', 'agent']);
const AUTHORS = new Set(['human', 'agent', 'system']);

function text(value, name, max) {
  const result = String(value ?? '').trim();
  if (!result || result.length > max) throw new Error(`${name} is missing or too long`);
  return result;
}

function cursor(value) {
  if (value === undefined || value === null || value === '') return null;
  const result = String(value).trim();
  if (!/^\d{1,20}$/.test(result)) throw new Error('message cursor is invalid');
  return result;
}

export function normalizeEnvoyChannel(input) {
  const slug = text(input?.slug, 'channel slug', 64).toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(slug)) throw new Error('channel slug is invalid');
  const kind = text(input?.kind ?? 'team', 'channel kind', 16).toLowerCase();
  if (!KINDS.has(kind)) throw new Error('channel kind is unsupported');
  return Object.freeze({ slug, title: text(input?.title, 'channel title', 120), kind });
}

export function normalizeEnvoyMessage(input) {
  const authorKind = text(input?.authorKind, 'author kind', 16).toLowerCase();
  if (!AUTHORS.has(authorKind)) throw new Error('author kind is unsupported');
  // Attachments arrive either as a `metadata` object or as a bare
  // `attachments` array (the picker's two shapes); both normalize to the
  // one stored metadata form. Absent stays absent — the pre-picker wire
  // shape is unchanged.
  const metadata = normalizeMessageMetadata(input?.metadata ?? (input?.attachments !== undefined ? { attachments: input.attachments } : undefined));
  return Object.freeze({
    channelId: text(input?.channelId, 'channel id', 64),
    authorSubject: text(input?.authorSubject, 'author subject', 256),
    authorKind,
    body: text(input?.body, 'message body', 4000),
    ...(metadata ? { metadata } : {}),
  });
}

/**
 * Envoy is allowed to display/send a message only after the caller has
 * already established the same tenant membership used by the other surfaces.
 * This helper is a policy seam, not an authorization bypass or agent runner.
 */
export function assertEnvoyMembership({ tenantId, subject, role, canUseEnvoy }) {
  if (!text(tenantId, 'tenant id', 128) || !text(subject, 'subject', 256)) {
    throw new Error('Envoy identity is incomplete');
  }
  if (!['owner', 'admin', 'member', 'auditor'].includes(String(role ?? '').toLowerCase())) {
    throw new Error('Envoy role is unsupported');
  }
  if (canUseEnvoy !== true) throw new Error('Envoy access is not enabled for this identity');
  return true;
}

function contextFor(actor) {
  assertEnvoyMembership({ tenantId: actor.tenantId, subject: actor.subject, role: actor.role, canUseEnvoy: true });
  return { tenantId: actor.tenantId, actorSubject: actor.subject, actorRole: actor.role, sessionId: actor.sessionId, requestId: actor.requestId };
}

function rowMessage(row, authorEmoji = null) {
  const who = describeAuthor(row.author_subject, row.author_kind);
  const metadata = row.metadata ? normalizeMessageMetadata(typeof row.metadata === 'string' ? JSON.parse(row.metadata) : row.metadata) : null;
  return Object.freeze({ id: String(row.id), channelId: String(row.channel_id), authorSubject: String(row.author_subject), authorKind: String(row.author_kind), ...(who.name ? { authorName: who.name } : {}), ...(authorEmoji ? { authorEmoji } : {}), source: who.source, ...(who.provider ? { agentProvider: who.provider } : {}), body: String(row.body), ...(metadata ? { metadata } : {}), idempotencyKey: String(row.idempotency_key), createdAt: row.created_at });
}

// Member faces (emoji bite 5): a human author's profile emoji
// (helmion.user_profiles.avatar_emoji — the Settings > Envoy profile
// record) rides their messages, so every client renders the member's
// chosen face instead of a bare initial. Best-effort by shape:
// profiles are a separate store with their own migration history
// (059/062), so a missing table or a failed read yields no faces,
// never a failed message list.
async function profileEmojis(client, subjects) {
  const wanted = [...new Set((subjects ?? []).filter((s) => typeof s === 'string' && s))];
  if (!wanted.length) return new Map();
  try {
    const r = await client.query('select subject, avatar_emoji from helmion.user_profiles where subject = any($1::text[])', [wanted]);
    return new Map(r.rows.filter((row) => row.avatar_emoji).map((row) => [String(row.subject), String(row.avatar_emoji)]));
  } catch { return new Map(); }
}

// ---------- the empty-desk answer (polish P1, 2026-11-09) ----------
// The fresh-signup walk's headline finding: a first message in a
// workspace with no AI connected got a dispatch line and then
// silence — the mesh withholds the work (no provider credential to
// hand it to) and nothing told the person. The state module names
// that honestly in its banner; this is the same honesty inside the
// channel, as a reply: when a human send lands in a tenant with
// ZERO connected providers (tenant-agent-state's connectedProviders
// — runner presence reports and stored connections), Maestro
// answers the message himself with the one fix: connect an AI from
// the Agents tab. The answer is a stored agent message under
// 'agent:maestro', so it renders as Maestro, persists like any
// reply, and is filtered out of every routing result by the same
// 'maestro' exclusions that guard the desk. It is NOT gated on the
// state module's `gated` flag: a brand-new workspace has no
// readiness signals at all and is exactly the case that must be
// answered, while a hand-wired tenant whose runners resolve
// credentials locally reports connected providers and never sees
// it. Two restraint rules: a replayed send (idempotent retry)
// answers nothing new, and the answer never answers itself — when
// the channel's previous word is already this answer, the next
// send waits for a connection instead of stacking copies.
export const EMPTY_DESK_SUBJECT = 'agent:maestro';
export const EMPTY_DESK_ANSWER_BODY = 'Maestro here — no AI is connected to this workspace yet, so nobody can answer your message. Open the Agents tab and press Connect on the AI you already have, and your messages will be answered here.';
export const EMPTY_DESK_KEY_PREFIX = 'maestro-empty-desk:';

/** The pure decision: answer this send, or stay quiet. */
export function emptyDeskAnswerDecision({ connectedProviders, previousSubject, previousKey } = {}) {
  if (!Array.isArray(connectedProviders) || connectedProviders.length > 0) return false;
  if (previousSubject === EMPTY_DESK_SUBJECT && String(previousKey ?? '').startsWith(EMPTY_DESK_KEY_PREFIX)) return false;
  return true;
}

/**
 * Post the empty-desk answer for one durable human message, in its
 * own tenant transaction (the maestro-activation notice pattern:
 * best-effort, separate from the send's durability). `stateOn` is
 * injectable for tests. Returns { answered } — a thrown error is
 * the caller's to log; this helper never swallows one silently.
 */
export async function postEmptyDeskAnswerIfNeeded({ pool, tenantId, channelId, messageId, stateOn = tenantAgentStateOn } = {}) {
  const client = await pool.connect();
  try {
    await client.query('begin');
    await client.query(`select set_config('helmion.tenant_id', $1, true)`, [String(tenantId)]);
    const state = await stateOn(client, tenantId);
    const prev = await client.query(
      `select author_subject, idempotency_key from helmion.envoy_messages
        where tenant_id=$1 and channel_id=$2 and author_subject <> $3 and id <> $4
        order by id desc limit 1`,
      [String(tenantId), String(channelId), CONFIG_SUBJECT, messageId],
    );
    const previous = prev.rows[0] ?? null;
    const answer = emptyDeskAnswerDecision({
      connectedProviders: state?.connectedProviders,
      previousSubject: previous?.author_subject ?? null,
      previousKey: previous?.idempotency_key ?? null,
    });
    if (!answer) { await client.query('commit'); return { answered: false }; }
    const inserted = await client.query(
      `insert into helmion.envoy_messages(tenant_id, channel_id, author_subject, author_kind, body, idempotency_key)
       values ($1,$2,$3,'agent',$4,$5)
       on conflict (tenant_id, channel_id, author_subject, idempotency_key) do nothing
       returning id`,
      [String(tenantId), String(channelId), EMPTY_DESK_SUBJECT, EMPTY_DESK_ANSWER_BODY, `${EMPTY_DESK_KEY_PREFIX}${messageId}`],
    );
    await client.query('commit');
    return { answered: inserted.rowCount === 1, messageId: inserted.rows[0] ? String(inserted.rows[0].id) : null };
  } catch (error) {
    try { await client.query('rollback'); } catch {}
    throw error;
  } finally { client.release(); }
}

// ---------- the Librarian filing (bite L1, 2026-11-15) ----------
// A human who addresses the Librarian with a file request ("Librarian:
// file this fact. X", "Librarian, remember: X") is not asking the
// desk a question: they are handing the workspace's memory keeper a
// fact to file. Before this bite there was no such road — the send
// washed through dispatch as an ordinary ask, and the desk improvised
// competing filings (a JSON file delivered as "the filing", seats
// claiming they had filed, seats declining). Now the send is caught
// here, on the send path, in the hook precedence of DESIGN section
// 1.5 (coordinator, Helm, Librarian, guide, empty-desk): the fact is
// written through the Librarian's one store (envoy-librarian.mjs
// fileFact, under the tenant's own slug, never NULL), the Librarian
// confirms in the channel as agent:librarian quoting what was filed,
// and the human message is marked (metadata.librarianFact) so the
// mesh never hands it to the desk as an ask — the guide's mark
// pattern, one namespace over. A Librarian-addressed send that is
// NOT a file request parses to nothing here and falls through to
// ordinary dispatch untouched: the Librarian's name never swallows
// an ordinary ask. Filing is best-effort in the house shape: a
// failure is logged by the caller and never fails the send, and an
// unfiled fact is never confirmed — the confirmation posts only
// after the store's write lands.
export const LIBRARIAN_SUBJECT = 'agent:librarian';
export const LIBRARIAN_FACT_KEY_PREFIX = 'librarian-fact:';

// The address at the head of the send: the roleAddresseeIn
// vocative shapes (an optional greeting, an optional @, an
// optional "the"), then the role's name and its punctuation. The
// filing instruction must lead what remains — a file request
// named mid-message is a sentence about filing, not a filing.
const LIBRARIAN_ADDRESS_RE = /^\s*(?:(?:hey|hi|hello)\s+)?@?(?:the\s+)?librarian\b\s*[:,]?\s*/i;
const LIBRARIAN_FILE_FACT_RE = /^file\s+this\s+fact\b\s*[.:]?\s*/i;
const LIBRARIAN_REMEMBER_RE = /^remember\b\s*[:]?\s*/i;

/**
 * The fact a Librarian-addressed send asks to file, or null when
 * the send is not a file request. Pure and deterministic: the
 * fact is the text after the file instruction, in the two shapes
 * the design names ("file this fact" and "remember"), and a
 * request with no fact after the instruction files nothing.
 */
export function librarianFactRequestIn(body) {
  const text = String(body ?? '');
  const address = LIBRARIAN_ADDRESS_RE.exec(text);
  if (!address) return null;
  const rest = text.slice(address[0].length);
  const instruction = LIBRARIAN_FILE_FACT_RE.exec(rest) ?? LIBRARIAN_REMEMBER_RE.exec(rest);
  if (!instruction) return null;
  const fact = rest.slice(instruction[0].length).trim();
  return fact || null;
}

/**
 * File one Librarian-addressed send's fact and confirm it in the
 * channel. Runs after the send is durable, like the guide and
 * empty-desk answers: the store write runs in the store's own
 * tenant transaction; the confirmation and the mark run in one
 * transaction of their own, and only when the write landed — a
 * confirmation is posted exactly once per send (idempotency key
 * librarian-fact:<messageId>), and the mark lands only with it,
 * so a filed-but-unconfirmed send is never hidden from the desk
 * by a mark whose confirmation failed to post. Returns
 * { filed, confirmed?, key? } — a thrown error is the caller's
 * to log; this helper never swallows one silently.
 */
export async function postLibrarianFactIfNeeded({ pool, tenantId, channelId, messageId, senderSubject, senderName = null, senderRole, body, store = null, at = null } = {}) {
  const fact = librarianFactRequestIn(body);
  if (!fact) return { filed: false };
  const librarian = store ?? createLibrarianStore(pool);
  const filed = await librarian.fileFact(
    { tenantId, subject: senderSubject, role: senderRole },
    { messageId, channelId, humanName: senderName, humanSubject: senderSubject, fact, at: at ?? new Date().toISOString() },
  );
  if (!filed?.filed) return { filed: false, reason: filed?.reason ?? 'not-filed' };
  const client = await pool.connect();
  try {
    await client.query('begin');
    await client.query(`select set_config('helmion.tenant_id', $1, true)`, [String(tenantId)]);
    const inserted = await client.query(
      `insert into helmion.envoy_messages(tenant_id, channel_id, author_subject, author_kind, body, idempotency_key, metadata)
       values ($1,$2,$3,'agent',$4,$5,$6)
       on conflict (tenant_id, channel_id, author_subject, idempotency_key) do nothing
       returning id`,
      [String(tenantId), String(channelId), LIBRARIAN_SUBJECT, `Filed: ${filed.fact}`, `${LIBRARIAN_FACT_KEY_PREFIX}${messageId}`,
        JSON.stringify({ librarianFact: { key: filed.key, forSubject: String(senderSubject) } })],
    );
    if (inserted.rowCount !== 1) { await client.query('commit'); return { filed: true, confirmed: false, key: filed.key }; }
    await client.query(
      `update helmion.envoy_messages
          set metadata = coalesce(metadata, '{}'::jsonb) || $5::jsonb
        where tenant_id=$1 and channel_id=$2 and id=$3 and author_subject=$4`,
      [String(tenantId), String(channelId), messageId, String(senderSubject),
        JSON.stringify({ librarianFact: { key: filed.key, filedBy: 'librarian' } })],
    );
    await client.query('commit');
    return { filed: true, confirmed: true, key: filed.key, messageId: String(inserted.rows[0].id) };
  } catch (error) {
    try { await client.query('rollback'); } catch {}
    throw error;
  } finally { client.release(); }
}

// ---------- the Librarian recall (bite L2, 2026-11-16) ----------
// The other half of the Librarian's channel road: a human who
// addresses the Librarian with a recall question ("Librarian:
// what do you have filed about X") is asking the workspace's
// memory keeper about the filed record, and the Librarian
// answers alone, as agent:librarian, quoting the matching
// entry verbatim — bounded at the entry's own text, so no
// seat answers from the 12-message history window and no seat
// drops a character from a date (tonight's message 4: the
// fact came back with the "15" dropped, twice, because seats
// were improvising a recall where no recall behaviour
// existed). The lookup is the store's lookupFacts (facts
// first, then ask records, under the acting tenant's slug
// exactly); a question whose topic names incidents is
// answered from lookupIncidents instead, the store's incident
// read. If nothing matches, the Librarian says so in one line
// — "I have nothing filed about X" — and files nothing. The
// send is marked (metadata.librarianRecall) so the mesh never
// hands it to the desk, the guide pattern one namespace over
// from L1's filing mark. The hook sits in the same Librarian
// slot as L1's filing hook in the section 1.5 precedence,
// after it: a file request files (and never parses as a
// recall — the recall shapes lead with "what"), a recall the
// filing hook leaves is answered here, and a Librarian send
// that is neither falls through to ordinary dispatch
// untouched — the name never swallows an ordinary ask.
// Answering is best-effort in the house shape: a failure is
// logged by the caller and never fails the send, and an
// unanswered recall is never marked — the answer and the
// mark land in one transaction, the mark only with the
// answer, so a send whose answer failed to post is never
// hidden from the desk.
export const LIBRARIAN_RECALL_KEY_PREFIX = 'librarian-recall:';

// The recall shapes, over what follows the Librarian's
// address (the L1 address pattern): the design's question —
// "what do you have filed about X" — and its closest kin.
// The topic is what the question is about: it feeds the
// lookup and names the none-found line. A trailing "?" or
// "." is punctuation, not topic.
const LIBRARIAN_RECALL_HAVE_FILED_RE = /^what\s+(?:(?:do|did)\s+you\s+have|have\s+you)\s+filed\s+(?:about|on|for)\s+(.+)$/is;
const LIBRARIAN_RECALL_IS_FILED_RE = /^what(?:'s|\s+is)\s+filed\s+(?:about|on|for)\s+(.+)$/is;
const LIBRARIAN_RECALL_ON_FILE_RE = /^what\s+do\s+you\s+have\s+on\s+file\s+(?:about|on|for)\s+(.+)$/is;
const LIBRARIAN_INCIDENT_WORD_RE = /\bincidents?\b/i;

/**
 * The recall a Librarian-addressed send asks for, or null
 * when the send is not a recall question. Pure and
 * deterministic: returns { topic, incident } — the topic
 * the question names, and whether the topic is
 * incident-shaped (answered from the incident read, not
 * the filed entries). A recall shape with no topic after
 * it ("what do you have filed?") asks about nothing in
 * particular and is not a recall: it falls through.
 */
export function librarianRecallRequestIn(body) {
  const text = String(body ?? '');
  const address = LIBRARIAN_ADDRESS_RE.exec(text);
  if (!address) return null;
  const rest = text.slice(address[0].length);
  const match = LIBRARIAN_RECALL_HAVE_FILED_RE.exec(rest)
    ?? LIBRARIAN_RECALL_IS_FILED_RE.exec(rest)
    ?? LIBRARIAN_RECALL_ON_FILE_RE.exec(rest);
  if (!match) return null;
  const topic = match[1].replace(/[\s?.]+$/, '').trim();
  if (!topic) return null;
  return { topic, incident: LIBRARIAN_INCIDENT_WORD_RE.test(topic) };
}

/**
 * Answer one Librarian-addressed send's recall question from
 * the filed record and mark the send. The lookup runs in the
 * store's own tenant transaction; the answer and the mark
 * run in one transaction of their own, and only when the
 * lookup completed — the answer posts exactly once per send
 * (idempotency key librarian-recall:<messageId>), and the
 * mark lands only with it. A match answers with the entry's
 * own text, verbatim, nothing added; an incident-shaped
 * topic answers with the newest matching incident in the
 * knowledge base's own rendering ([category] title, with
 * its fix when one is filed); no match answers with the
 * none-found line naming the topic, and files nothing.
 * Returns { answered, found?, key? } — a thrown error is
 * the caller's to log; this helper never swallows one
 * silently.
 */
export async function postLibrarianRecallIfNeeded({ pool, tenantId, channelId, messageId, senderSubject, senderRole, body, store = null } = {}) {
  const request = librarianRecallRequestIn(body);
  if (!request) return { answered: false };
  const librarian = store ?? createLibrarianStore(pool);
  const actor = { tenantId, subject: senderSubject, role: senderRole };
  let answerBody;
  let found = false;
  let key = null;
  if (request.incident) {
    // The incident read's own search discipline: the topic
    // minus the shape word is the search string (a bare
    // "incidents" topic searches nothing and reads newest
    // first). The newest match is the answer.
    const query = request.topic.replace(/\bincidents?\b/gi, ' ').replace(/\s+/g, ' ').trim() || null;
    const incidents = await librarian.lookupIncidents(actor, { query, limit: 20 });
    const incident = Array.isArray(incidents) ? incidents[0] ?? null : null;
    if (incident) {
      found = true;
      answerBody = incident.solution ? `[${incident.category}] ${incident.title} — Fix: ${incident.solution}` : `[${incident.category}] ${incident.title}`;
    } else {
      answerBody = `I have nothing filed about ${request.topic}`;
    }
  } else {
    const hit = await librarian.lookupFacts(actor, { query: request.topic });
    if (hit?.found) {
      found = true;
      key = hit.key ?? null;
      answerBody = hit.text;
    } else {
      answerBody = `I have nothing filed about ${request.topic}`;
    }
  }
  const client = await pool.connect();
  try {
    await client.query('begin');
    await client.query(`select set_config('helmion.tenant_id', $1, true)`, [String(tenantId)]);
    const inserted = await client.query(
      `insert into helmion.envoy_messages(tenant_id, channel_id, author_subject, author_kind, body, idempotency_key, metadata)
       values ($1,$2,$3,'agent',$4,$5,$6)
       on conflict (tenant_id, channel_id, author_subject, idempotency_key) do nothing
       returning id`,
      [String(tenantId), String(channelId), LIBRARIAN_SUBJECT, answerBody, `${LIBRARIAN_RECALL_KEY_PREFIX}${messageId}`,
        JSON.stringify({ librarianRecall: { key, forSubject: String(senderSubject) } })],
    );
    if (inserted.rowCount !== 1) { await client.query('commit'); return { answered: true, confirmed: false, found, key }; }
    await client.query(
      `update helmion.envoy_messages
          set metadata = coalesce(metadata, '{}'::jsonb) || $5::jsonb
        where tenant_id=$1 and channel_id=$2 and id=$3 and author_subject=$4`,
      [String(tenantId), String(channelId), messageId, String(senderSubject),
        JSON.stringify({ librarianRecall: { key, answeredBy: 'librarian' } })],
    );
    await client.query('commit');
    return { answered: true, confirmed: true, found, key, messageId: String(inserted.rows[0].id) };
  } catch (error) {
    try { await client.query('rollback'); } catch {}
    throw error;
  } finally { client.release(); }
}

// ---------- the Librarian incident commands (bite L3, 2026-11-16) ----------
// The third Librarian road: a human reviewing the workspace's
// incidents in channel. The store has carried solveIncident,
// refileIncident and supersedeIncident since the knowledge
// base was built, with zero callers in shipped code — so
// nothing was ever solved, readKnowledgeBaseBlock rendered an
// always-empty base, and the flywheel the README describes
// could not turn. These commands are the human road into
// those methods: a Librarian-addressed send in one of the
// three command shapes runs the store method and, when the
// store acts, the Librarian confirms in the channel as
// agent:librarian, quoting the incident id and the outcome.
// The hook sits in the same Librarian slot of the section
// 1.5 precedence as L1 and L2, after both: a file request
// files, a recall the filing hook leaves is answered, a
// command the recall hook leaves runs here, and a Librarian
// send that is none of the three falls through to ordinary
// dispatch untouched — the name never swallows an ordinary
// ask, and an ordinary ask that merely mentions an incident
// is not a command (the shapes below must lead the send,
// anchored, with the incident id in its place).
// The decline discipline is the store's own: solveIncident
// and refileIncident answer false when they decline (an
// already-solved or unknown incident, a category the base
// does not carry), and a declined command posts NOTHING and
// marks NOTHING — the send stands as an ordinary message,
// the L1/L2 shape for a road that did not act.
// supersedeIncident declines by throwing (its existing
// contract: an unknown incident, a replacement that cannot
// file), so its decline rides the caller's log the same
// way — nothing posted, nothing marked. When the store
// acts, the confirmation and the mark (metadata.
// librarianIncident) land in one transaction, the mark only
// with the confirmation, so the mesh never hands a carried-
// out command to the desk as an ask.
export const LIBRARIAN_INCIDENT_KEY_PREFIX = 'librarian-incident:';

// The three command shapes, over what follows the
// Librarian's address (the L1 address pattern) — the
// design's sentences, anchored at the head of the send:
// the incident id is the token in its place, and what each
// shape needs after it (a solution after the colon, a
// category after "as", the replacement incident's own
// description) must be present, or the send is not the
// command.
const LIBRARIAN_SOLVE_RE = /^incident\s+(\S+)\s+is\s+solved\s*:\s*(.+)$/is;
const LIBRARIAN_REFILE_RE = /^refile\s+incident\s+(\S+)\s+as\s+(.+)$/is;
const LIBRARIAN_SUPERSEDE_RE = /^incident\s+(\S+)\s+is\s+replaced\s+by\s+(.+)$/is;

/**
 * The incident command a Librarian-addressed send carries,
 * or null when the send is not one. Pure and deterministic:
 * returns { kind: 'solve', id, solution },
 * { kind: 'refile', id, category } (the category lowercased,
 * as the store files it), or
 * { kind: 'supersede', id, replacement } (the replacement
 * incident's description, as written). A shape missing its
 * payload — a solve with no solution after the colon, a
 * refile with no category — is not a command and falls
 * through.
 */
export function librarianIncidentCommandIn(body) {
  const text = String(body ?? '');
  const address = LIBRARIAN_ADDRESS_RE.exec(text);
  if (!address) return null;
  const rest = text.slice(address[0].length);
  let match = LIBRARIAN_SOLVE_RE.exec(rest);
  if (match) {
    const solution = match[2].trim();
    return solution ? { kind: 'solve', id: match[1], solution } : null;
  }
  match = LIBRARIAN_REFILE_RE.exec(rest);
  if (match) {
    const category = match[2].replace(/[\s.?!]+$/, '').trim().toLowerCase();
    return category ? { kind: 'refile', id: match[1], category } : null;
  }
  match = LIBRARIAN_SUPERSEDE_RE.exec(rest);
  if (match) {
    const replacement = match[2].trim();
    return replacement ? { kind: 'supersede', id: match[1], replacement } : null;
  }
  return null;
}

/**
 * Run one Librarian-addressed send's incident command
 * through the store and confirm it in the channel. The
 * store call runs in the store's own tenant transaction;
 * the confirmation and the mark run in one transaction of
 * their own, and only when the store acted — the
 * confirmation posts exactly once per send (idempotency
 * key librarian-incident:<messageId>), quoting the
 * incident id and the outcome, and the mark lands only
 * with it. A command the store declines by value (solve,
 * refile) returns { handled: true, acted: false } and
 * posts nothing; a supersede the store declines throws,
 * the caller's to log, and likewise posts nothing.
 * Returns { handled: false } for a send that is not a
 * command, before any store exists.
 */
export async function postLibrarianIncidentCommandIfNeeded({ pool, tenantId, channelId, messageId, senderSubject, senderRole, body, store = null } = {}) {
  const command = librarianIncidentCommandIn(body);
  if (!command) return { handled: false };
  const librarian = store ?? createLibrarianStore(pool);
  const actor = { tenantId, subject: senderSubject, role: senderRole };
  let answerBody;
  if (command.kind === 'solve') {
    const solved = await librarian.solveIncident(actor, { id: command.id, solution: command.solution });
    if (solved !== true) return { handled: true, acted: false, kind: command.kind, reason: 'not-solved' };
    answerBody = `Solved incident ${command.id}: ${command.solution}`;
  } else if (command.kind === 'refile') {
    const out = await librarian.refileIncident(actor, { id: command.id, toCategory: command.category });
    if (!out?.refiled) return { handled: true, acted: false, kind: command.kind, reason: 'not-refiled' };
    answerBody = out.learnedRule
      ? `Refiled incident ${command.id} as ${command.category}; learned rule ${out.learnedRule}`
      : `Refiled incident ${command.id} as ${command.category}`;
  } else {
    // The command carries ONE description of the
    // replacement incident; the store's filing requires a
    // title and a mistake, so the description fills both
    // rather than a second sentence being invented for
    // either. The key makes the filing idempotent per
    // send: a re-run declines inside the store instead of
    // filing a second replacement.
    const filed = await librarian.supersedeIncident(actor, {
      oldId: command.id,
      incident: {
        key: `supersede:${messageId}`,
        title: command.replacement,
        mistake: command.replacement,
        actor: String(senderSubject),
      },
    });
    answerBody = `Incident ${command.id} is replaced by incident ${filed.id}`;
  }
  const client = await pool.connect();
  try {
    await client.query('begin');
    await client.query(`select set_config('helmion.tenant_id', $1, true)`, [String(tenantId)]);
    const inserted = await client.query(
      `insert into helmion.envoy_messages(tenant_id, channel_id, author_subject, author_kind, body, idempotency_key, metadata)
       values ($1,$2,$3,'agent',$4,$5,$6)
       on conflict (tenant_id, channel_id, author_subject, idempotency_key) do nothing
       returning id`,
      [String(tenantId), String(channelId), LIBRARIAN_SUBJECT, answerBody, `${LIBRARIAN_INCIDENT_KEY_PREFIX}${messageId}`,
        JSON.stringify({ librarianIncident: { kind: command.kind, id: command.id, forSubject: String(senderSubject) } })],
    );
    if (inserted.rowCount !== 1) { await client.query('commit'); return { handled: true, acted: true, confirmed: false, kind: command.kind }; }
    await client.query(
      `update helmion.envoy_messages
          set metadata = coalesce(metadata, '{}'::jsonb) || $5::jsonb
        where tenant_id=$1 and channel_id=$2 and id=$3 and author_subject=$4`,
      [String(tenantId), String(channelId), messageId, String(senderSubject),
        JSON.stringify({ librarianIncident: { kind: command.kind, id: command.id, actedBy: 'librarian' } })],
    );
    await client.query('commit');
    return { handled: true, acted: true, confirmed: true, kind: command.kind, messageId: String(inserted.rows[0].id) };
  } catch (error) {
    try { await client.query('rollback'); } catch {}
    throw error;
  } finally { client.release(); }
}

export function createEnvoyStore(pool) {
  return Object.freeze({
    async listChannels(actor) {
      const context = contextFor(actor);
      return withTenantTransaction(pool, context, async (client) => {
        await requireActiveTenantMembership(client, context);
        const result = await client.query('select id, slug, title, kind, created_by_subject, created_at from helmion.envoy_channels where tenant_id=$1 order by created_at, id', [context.tenantId]);
        const channels = result.rows.map((row) => Object.freeze({ id: String(row.id), slug: String(row.slug), title: String(row.title), kind: String(row.kind), createdBySubject: String(row.created_by_subject), createdAt: row.created_at }));
        const configs = await client.query(
          'select distinct on (channel_id) channel_id, body from helmion.envoy_messages where tenant_id=$1 and author_subject=$2 order by channel_id, created_at desc, id desc',
          [context.tenantId, CONFIG_SUBJECT],
        );
        const configsByChannelId = new Map(configs.rows.map((row) => [String(row.channel_id), parseConfig(row.body)]));
        return { channels: attachChannelLinks(channels, configsByChannelId), discordBot: discordBotStatus(), slackBot: slackBotStatus() };
      });
    },
    async createChannel(actor, input) {
      const channel = normalizeEnvoyChannel(input);
      const context = contextFor(actor);
      return withTenantTransaction(pool, context, async (client) => {
        await requireActiveTenantMembership(client, context);
        const result = await client.query(
          `insert into helmion.envoy_channels(tenant_id, slug, title, kind, created_by_subject)
           values ($1,$2,$3,$4,$5)
           on conflict (tenant_id, slug) do update set slug=excluded.slug
           returning id, slug, title, kind, created_by_subject, created_at, (xmax = 0) as inserted`,
          [context.tenantId, channel.slug, channel.title, channel.kind, context.actorSubject],
        );
        if (result.rows[0]?.inserted) {
          await appendAuditEvent(client, context, { actionType: 'envoy.channel.created', canonicalTarget: { channelId: String(result.rows[0].id), slug: channel.slug, kind: channel.kind }, policyVersion: 'envoy-chat.v1', decision: 'ALLOW', privacySummary: `Created the ${channel.title} channel`, result: { created: true } });
        }
        return { channel: Object.freeze({ id: String(result.rows[0].id), slug: String(result.rows[0].slug), title: String(result.rows[0].title), kind: String(result.rows[0].kind), createdBySubject: String(result.rows[0].created_by_subject), createdAt: result.rows[0].created_at }), inserted: result.rows[0]?.inserted === true };
      });
    },
    async listMessages(actor, channelId, limit = 50, afterId = null) {
      const normalizedChannelId = text(channelId, 'channel id', 64);
      const boundedLimit = Math.min(Math.max(Number(limit) || 50, 1), 100);
      const normalizedCursor = cursor(afterId);
      const context = contextFor(actor);
      return withTenantTransaction(pool, context, async (client) => {
        await requireActiveTenantMembership(client, context);
        const channel = await client.query('select id from helmion.envoy_channels where tenant_id=$1 and id=$2', [context.tenantId, normalizedChannelId]);
        if (channel.rowCount !== 1) throw new Error('Envoy channel was not found in this Organization');
        const result = normalizedCursor
          ? await client.query(
            `select id, channel_id, author_subject, author_kind, body, idempotency_key, created_at, metadata
             from helmion.envoy_messages where tenant_id=$1 and channel_id=$2 and id > $3 and author_subject <> 'system:envoy-config'
             order by id asc limit $4`,
            [context.tenantId, normalizedChannelId, normalizedCursor, boundedLimit],
          )
          : await client.query(
            `select id, channel_id, author_subject, author_kind, body, idempotency_key, created_at, metadata
             from helmion.envoy_messages where tenant_id=$1 and channel_id=$2 and author_subject <> 'system:envoy-config'
             order by created_at desc, id desc limit $3`,
            [context.tenantId, normalizedChannelId, boundedLimit],
          );
        const rows = normalizedCursor ? result.rows : result.rows.slice().reverse();
        const faces = await profileEmojis(client, rows.filter((r) => r.author_kind === 'human').map((r) => String(r.author_subject)));
        const messages = rows.map((row) => rowMessage(row, faces.get(String(row.author_subject)) ?? null));
        return { messages, nextCursor: messages.at(-1)?.id ?? normalizedCursor };
      });
    },
    async appendMessage(actor, input) {
      // Device-token callers (the PC bridge) post as agent-authored messages
      // so replies do not render as the user talking to themselves. Both
      // fields are server-derived from the verified token; the client sends
      // only body, channelId, and idempotencyKey. Browser sessions stay
      // forced to human exactly as before.
      const isBridge = actor?.viaDeviceToken === true;
      const message = normalizeEnvoyMessage({
        ...input,
        authorSubject: isBridge ? `${actor.subject}:bridge` : actor.subject,
        authorKind: isBridge ? 'agent' : 'human',
      });
      const idempotencyKey = text(input?.idempotencyKey, 'idempotency key', 200);
      const context = contextFor(actor);
      const out = await withTenantTransaction(pool, context, async (client) => {
        await requireActiveTenantMembership(client, context);
        const result = await client.query(
          `insert into helmion.envoy_messages(tenant_id, channel_id, author_subject, author_kind, body, idempotency_key, metadata)
           values ($1,$2,$3,$4,$5,$6,$7)
           on conflict (tenant_id, channel_id, author_subject, idempotency_key) do nothing
           returning id, channel_id, author_subject, author_kind, body, idempotency_key, created_at, metadata`,
          [context.tenantId, message.channelId, message.authorSubject, message.authorKind, message.body, idempotencyKey, message.metadata ? JSON.stringify(message.metadata) : null],
        );
        const row = result.rowCount === 1 ? result.rows[0] : (await client.query(
          `select id, channel_id, author_subject, author_kind, body, idempotency_key, created_at, metadata
           from helmion.envoy_messages where tenant_id=$1 and channel_id=$2 and author_subject=$3 and idempotency_key=$4`,
          [context.tenantId, message.channelId, message.authorSubject, idempotencyKey],
        )).rows[0];
        if (!row) throw new Error('Envoy message receipt was not durable');
        const faces = await profileEmojis(client, [String(row.author_subject)]);
        return { receipt: Object.freeze({ format: 'helmion.envoy-message-receipt.v1', durable: true, replayed: result.rowCount !== 1, message: rowMessage(row, faces.get(String(row.author_subject)) ?? null) }) };
      });
      // Realtime push for the PC bridge (v2). Fire-and-forget: the write is
      // already durable above, and a realtime failure must never fail the send.
      // publishEnvoyMessage never throws by contract.
      void publishEnvoyMessage({
        tenantId: context.tenantId,
        channelId: out.receipt.message.channelId,
        message: out.receipt.message,
      });
      // The empty-desk answer (polish P1): a fresh human send in a
      // workspace with no AI connected gets Maestro's answer in the
      // channel instead of silence. Best-effort, after the send is
      // durable and in its own transaction: a failure is logged and
      // never fails the send. The desk has no realtime subscriber,
      // so the answer lands on the sender's own post-send reload
      // and on every client's next poll, like any stored reply.
      if (!out.receipt.replayed && message.authorKind === 'human') {
        // Hook precedence (DESIGN section 1.5, decision D6):
        // the coordinator first, then the guide matcher, then
        // the empty-desk answer, enforced here in one place so
        // no later hook can reintroduce a preemption. A message
        // addressed to Maestro, Helm, or the Librarian is owned
        // by that role's hook and never reaches the guide matcher:
        // a dispatch order that happens to name a connector is a
        // job for the crew, not a setup question, and answering
        // it with a guide entry word for word is the failure this
        // order exists to prevent. A role-addressed send the
        // role's own hook leaves unanswered still falls through
        // to the empty-desk answer below, exactly as a send the
        // guide leaves unanswered does.
        //
        // The Maestro coordinator (envoy-assignments.mjs), the
        // first hook in the order: a Maestro-addressed message
        // that parses into explicitly enumerated parts gets ONE
        // assignment post naming one owner per part, and that is
        // the send's one Maestro message. A message the
        // coordinator cannot structure is left exactly as it was:
        // no post, no mark, ordinary dispatch.
        let assignment = null;
        if (roleAddresseeIn(message.body) === 'maestro') {
          try {
            assignment = await postMaestroAssignmentIfNeeded({ pool, tenantId: context.tenantId, channelId: message.channelId, messageId: out.receipt.message.id, senderSubject: message.authorSubject, body: message.body });
          } catch (error) {
            console.error('[envoy-chat] maestro assignment failed:', error.message);
          }
        }
        //
        // Helm's setup guide (helm-kb.mjs), for unaddressed
        // messages only: a setup question is answered by Helm
        // from the guide — word for word, one step at a time —
        // on any desk, with zero seats connected or a full crew,
        // and an unanswered question on an empty desk is filed
        // to the guide's miss queue there. Only a message the
        // guide leaves unanswered falls through to the empty-desk
        // answer below, so a fresh send gets at most one of the
        // two mouths' answers and they never fight. The mouths
        // are named apart (bite H2): the guide posts as
        // agent:helm; the empty-desk line below stays
        // agent:maestro, the manager saying the desk is empty.
        // The Librarian's hooks (bites L1, L2 and L3), in that slot
        // after the coordinator: a Librarian-addressed file
        // request is filed through the one store and confirmed in
        // the channel, a recall question the filing hook
        // leaves is answered from the filed record, quoting it,
        // and an incident command the recall hook leaves runs
        // through the store's solve / refile / supersede and is
        // confirmed when the store acts — a filed, answered or
        // commanded send is the Librarian's, so the
        // empty-desk answer does not also fire under it (a
        // command the store declines posts nothing itself, but
        // the send was still the Librarian's road, not an ask
        // for the desk). A Librarian-addressed send that is
        // none of the three is left exactly as it was:
        // ordinary dispatch, and the empty-desk answer on an
        // empty desk.
        const role = roleAddresseeIn(message.body);
        let kbAnswer = null;
        let factAnswer = null;
        let recallAnswer = null;
        let incidentAnswer = null;
        if (role === 'librarian') {
          try {
            factAnswer = await postLibrarianFactIfNeeded({ pool, tenantId: context.tenantId, channelId: message.channelId, messageId: out.receipt.message.id, senderSubject: message.authorSubject, senderName: out.receipt.message.authorName ?? null, senderRole: actor.role, body: message.body });
          } catch (error) {
            console.error('[envoy-chat] librarian fact filing failed:', error.message);
          }
          if (!factAnswer?.filed) {
            try {
              recallAnswer = await postLibrarianRecallIfNeeded({ pool, tenantId: context.tenantId, channelId: message.channelId, messageId: out.receipt.message.id, senderSubject: message.authorSubject, senderRole: actor.role, body: message.body });
            } catch (error) {
              console.error('[envoy-chat] librarian recall failed:', error.message);
            }
          }
          if (!factAnswer?.filed && !recallAnswer?.answered) {
            try {
              incidentAnswer = await postLibrarianIncidentCommandIfNeeded({ pool, tenantId: context.tenantId, channelId: message.channelId, messageId: out.receipt.message.id, senderSubject: message.authorSubject, senderRole: actor.role, body: message.body });
            } catch (error) {
              console.error('[envoy-chat] librarian incident command failed:', error.message);
            }
          }
        }
        if (!role) {
          try {
            kbAnswer = await postHelmKbAnswerIfNeeded({ pool, tenantId: context.tenantId, channelId: message.channelId, messageId: out.receipt.message.id, senderSubject: message.authorSubject, body: message.body });
          } catch (error) {
            console.error('[envoy-chat] helm kb answer failed:', error.message);
          }
        }
        if (!assignment?.assigned && !kbAnswer?.answered && !factAnswer?.filed && !recallAnswer?.answered && !incidentAnswer?.handled) {
          try {
            await postEmptyDeskAnswerIfNeeded({ pool, tenantId: context.tenantId, channelId: message.channelId, messageId: out.receipt.message.id });
          } catch (error) {
            console.error('[envoy-chat] empty-desk answer failed:', error.message);
          }
        }
      }
      return out;
    },
    async appendConnectorMessage(binding) {
      const actor = { tenantId: binding.tenantId, subject: binding.subject, role: binding.role, sessionId: binding.sessionId, requestId: binding.requestId };
      const message = normalizeEnvoyMessage({ channelId: binding.channelId, authorSubject: binding.subject, authorKind: 'human', body: binding.text });
      const context = contextFor(actor); const idempotencyKey = text(`${binding.provider}:${binding.eventId}`, 'connector idempotency key', 300);
      return withTenantTransaction(pool, context, async (client) => { await requireActiveTenantMembership(client, context); const channel = await client.query('select id from helmion.envoy_channels where tenant_id=$1 and id=$2', [context.tenantId, message.channelId]); if (channel.rowCount !== 1) throw new Error('Envoy channel was not found in this Organization'); const result = await client.query(`insert into helmion.envoy_messages(tenant_id, channel_id, author_subject, author_kind, body, idempotency_key) values ($1,$2,$3,$4,$5,$6) on conflict (tenant_id, channel_id, author_subject, idempotency_key) do nothing returning id, channel_id, author_subject, author_kind, body, idempotency_key, created_at`, [context.tenantId, message.channelId, message.authorSubject, message.authorKind, message.body, idempotencyKey]); const row = result.rowCount === 1 ? result.rows[0] : (await client.query(`select id, channel_id, author_subject, author_kind, body, idempotency_key, created_at from helmion.envoy_messages where tenant_id=$1 and channel_id=$2 and author_subject=$3 and idempotency_key=$4`, [context.tenantId, message.channelId, message.authorSubject, idempotencyKey])).rows[0]; if (!row) throw new Error('Envoy connector message receipt was not durable'); return { durable: true, replayed: result.rowCount !== 1, message: rowMessage(row) }; });
    },
  });
}
import { withTenantTransaction, requireActiveTenantMembership } from '../core/tenant-context.mjs';
import { appendAuditEvent } from './audit-event-repository.mjs';
import { tenantAgentStateOn } from './tenant-agent-state.mjs';
import { CONFIG_SUBJECT, describeAuthor, normalizeMessageMetadata, parseConfig, roleAddresseeIn } from './envoy-agents.mjs';
import { createLibrarianStore } from './envoy-librarian.mjs';
import { discordBotStatus, slackBotStatus } from './bot-status.mjs';
import { postHelmKbAnswerIfNeeded } from './helm-kb.mjs';
import { postMaestroAssignmentIfNeeded } from './envoy-assignments.mjs';

// The channels list carries each channel's Discord / Slack link (from
// its newest config row, the same rows the bridges read) plus the bot
// status, so a client knows the true link state of every channel from
// this one read — not only the channel it happens to have open. Pure:
// the store hands it the parsed configs by channel id.
export function attachChannelLinks(channels, configsByChannelId = new Map()) {
  return channels.map((channel) => {
    const config = configsByChannelId.get(String(channel.id)) ?? null;
    return Object.freeze({ ...channel, discord: config?.discord ?? null, slack: config?.slack ?? null, github: config?.github ?? null, avatar: config?.avatar ?? null });
  });
}
