// Helm, the answerer (fix programme bites H3 and H4, DESIGN 3.3):
// the presence law made code, and the grounded composer that
// answers from records. Helm is the answerer of last resort in
// every channel — roster-present by default, never a vendor seat,
// never in a due set (envoy-agents.mjs, bite H1). Whether Helm
// answers a given message is the pure helmDue decision there;
// this module is the answering itself: the post, the mark, the
// composition, and the miss filing for the questions Helm could
// not answer.
//
// The composition (bite H4) is deterministic and model-free —
// decision D3: Helm's non-guide answers are composed from
// records, never from prose. Three shapes of question, decided
// by deterministic keyword shapes and one lookup:
//
//   - A state ask (the ask names state, status, running,
//     blocked, or next — the keyword shape DESIGN 3.3 states)
//     gets a three-line answer, Running / Blocked / Next, in
//     which every claim is a field read: the connected providers
//     and runner presence from tenant-agent-state, the channel's
//     armed connectors ruled by the connector library read, the
//     open blockers in the notebook block, the open incidents in
//     the Librarian's knowledge base, the providers the claim
//     gate withholds, and the channel record's own open work
//     (the oldest unsettled assignment part, the pending guide
//     chain). Tonight's message 2 is the model case: eight seats
//     contradicted each other on Weather because each claimed
//     from its own impression; a Helm answer takes Weather's
//     state from the one connector read, so it cannot say "off",
//     "active", and "not connected" at once.
//   - A fact question gets a lookup over the tenant's filed
//     entries (facts first, then ask records — the notebook's
//     context_entries, the Librarian's L2 ordering) and the
//     answer quotes the matching entry verbatim, bounded at the
//     entry's own text. No match on a question that names the
//     record (filed, recorded, notebook, recall, remember) gets
//     the honest line "I have nothing filed about that", and
//     the question files to the miss queue.
//   - A general question that is neither is not answered from
//     prose (D3): the fact road returns the honest availability
//     line, and since bite H5 the mesh tries the search road
//     (helmSearchAnswer, below) before that line posts — rent a
//     search, read the top pages, answer from the retrieved
//     text with citations naming the pages read, and file the
//     answer through the Librarian. Only when no search
//     provider is configured, or the search cannot serve, does
//     the availability line post and the question file to the
//     miss queue — helm-kb.mjs's fileHelmKbMiss, the one queue
//     DESIGN 3.5 names for guide misses and unanswered
//     questions alike — where a person grows the guide and the
//     records from real unanswered questions.
//
// The posting is a stored agent message under agent:helm (the
// subject bite H1 made real and H2 gave the guide's mouth), so
// it renders as Helm, persists like any reply, is spoken in
// Helm's voice bm_george by the existing voice controller, and
// is filtered out of every routing result by the same role
// exclusions that guard Maestro's lines — it opens no debate
// turn and earns nobody work. Its idempotency key is
// helm:<messageId>: one Helm answer per message, however many
// polls see it.
//
// The mark: a message Helm answered alone (@Helm named) is
// marked metadata.helmOnly on the human message, in the same
// transaction as the answer post, so the two land together or
// not at all. The mesh reads the mark the way it reads the
// guide's and the Librarian's: a marked message is never handed
// to a vendor seat. The 'team' and 'last-resort' answers carry
// no mark — the seats were due, or nobody was; nothing about
// the message's routing needs recording beyond Helm's answer
// itself, which is what later polls read to stay silent.

import { AGENT_NAMES } from './envoy-agents.mjs';
import { fileHelmKbMiss, helmKbEntryById, helmKbPendingNext } from './helm-kb.mjs';
import { composeHelmSearchAnswer, HELM_SEARCH_MAX_READS } from './helm-search.mjs';
import { kbCandidateTriggers, kbFindWords } from './envoy-librarian.mjs';
import { createConnectorLibraryStore } from './connector-library.mjs';
import { joinedState } from './connector-library-read.mjs';
import { createToolConnectionsStore } from './tool-connections.mjs';
import { customGateKey } from './connector-custom-gate.mjs';

export const HELM_SUBJECT = 'agent:helm';
export const HELM_KEY_PREFIX = 'helm:';

