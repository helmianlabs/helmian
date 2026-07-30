// The durable block ledger. Every flag this extension raises is written here and
// survives the browser closing.
//
// WHY THIS FILE EXISTS NOW AND NOT BEFORE.
//
// background/scan.js has carried this paragraph since it was written:
//
//     A QUEUE IS NOT A DURABLE LOG AND THIS COMMENT WILL NOT PRETEND OTHERWISE.
//     Chrome evicts an idle service worker after about 30 seconds and this array
//     dies with it. Closing that gap needs a decision from Troy — grant one
//     permission, or add a UI that drains this queue — and until he makes it,
//     the browser layer's evidence is in-memory only.
//
// Troy made it, 2026-07-30: *"when any browser AI… flags anything harmful, a
// lie, a gaslight, an omission, anything that that extension is built to filter
// and catch. It needs to log it. Timestamp what the query was, what the
// conversation was, all of it."*
//
// So the extension now declares exactly ONE permission — `storage` — and this
// file is the only thing that uses it. That is the whole price, stated plainly:
// developer.chrome.com/docs/extensions/reference/api/storage — "To use the
// storage API, declare the "storage" permission in the extension manifest."
//
// WHAT IT DOES NOT DO, AND THIS IS DELIBERATE.
//
// It writes to the LOCAL browser profile and nowhere else. There is no network
// call, no telemetry, no upload, and package.test.mjs still fails the build if
// anything in this extension reaches the network. A tool that logs what an AI
// said to you, and then ships that log somewhere, is a worse problem than the
// one it set out to solve. Getting the log OUT is an export the user performs
// deliberately — see `exportBundle`.
//
// STORAGE IS INJECTABLE so the whole ledger can be proven in Node with no
// browser: pass any object with get/set/remove. Production passes
// chrome.storage.local.

/** One storage key holds the whole ledger. Simple, and atomic per write. */
export const LEDGER_KEY = 'helmion.ledger.v1';

/**
 * Hard caps. chrome.storage.local is 10 MB by default and asking for
 * `unlimitedStorage` would be a second permission for a problem we do not have.
 * Two limits, because either one alone lets the other run away: 2,000 entries of
 * ordinary size, or 4 MB, whichever bites first.
 */
export const MAX_ENTRIES = 2000;
export const MAX_BYTES = 4 * 1024 * 1024;

/** How much of a reply we keep. Enough to see the claim in context, not the essay. */
export const MAX_EXCERPT = 2000;

/** The two things this extension catches. Spelled out so a row says which. */
export const KIND_DESTRUCTIVE = 'destructive-command';
export const KIND_UNSOURCED = 'unsourced-claim';

function clip(value, limit) {
  const text = String(value ?? '');
  if (text.length <= limit) return text;
  return `${text.slice(0, limit - 1)}…`;
}

/**
 * A ledger row.
 *
 * `query` and `conversation` are what Troy asked for by name — without them a
 * row says a rule fired and cannot say what was being discussed when it did,
 * which makes the log useless for arguing with a vendor later.
 *
 * They are also the most sensitive fields in the product, so: both are clipped,
 * both stay on this machine, and `redacted` records when the caller chose not to
 * supply them rather than leaving a silent blank.
 */
export function makeEntry({
  kind,
  site,
  query,
  conversation,
  matched,
  text,
  lineNumber = null,
  outcome,
  now = new Date(),
} = {}) {
  const captured = Boolean(query) || Boolean(conversation);
  return {
    id: `${new Date(now).getTime().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`,
    timestamp: new Date(now).toISOString(),
    layer: 'browser',
    kind: kind === KIND_UNSOURCED ? KIND_UNSOURCED : KIND_DESTRUCTIVE,
    site: String(site ?? ''),
    query: clip(query, MAX_EXCERPT),
    conversation: clip(conversation, MAX_EXCERPT),
    contextCaptured: captured,
    matched: String(matched ?? ''),
    text: clip(text, MAX_EXCERPT),
    lineNumber,
    outcome: String(outcome ?? (kind === KIND_UNSOURCED ? 'flagged' : 'blocked')),
  };
}

