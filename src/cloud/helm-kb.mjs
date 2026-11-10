// Helm's setup knowledge base (Troy's order, 2026-11-09 23:14):
// a new user presses the voice button, asks "what do I do now",
// and is walked through setup out loud, one step at a time. The
// design is KB-SPEC.md in the helm-knowledge build folder; the
// content is helm-kb.json beside this module — product-owned data
// in the librarian's Rule entry shape, shipped with the build the
// way every src/cloud file ships.
//
// What this module is, in one paragraph: the matcher and the
// mouth. A human message in the workspace is matched against the
// guide's entries with the librarian's own matcher (whole word or
// phrase, case-insensitive, plural-tolerant — envoy-librarian's
// evaluateKbRule, no second engine). On a hit, Maestro answers in
// the channel himself with the entry's step, WORD FOR WORD: setup
// instructions are product truth, and a model paraphrasing a
// button name teaches the user to hunt for a button that does not
// exist. That is also what makes the availability law real: the
// guide answers with ZERO seats connected, is never routed to a
// customer seat, and needs no model call, no pool, no spoke. The
// human message the guide answered is marked in its metadata
// (helmKb), and the mesh skips a marked message the way it skips
// a Guard refusal record — it is never a work source.
//
// The seam with polish P1's empty-desk answer (envoy-chat.mjs) is
// drawn here and in the appendMessage wiring: the guide is tried
// FIRST. A setup question on an empty desk gets the guide's step,
// not the generic empty-desk line; a message the guide does not
// answer falls through to P1 unchanged. Chains: an entry can point
// at the next entry (answer.next); the pending step is read back
// from the channel itself — the guide's last answer to this person
// carries its next in its metadata — and it advances only on the
// person's word (done / okay / next / ready …), one step per
// reply. A new question replaces the chain, because the matcher
// runs before the advance is considered.
//
// A miss — a question-shaped message the guide cannot answer, on
// a desk with nobody connected to answer it either — is filed to
// the guide's unsorted queue (sql/084, helmion.helm_kb_misses):
// the question's words only, counted on repeats. Real unanswered
// questions are how the guide grows; a person files new entries
// from that queue. Filing is fail-soft until the migration lands:
// the queue's absence never touches the send. On a connected desk
// a miss is ordinary work for the crew and is NOT filed — the
// seat answers it, so it was never unanswered.
//
// Voice: a guide answer is an ordinary stored Maestro message
// (subject agent:maestro, the same subject P1's answer uses), so
// the workspace's existing Voice chat mode speaks it through the
// shared voice controller exactly the way it speaks any reply —
// Kokoro in the customer's tab, in Maestro's own voice, the
// controller's backup engine behind it, and the text in the
// channel always. The speaker mark lights on it while it plays,
// like any spoken message. No new voice machinery lives here.

import { readFileSync } from 'node:fs';
import { evaluateKbRule } from './envoy-librarian.mjs';
import { tenantAgentStateOn } from './tenant-agent-state.mjs';
import { CONFIG_SUBJECT } from './envoy-agents.mjs';

export const HELM_KB_SUBJECT = 'agent:maestro';
export const HELM_KB_KEY_PREFIX = 'helm-kb:';

// Polish P1's empty-desk answer key prefix (envoy-chat.mjs). The
// chain reader below treats those answers as transparent: they
// are Maestro's other mouth saying the desk is empty, and a
// pending guide step stays pending across one — otherwise the
// generic line landing mid-chain would silently end the walk.
// Named here rather than imported: envoy-chat imports this
// module, so the constant cannot ride the other way.
const EMPTY_DESK_KEY_PREFIX = 'maestro-empty-desk:';

// ---------- the data ----------

let cachedEntries = null;

/**
 * The shipped guide: helm-kb.json beside this module, parsed once.
 * Only grounded entries ship in that file (the V1 coverage rules);
 * a read or parse failure yields an empty guide — the matcher then
 * never hits, misses still file, and P1's road is untouched.
 */
export function helmKbEntries() {
  if (cachedEntries) return cachedEntries;
  try {
    const raw = readFileSync(new URL('./helm-kb.json', import.meta.url), 'utf8');
    const parsed = JSON.parse(raw);
    cachedEntries = Array.isArray(parsed?.entries) ? parsed.entries : [];
  } catch { cachedEntries = []; }
  return cachedEntries;
}

export function helmKbEntryById(id, entries = helmKbEntries()) {
  return (entries ?? []).find((entry) => entry?.id === id) ?? null;
}

// ---------- the matcher (the librarian's engine, its ordering) ----------

// Layer ranks break priority ties, the more specific layer winning
// — envoy-librarian's KB_LAYER_RANK, mirrored for the guide's own
// best-pick (its entries today all sit in the content band).
const HELM_KB_LAYER_RANK = { learned: 5, custom: 4, content: 3, shape: 2, source: 1 };