// The honest availability line (DESIGN 3.3, verbatim): the
// answer for a general question Helm cannot answer from
// records and the search road (bite H5) cannot serve either —
// no provider configured, an outage, an empty result — it
// says Helm does not have it and that no seat is available to
// answer, and the question files to the miss queue (D3).
export const HELM_AVAILABILITY_LINE = 'No seat is connected to answer that here';

// The honest line for a fact question with nothing filed
// (DESIGN 3.3, verbatim): the lookup ran, the record holds no
// match, and Helm says so instead of improvising one.
export const HELM_NOTHING_FILED_LINE = 'I have nothing filed about that';

/**
 * The insert spec for one Helm answer, in the shape the mesh's
 * write transaction already posts refusal rows in: the composed
 * body as agent:helm, keyed helm:<messageId>, with the due case
 * and the asker riding in its metadata. The body defaults to
 * the availability line (the general question's answer); the
 * composer (helmFactAnswer, composeHelmStateAnswer) supplies
 * the grounded bodies. The mesh publishes the row only when
 * the insert actually wrote it, so a replayed answer is never
 * announced twice.
 */
export function helmAnswerSpec({ tenantId, channelId, message, due, body = HELM_AVAILABILITY_LINE } = {}) {
  return {
    tenantId,
    channelId: String(channelId),
    subject: HELM_SUBJECT,
    kind: 'agent',
    body,
    key: `${HELM_KEY_PREFIX}${message.id}`,
    metadata: { helm: { due, forSubject: String(message.authorSubject) } },
  };
}

/**
 * Mark one human message helmOnly, on the mesh write
 * transaction's client: the guide's mark update, one namespace
 * over (coalesce-merge, so the mark lands beside whatever
 * metadata the message already carries and never overwrites it).
 */
export async function markHelmOnlyMessage(client, { tenantId, channelId, messageId, senderSubject } = {}) {
  await client.query(
    `update helmion.envoy_messages
        set metadata = coalesce(metadata, '{}'::jsonb) || $5::jsonb
      where tenant_id=$1 and channel_id=$2 and id=$3 and author_subject=$4`,
    [String(tenantId), String(channelId), messageId, String(senderSubject),
      JSON.stringify({ helmOnly: { answeredBy: 'helm' } })],
  );
}

/**
 * File one question Helm could not answer from records to the
 * miss queue. The filer is helm-kb.mjs's own: fail-soft by
 * design (the queue's absence never touches anything) and
 * counting repeats on one row. This wrapper adds the tail's
 * discipline on top: it never throws, so a surprise failure is
 * logged loudly by the caller-visible log and changes nothing
 * about the answer that was posted. Returns true when the
 * question was filed.
 */
export async function fileHelmUnansweredQuestion({ pool, tenantId, channelId, senderSubject, question, log = null } = {}) {
  try {
    return await fileHelmKbMiss({ pool, tenantId, channelId, senderSubject, question });
  } catch (error) {
    (log ?? ((...args) => console.error(...args)))(`[envoy-helm] miss filing FAILED for tenant ${tenantId}: ${error?.message ?? error} — the answer stands; the question was not filed.`);
    return false;
  }
}

// ------------------------------------------------------------ shapes

// The state ask's deterministic keyword shape (DESIGN 3.3,
// stated there): the ask names state, status, running,
// blocked, or next. Whole words only, so "statement" is not a
// state ask and "next" inside another word is not a state cue.
const HELM_STATE_ASK_PATTERN = /\b(?:state|status|running|blocked|next)\b/i;

export function isHelmStateAsk(body) {
  return HELM_STATE_ASK_PATTERN.test(String(body ?? ''));
}

// The fact question's shape, for the no-match line only: the
// question names the record itself — something filed,
// recorded, in the notebook, on file, in shared memory, to
// recall or remember. A question carrying none of these words
// and matching nothing is a general question (D3), however
// factual it sounds: without the record naming itself, Helm
// cannot tell an unfilled fact from a world question, and the
// honest line differs between the two.
const HELM_FACT_ASK_PATTERN = /\b(?:filed|recorded|notebook|recall|remember|remembered)\b|\bon file\b|\bshared memory\b/i;

export function isHelmFactShaped(body) {
  return HELM_FACT_ASK_PATTERN.test(String(body ?? ''));
}