/** chrome.storage.local, wrapped so tests can pass a plain object instead. */
export function chromeStorage() {
  return {
    async get(key) {
      const bag = await chrome.storage.local.get(key);
      return bag?.[key];
    },
    async set(key, value) {
      await chrome.storage.local.set({ [key]: value });
    },
    async remove(key) {
      await chrome.storage.local.remove(key);
    },
  };
}

/** An in-memory stand-in with the same shape. Used by the tests. */
export function memoryStorage(seed = {}) {
  const bag = { ...seed };
  return {
    async get(key) { return bag[key]; },
    async set(key, value) { bag[key] = value; },
    async remove(key) { delete bag[key]; },
    _bag: bag,
  };
}

async function readRaw(storage) {
  try {
    const held = await storage.get(LEDGER_KEY);
    return Array.isArray(held) ? held : [];
  } catch (error) {
    // A ledger that cannot be read must not take the guard down with it. The
    // caller still gets a working extension; it just cannot show history.
    console.warn('[Helmion Guard] ledger unreadable:', error?.message ?? error);
    return [];
  }
}

/**
 * Trim to the caps, oldest first, and report what was dropped.
 *
 * Dropping is COUNTED, never silent. A ledger that quietly loses rows is not
 * evidence, and the count is what tells a reader their history is incomplete.
 */
export function applyCaps(entries) {
  let kept = entries.slice(-MAX_ENTRIES);
  let dropped = entries.length - kept.length;

  while (kept.length > 1 && JSON.stringify(kept).length > MAX_BYTES) {
    kept = kept.slice(1);
    dropped += 1;
  }

  return { kept, dropped };
}

export async function readLedger(storage) {
  return readRaw(storage);
}

/**
 * Append one row and persist. Returns the row plus how many were evicted to fit.
 *
 * Read-modify-write on one key: two flags fired in the same millisecond from two
 * tabs could in principle race. That is recorded rather than hidden — the cost
 * of losing one duplicate row is far below the cost of a lock in a service
 * worker that Chrome evicts every 30 seconds.
 */
export async function appendEntry(storage, entry) {
  const existing = await readRaw(storage);
  existing.push(entry);
  const { kept, dropped } = applyCaps(existing);
  await storage.set(LEDGER_KEY, kept);
  return { entry, total: kept.length, dropped };
}

export async function clearLedger(storage) {
  await storage.remove(LEDGER_KEY);
  return true;
}

/** Counts for the toolbar and the export header. */
export async function ledgerStats(storage) {
  const entries = await readRaw(storage);
  const destructive = entries.filter((e) => e.kind === KIND_DESTRUCTIVE).length;
  const unsourced = entries.filter((e) => e.kind === KIND_UNSOURCED).length;
  const sites = [...new Set(entries.map((e) => e.site).filter(Boolean))];
  return {
    total: entries.length,
    destructive,
    unsourced,
    sites,
    oldest: entries[0]?.timestamp ?? null,
    newest: entries[entries.length - 1]?.timestamp ?? null,
    bytes: JSON.stringify(entries).length,
    limit: MAX_ENTRIES,
  };
}

/**
 * The whole ledger as a JSON document the user can save.
 *
 * It carries a `disclosure` block on purpose. This file contains fragments of
 * the user's own conversations; anyone about to send it to a vendor, a lawyer or
 * a forum should be told that by the file itself rather than finding out
 * afterwards.
 */
export async function exportBundle(storage, { now = new Date() } = {}) {
  const entries = await readRaw(storage);
  const stats = await ledgerStats(storage);
  return {
    tool: 'Helmion Guard',
    schema: LEDGER_KEY,
    exportedAt: new Date(now).toISOString(),
    disclosure:
      'This file contains excerpts of your own AI conversations — the prompt and part of the '
      + 'reply for every flag raised. It was stored only on this machine and was never uploaded. '
      + 'Read it before you share it.',
    stats,
    entries,
  };
}