/**
 * The best guide entry for one message's words, or null. Ordering
 * is the librarian engine's: priority, then layer rank, then id.
 * Pure — the entries ride in as a parameter so tests pin the real
 * shipped data and synthetic sets alike.
 */
export function matchHelmKbEntry(text, entries = helmKbEntries()) {
  const ctx = { text: String(text ?? '') };
  let best = null;
  for (const entry of entries ?? []) {
    if (!entry || entry.enabled === false || !entry.answer?.speak) continue;
    if (!evaluateKbRule(entry, ctx)) continue;
    const candidate = { entry, priority: entry.priority ?? 0, rank: HELM_KB_LAYER_RANK[entry.layer] ?? 0, id: entry.id };
    if (!best
      || candidate.priority > best.priority
      || (candidate.priority === best.priority && candidate.rank > best.rank)
      || (candidate.priority === best.priority && candidate.rank === best.rank && candidate.id < best.id)) {
      best = candidate;
    }
  }
  return best?.entry ?? null;
}

/**
 * The words Maestro speaks for one entry: the step, then the
 * hand-back line that asks for the person's word before the next
 * step. Nothing is added, dropped, or reworded at runtime — the
 * entry's text is the answer.
 */
export function helmKbAnswerBody(entry) {
  const speak = String(entry?.answer?.speak ?? '').trim();
  const then = String(entry?.answer?.then ?? '').trim();
  return then ? `${speak} ${then}` : speak;
}

// ---------- chains ----------

// The person's word that a step is done (KB-SPEC: "Done", "okay",
// "next" advance). Matched against the whole message, normalized
// — a sentence that merely contains one of these is a new message,
// not an advance.
const HELM_KB_ADVANCE_PHRASES = new Set([
  'done', 'okay', 'ok', 'next', 'ready', 'yes', 'yep', 'yeah',
  'go on', 'continue', 'got it', 'did it', 'i did it', 'done it',
  'all done', 'finished', "it's done", 'its done', 'next step',
]);

export function isHelmKbAdvance(text) {
  const normalized = String(text ?? '').trim().toLowerCase().replace(/[!.,?]+$/, '').replace(/\s+/g, ' ');
  return HELM_KB_ADVANCE_PHRASES.has(normalized);
}

function metadataOf(row) {
  const raw = row?.metadata;
  if (!raw) return null;
  if (typeof raw === 'object') return raw;
  try { return JSON.parse(String(raw)); } catch { return null; }
}

/**
 * The pending chain step for one person, read from the channel:
 * the newest word in the channel that is not the person's own
 * decides — if it is the guide's answer TO THIS PERSON carrying a
 * next step, that step is pending; anything else (a seat's reply,
 * another person's guide answer, the chain's end) means nothing
 * is pending. P1's empty-desk answers are skipped over: Maestro
 * saying the desk is empty does not end a walk in progress.
 * `rows` are the channel's messages newest-first;
 * `beforeId` is the message being answered. Pure.
 */
export function helmKbPendingNext(rows, { senderSubject, beforeId } = {}) {
  for (const row of rows ?? []) {
    if (beforeId !== undefined && beforeId !== null && Number(row?.id) >= Number(beforeId)) continue;
    if (row?.author_subject === senderSubject) continue;
    if (String(row?.idempotency_key ?? '').startsWith(EMPTY_DESK_KEY_PREFIX)) continue;
    const mark = metadataOf(row)?.helmKb;
    if (row?.author_subject === HELM_KB_SUBJECT
      && String(row?.idempotency_key ?? '').startsWith(HELM_KB_KEY_PREFIX)
      && mark && mark.forSubject === senderSubject && mark.next) {
      return String(mark.next);
    }
    return null;
  }
  return null;
}

// ---------- misses ----------

const HELM_KB_QUESTION_STARTERS = new Set([
  'how', 'what', 'why', 'can', 'could', 'do', 'does', 'did', 'is',
  'are', 'was', 'were', 'where', 'when', 'who', 'which', 'help',
]);

/**
 * Whether a message reads as a question for the guide — it ends
 * with a question mark, or it opens with a question word. Only
 * question-shaped misses are filed: an empty desk's greetings and
 * statements are not unanswered questions, and the queue is for
 * growing the guide, not for logging the channel.
 */
export function isHelmKbQuestion(text) {
  const trimmed = String(text ?? '').trim();
  if (!trimmed) return false;
  if (trimmed.endsWith('?')) return true;
  const first = trimmed.toLowerCase().replace(/^[^a-z]+/, '').split(/\s+/)[0];
  return HELM_KB_QUESTION_STARTERS.has(first);
}

/**
 * File one unanswered question to the guide's unsorted queue
 * (sql/084). Repeats of the same question from the same person
 * count up on one row. Fail-soft by design: any failure — the
 * migration not yet applied, a database error — returns false and
 * changes nothing. The queue is Helmian's own: the question's
 * words, who asked, and where; no workspace content rides along.
 */