// The words that shape a question are not its topic: "what do
// you have filed about the approvals pop-up" is ABOUT the
// approvals pop-up, and the lookup scores the filed entries on
// the topic words alone (the Librarian's candidate triggers,
// minus the shape vocabulary above and the state words).
const HELM_SHAPE_WORDS = new Set([
  'state', 'status', 'running', 'blocked', 'next',
  'filed', 'recorded', 'notebook', 'recall', 'remember', 'remembered',
]);

export function helmTopicWords(question) {
  return kbCandidateTriggers(question).filter((word) => !HELM_SHAPE_WORDS.has(word));
}

// ------------------------------------------------------------ the fact lookup

const HELM_ASK_KEY_PREFIX = 'chat:';

// One filed entry's answerable text, or null when the entry
// carries no prose to quote. A fact entry (the Librarian's
// fileFact shape, key fact:<messageId>) quotes its fact field;
// an ask record (key chat:<channelId>:<messageId>) quotes its
// ask field; a plain-string entry (the notebook's other
// writers store strings) quotes itself, classed by its key.
// The quote is the stored text exactly — never trimmed,
// never reworded: verbatim is the whole point (DESIGN 4.3's
// dropped "15" is the failure this road exists to prevent).
function filedEntryText(entry) {
  const key = String(entry?.key ?? '');
  let value = entry?.value ?? null;
  if (typeof value === 'string' && value.trim().startsWith('{')) {
    try { value = JSON.parse(value); } catch { /* a string that is not JSON stays a string */ }
  }
  if (value && typeof value === 'object') {
    if (typeof value.fact === 'string' && value.fact.trim()) return { kind: 'fact', text: value.fact };
    if (typeof value.ask === 'string' && value.ask.trim()) return { kind: 'ask', text: value.ask };
    return null;
  }
  if (typeof value === 'string' && value.trim()) {
    return { kind: key.startsWith(HELM_ASK_KEY_PREFIX) ? 'ask' : 'fact', text: value };
  }
  return null;
}

/**
 * The fact lookup (DESIGN 3.3): over the tenant's filed
 * entries, facts first, then ask records. An entry matches
 * when at least one of the question's topic words appears in
 * its text (the Librarian's word matcher, word-bounded); the
 * best match is the most topic words matched, ties going to
 * the earliest entry in the read's order — the notebook read
 * orders newest first, so a tie quotes the newest filing, the
 * L1/L2 rule. Any fact match outranks every ask match: the
 * classes are searched in the design's order, not by score
 * across classes. Pure: the entries ride in as rows shaped
 * { key, value } (envoy-notebook.mjs's readNotebookEntries).
 * Returns { kind, text } or null.
 */
export function findFiledEntry(entries, question) {
  const words = helmTopicWords(question);
  if (!words.length) return null;
  let bestFact = null;
  let bestAsk = null;
  for (const entry of entries ?? []) {
    const shaped = filedEntryText(entry);
    if (!shaped) continue;
    const score = kbFindWords(shaped.text, words).length;
    if (!score) continue;
    if (shaped.kind === 'fact') {
      if (!bestFact || score > bestFact.score) bestFact = { ...shaped, score };
    } else if (!bestAsk || score > bestAsk.score) {
      bestAsk = { ...shaped, score };
    }
  }
  const hit = bestFact ?? bestAsk;
  return hit ? { kind: hit.kind, text: hit.text } : null;
}

/**
 * Helm's answer to a question that is not a state ask, given
 * the tenant's filed entries: a lookup hit quotes the entry
 * verbatim and files nothing (the question was answered); a
 * miss on a record-naming question gets the nothing-filed
 * line and files to the miss queue; anything else — a general
 * question, or a lookup that never ran because the entries
 * read failed (entries null) — gets the availability line and
 * files to the miss queue, H3's behaviour for exactly the
 * cases H4 cannot ground. Pure over the entries. The mesh
 * layers bite H5's search road over exactly one of these
 * outcomes — a general question whose lookup ran and missed
 * (entries an array, the availability line returned) — and
 * posts the searched answer instead when the road serves;
 * every other outcome is posted as returned here.
 */
export function helmFactAnswer(entries, question) {
  if (Array.isArray(entries)) {
    const hit = findFiledEntry(entries, question);
    if (hit) return { body: hit.text, fileMiss: false };
    if (isHelmFactShaped(question)) return { body: HELM_NOTHING_FILED_LINE, fileMiss: true };
  }
  return { body: HELM_AVAILABILITY_LINE, fileMiss: true };
}

// ------------------------------------------------------------ the search road

/**
 * The search road (bite H5, DESIGN 3.3): answer one general
 * question from a live search, through the one provider
 * interface in helm-search.mjs. The flow is the design's two
 * tools in order: search_web rents the search; read_page
 * reads the top results (at most HELM_SEARCH_MAX_READS) — a
 * page whose read fails falls back to the search result's own
 * cleaned text, which both providers return with the result;
 * the answer is then composed from the retrieved text alone
 * (composeHelmSearchAnswer: excerpts of the pages' own words,
 * citations naming every page read). No model composes
 * anything, and no text enters the answer but the retrieved
 * text.
 *
 * Returns { body, sources, provider, mayFileAnswers } — the
 * serving provider's name and its filing posture (helm-search
 * .mjs's terms reading: Tavily answers file through the
 * Librarian under helm:<messageId>; Exa answers are answered
 * from but not filed) — or null when the road cannot serve:
 * no searcher (no key configured), a search that throws or
 * returns nothing usable, reads that yield no text, or an
 * answer that cannot name its sources within its bounds. A
 * null is the caller's cue to post the availability line and
 * file the miss, exactly as before this bite. Never throws.
 */
export async function helmSearchAnswer({ search, question, log = null } = {}) {
  if (!search || typeof search.searchWeb !== 'function') return null;
  const fail = (error) => {
    (log ?? ((...args) => console.error(...args)))(`[envoy-helm] search FAILED for question "${String(question ?? '').slice(0, 120)}": ${error?.message ?? error} — Helm falls back to the availability line; dispatch is unchanged.`);
    return null;
  };
  let found;
  try {
    found = await search.searchWeb(String(question ?? ''));
  } catch (error) {
    return fail(error);
  }
  if (!found || !Array.isArray(found.results) || !found.results.length) return null;
  const pages = [];
  for (const result of found.results) {
    if (pages.length >= HELM_SEARCH_MAX_READS) break;
    let text = '';
    let title = String(result?.title ?? '');
    try {
      const page = typeof found.readPage === 'function' ? await found.readPage(result?.url) : null;
      if (page?.text) {
        text = String(page.text);
        title = String(page.title ?? '') || title;
      }
    } catch {
      // A failed read falls back to the search result's own
      // text below; the read is a deepening, not a gate.
    }
    if (!text) text = String(result?.content ?? '');
    if (text.trim()) pages.push({ title: title || String(result?.url ?? ''), url: String(result?.url ?? ''), text });
  }
  if (!pages.length) return null;
  const composed = composeHelmSearchAnswer({ question, pages });
  if (!composed) return null;
  return {
    body: composed.body,
    sources: composed.sources,
    provider: String(found.provider ?? ''),
    mayFileAnswers: found.mayFileAnswers === true,
  };
}

// ------------------------------------------------------------ the state composer

const HELM_BLOCKERS_NAMED = 3;
const HELM_INCIDENTS_NAMED = 2;