export async function fileHelmKbMiss({ pool, tenantId, channelId, senderSubject, question } = {}) {
  const words = String(question ?? '').trim();
  if (!words || !pool) return false;
  const questionKey = words.toLowerCase().replace(/\s+/g, ' ').slice(0, 300);
  let client;
  try {
    client = await pool.connect();
    await client.query('begin');
    await client.query(`select set_config('helmion.tenant_id', $1, true)`, [String(tenantId)]);
    await client.query(
      `insert into helmion.helm_kb_misses(tenant_id, channel_id, person_subject, question, question_key)
       values ($1,$2,$3,$4,$5)
       on conflict (tenant_id, person_subject, question_key)
       do update set seen_count = helmion.helm_kb_misses.seen_count + 1,
                     last_seen_at = now(),
                     channel_id = excluded.channel_id`,
      [String(tenantId), String(channelId), String(senderSubject), words.slice(0, 2000), questionKey],
    );
    await client.query('commit');
    return true;
  } catch {
    try { await client?.query('rollback'); } catch {}
    return false;
  } finally { client?.release(); }
}

// ---------- the answer, on the message path ----------

/**
 * Answer one durable human message from the guide, if the guide
 * has an answer for it. Runs in its own tenant transaction after
 * the send is durable (the maestro-activation / empty-desk
 * pattern): a failure is the caller's to log and never fails the
 * send. The order inside is the seam, stated once:
 *   1. the matcher — a question the guide knows is answered with
 *      its entry, on any desk, zero seats or a full crew;
 *   2. the chain — no match, a pending step, and the person's
 *      word that the last step is done: the next step is spoken;
 *   3. the miss — no answer and a question-shaped message: on an
 *      empty desk (the state module's connected providers) the
 *      question is filed to the unsorted queue, and the send
 *      falls through to the empty-desk answer, which is not this
 *      helper's to post.
 * An answer posts as agent:maestro with the entry's words, marks
 * the human message's metadata helmKb (the mesh's skip — the ask
 * is never handed to a seat), and carries the chain state in its
 * own metadata. Returns { answered, entryId?, filed? }.
 */
export async function postHelmKbAnswerIfNeeded({ pool, tenantId, channelId, messageId, senderSubject, body, entries = null, stateOn = tenantAgentStateOn } = {}) {
  const guide = entries ?? helmKbEntries();
  const client = await pool.connect();
  let outcome = { answered: false };
  let missQuestion = null;
  try {
    await client.query('begin');
    await client.query(`select set_config('helmion.tenant_id', $1, true)`, [String(tenantId)]);
    const recent = await client.query(
      `select id, author_subject, author_kind, idempotency_key, metadata from helmion.envoy_messages
        where tenant_id=$1 and channel_id=$2 and author_subject <> $3
        order by id desc limit 12`,
      [String(tenantId), String(channelId), CONFIG_SUBJECT],
    );
    let entry = matchHelmKbEntry(body, guide);
    if (!entry) {
      const pendingNext = helmKbPendingNext(recent.rows, { senderSubject, beforeId: messageId });
      if (pendingNext && isHelmKbAdvance(body)) entry = helmKbEntryById(pendingNext, guide);
    }
    if (entry) {
      const inserted = await client.query(
        `insert into helmion.envoy_messages(tenant_id, channel_id, author_subject, author_kind, body, idempotency_key, metadata)
         values ($1,$2,$3,'agent',$4,$5,$6)
         on conflict (tenant_id, channel_id, author_subject, idempotency_key) do nothing
         returning id`,
        [String(tenantId), String(channelId), HELM_KB_SUBJECT, helmKbAnswerBody(entry), `${HELM_KB_KEY_PREFIX}${messageId}`,
          JSON.stringify({ helmKb: { entry: entry.id, next: entry.answer?.next ?? null, forSubject: String(senderSubject) } })],
      );
      if (inserted.rowCount === 1) {
        await client.query(
          `update helmion.envoy_messages
              set metadata = coalesce(metadata, '{}'::jsonb) || $5::jsonb
            where tenant_id=$1 and channel_id=$2 and id=$3 and author_subject=$4`,
          [String(tenantId), String(channelId), messageId, String(senderSubject),
            JSON.stringify({ helmKb: { entry: entry.id, answeredBy: 'maestro' } })],
        );
        outcome = { answered: true, entryId: entry.id, messageId: String(inserted.rows[0].id) };
      }
    } else if (isHelmKbQuestion(body)) {
      const state = await stateOn(client, tenantId);
      if (Array.isArray(state?.connectedProviders) && state.connectedProviders.length === 0) {
        missQuestion = String(body ?? '');
      }
    }
    await client.query('commit');
  } catch (error) {
    try { await client.query('rollback'); } catch {}
    throw error;
  } finally { client.release(); }
  if (missQuestion !== null) {
    const filed = await fileHelmKbMiss({ pool, tenantId, channelId, senderSubject, question: missQuestion });
    return { ...outcome, filed };
  }
  return outcome;
}