function joinNames(names) {
  if (names.length <= 1) return names.join('');
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

// One answer item: the line's final period is the line's own,
// so an item never carries a trailing one into the join.
function answerItem(text) {
  return String(text ?? '').trim().replace(/\.+$/, '');
}

function connectorBlockedItem({ name, state }) {
  switch (state) {
    case 'not-connected': return `${name} is not connected`;
    case 'needs-reconnect': return `${name} needs reconnecting`;
    case 'disabled-by-owner': return `${name} is turned off`;
    case 'unknown-entry': return `${name} is not in the connector library`;
    default: return `${name} is ${state}`;
  }
}

/**
 * Compose the three-line state answer (DESIGN 3.3) from
 * records — every claim a field the caller read. Pure: the
 * caller (the mesh) gathers the records through the existing
 * modules and hands them in:
 *   runningNames     display names of the tenant's connected
 *                    providers (tenant-agent-state)
 *   runnerPresent    tenant-agent-state's hasRunner
 *   connectors       the channel's armed connectors, each
 *                    { name, state } ruled by the connector
 *                    library read (readHelmConnectorStates)
 *   blockers         the notebook block's blocker texts
 *                    (notebookBlockers over the block)
 *   openIncidents    the tenant's open incidents, newest
 *                    first (the Librarian's lookupIncidents)
 *   withheldNames    display names of the channel roster's
 *                    providers the claim gate withholds
 *   unsettledPart    the channel's oldest unsettled assignment
 *                    part { n, ownerName }, or null
 *                    (oldestUnsettledAssignmentPart)
 *   pendingGuideStep the asker's pending guide chain step
 *                    { label }, or null (helmPendingGuideStep)
 * The Next line's order is decision D8: the oldest unsettled
 * assignment part, then the oldest open incident, then the
 * pending guide chain, then "nothing is queued".
 */
export function composeHelmStateAnswer({
  runningNames = [],
  runnerPresent = false,
  connectors = [],
  blockers = [],
  openIncidents = [],
  withheldNames = [],
  unsettledPart = null,
  pendingGuideStep = null,
} = {}) {
  const running = [];
  if (runningNames.length) running.push(`${joinNames(runningNames)} answering`);
  else running.push('no seat is connected');
  if (runningNames.length && !runnerPresent) running.push('no runner is connected');
  for (const connector of connectors ?? []) {
    if (connector?.state === 'connected') running.push(`${connector.name} is connected`);
  }

  const blocked = [];
  for (const blocker of (blockers ?? []).slice(0, HELM_BLOCKERS_NAMED)) blocked.push(answerItem(blocker));
  if ((blockers ?? []).length > HELM_BLOCKERS_NAMED) blocked.push(`${blockers.length - HELM_BLOCKERS_NAMED} more blockers in the notebook`);
  for (const incident of (openIncidents ?? []).slice(0, HELM_INCIDENTS_NAMED)) blocked.push(`open incident: ${answerItem(incident?.title)}`);
  if ((openIncidents ?? []).length > HELM_INCIDENTS_NAMED) blocked.push(`${openIncidents.length - HELM_INCIDENTS_NAMED} more open incidents`);
  if (withheldNames.length) blocked.push(`${joinNames(withheldNames)} withheld by the claim gate`);
  for (const connector of connectors ?? []) {
    if (connector && connector.state !== 'connected') blocked.push(connectorBlockedItem(connector));
  }

  let next;
  if (unsettledPart) {
    next = `part ${unsettledPart.n} of an assignment is waiting on ${unsettledPart.ownerName}`;
  } else if ((openIncidents ?? []).length) {
    next = `the oldest open incident is "${answerItem(openIncidents[openIncidents.length - 1]?.title)}"`;
  } else if (pendingGuideStep) {
    next = pendingGuideStep.label
      ? `the setup guide step "${pendingGuideStep.label}" is waiting for your word`
      : 'a setup guide step is waiting for your word';
  } else {
    next = 'nothing is queued';
  }

  return [
    `Running: ${running.map(answerItem).join('; ')}.`,
    blocked.length ? `Blocked: ${blocked.join('; ')}.` : 'Blocked: nothing is blocked.',
    `Next: ${next}.`,
  ].join('\n');
}

/**
 * The blocker texts in a formatted notebook block
 * (envoy-notebook.mjs's formatNotebookBlock shape): the lines
 * under its "Blockers:" heading, without their "- " prefix.
 * Blockers render first in the block, so the section runs from
 * its heading to the next section heading or the block's end.
 * Pure; a null or blocker-free block yields none.
 */
export function notebookBlockers(block) {
  if (typeof block !== 'string' || !block) return [];
  const lines = block.split('\n');
  const start = lines.indexOf('Blockers:');
  if (start < 0) return [];
  const out = [];
  for (let i = start + 1; i < lines.length; i += 1) {
    if (!lines[i].startsWith('- ')) break;
    const text = lines[i].slice(2).trim();
    if (text) out.push(text);
  }
  return out;
}

/**
 * The oldest unsettled assignment part in a channel's window
 * rows: the first owned part, in the oldest marked message's
 * part order, whose owner has no reply in the record. A part
 * is settled by its owner's reply (the reply record is per
 * seat per message — the M3 rule, read here off the same
 * `answered` set the dispatch computation builds:
 * `agent:<provider>|<messageId>`). Unassigned parts have no
 * owner to wait on and are never the answer. Pure over the
 * raw window rows (their metadata read tolerantly, the mesh's
 * own discipline) and the answered set. Returns
 * { n, owner, ownerName } or null.
 */
export function oldestUnsettledAssignmentPart(rows, answered) {
  for (const row of rows ?? []) {
    if (row?.author_kind !== 'human') continue;
    let meta = row?.metadata ?? null;
    if (typeof meta === 'string') { try { meta = JSON.parse(meta); } catch { meta = null; } }
    const parts = meta?.maestroAssignment?.parts;
    if (!Array.isArray(parts) || !parts.length) continue;
    for (const part of parts) {
      const owner = typeof part?.owner === 'string' && part.owner ? part.owner : null;
      if (!owner) continue;
      if (answered?.has(`agent:${owner}|${row.id}`)) continue;
      return { n: Number(part?.n) || 0, owner, ownerName: part?.ownerName || AGENT_NAMES[owner] || owner };
    }
  }
  return null;
}

/**
 * The asker's pending guide chain step, read from the
 * channel's window rows through the guide's own pending
 * reader (helm-kb.mjs): { label } when a step is pending (its
 * entry's label when the entry carries one, else null), or
 * null when nothing is pending. Pure over the raw rows, which
 * the reader wants newest-first.
 */
export function helmPendingGuideStep(rows, { senderSubject, beforeId } = {}) {
  const pendingId = helmKbPendingNext([...(rows ?? [])].reverse(), { senderSubject, beforeId });
  if (!pendingId) return null;
  return { label: helmKbEntryById(pendingId)?.answer?.label ?? null };
}

// ------------------------------------------------------------ the connector read

/**
 * The connection state of a channel's armed connectors for one
 * person, ruled by the connector library read (DESIGN 5.4:
 * Helm reads connector connection state directly from the
 * library read, never from a seat's claim). Each armed pair's
 * entry, connection, and mirror are read through the library
 * store — the store the read surface and the arming resolver
 * both read through — and ruled by the read's own joinedState,
 * with the custom-entry gate consulted exactly where the read
 * consults it (a custom entry whose connection reads
 * connected). The native surfaces (the GitHub repo-link join,
 * the tool-connections probes) are the panel read's own
 * inputs and are not reconstructed here: an entry whose state
 * lives only in one of those reads through its connection row
 * on this road. Returns [{ name, state }] in the pairs' order.
 * Throws on a store failure; the mesh's loader is the
 * fail-soft road in.
 */
export async function readHelmConnectorStates({ pool, tenantId, personId, pairs = [] } = {}) {
  const wanted = (pairs ?? []).filter((pair) => pair?.seatId && pair?.entryId);
  if (!wanted.length || !pool) return [];
  const store = createConnectorLibraryStore(pool);
  const bySeat = new Map();
  for (const pair of wanted) {
    if (!bySeat.has(pair.seatId)) bySeat.set(pair.seatId, []);
    bySeat.get(pair.seatId).push(pair);
  }
  const out = [];
  for (const [seatId, seatPairs] of bySeat) {
    const [connections, mirrors] = await Promise.all([
      store.listConnections(tenantId, { personId, seatId }),
      store.listMirrors(tenantId, { personId, seatId }),
    ]);
    const connectionByEntry = new Map((connections ?? []).map((connection) => [connection?.entryId, connection]));
    const mirrorByEntry = new Map((mirrors ?? []).map((mirror) => [mirror?.entryId, mirror]));
    for (const pair of seatPairs) {
      const entry = await store.getEntry(tenantId, seatId, pair.entryId, { personId });
      if (!entry) {
        out.push({ name: pair.entryId, state: 'unknown-entry' });
        continue;
      }
      const connection = connectionByEntry.get(pair.entryId) ?? null;
      let gateRow;
      if (entry.kind === 'custom' && connection?.state === 'connected') {
        gateRow = await createToolConnectionsStore(pool).get(tenantId, customGateKey(seatId, pair.entryId));
      }
      const joined = joinedState(entry, {
        connection,
        mirror: mirrorByEntry.get(pair.entryId) ?? null,
        nativeSurface: null,
        repoLinks: null,
        gateRow,
      });
      out.push({ name: entry.name ?? pair.entryId, state: joined.state });
    }
  }
  return out;
}
