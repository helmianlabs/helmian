// The durable ledger — the thing that turns a warning into a record.
//
// WHY IT IS TESTED THIS HARD. Every other part of this extension fails loudly:
// if the scanner breaks, a banner appears. A ledger fails SILENTLY — it simply
// has fewer rows than it should, and nobody finds out until the day they need
// the record and it is not there. So the caps, the eviction counting, the
// clipping and the export are all pinned.
//
// Storage is injected, so all of this runs in Node with no browser and no
// chrome.* at all.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  KIND_DESTRUCTIVE,
  KIND_UNSOURCED,
  LEDGER_KEY,
  MAX_ENTRIES,
  MAX_EXCERPT,
  appendEntry,
  applyCaps,
  clearLedger,
  exportBundle,
  ledgerStats,
  makeEntry,
  memoryStorage,
  readLedger,
} from '../background/ledger.js';

const AT = new Date('2026-07-30T09:15:00.000Z');

test('a row carries what Troy asked for by name: when, what was asked, what was said', async () => {
  const entry = makeEntry({
    kind: KIND_DESTRUCTIVE,
    site: 'claude.ai',
    query: 'how do I clear the build output',
    conversation: 'cd /var/www\nrm -rf html/*',
    matched: 'recursive/forced rm',
    text: 'rm -rf html/*',
    lineNumber: 2,
    now: AT,
  });

  assert.equal(entry.timestamp, '2026-07-30T09:15:00.000Z');
  assert.equal(entry.site, 'claude.ai');
  assert.equal(entry.query, 'how do I clear the build output');
  assert.match(entry.conversation, /rm -rf html/);
  assert.equal(entry.matched, 'recursive/forced rm');
  assert.equal(entry.lineNumber, 2);
  assert.equal(entry.outcome, 'blocked');
  assert.equal(entry.layer, 'browser');
  assert.ok(entry.id.length > 0, 'every row is individually addressable');
});

test('a row SAYS when the conversation could not be captured', async () => {
  // The anchors that find the user's message are site-specific and will break.
  // A blank query field would read as "nothing was asked", which is a different
  // claim from "we could not tell".
  const captured = makeEntry({ kind: KIND_UNSOURCED, query: 'what is it called', now: AT });
  const blind = makeEntry({ kind: KIND_UNSOURCED, query: '', conversation: '', now: AT });
  assert.equal(captured.contextCaptured, true);
  assert.equal(blind.contextCaptured, false);
});

test('the two kinds stay apart, so an advisory note is never read as a block', () => {
  assert.equal(makeEntry({ kind: KIND_UNSOURCED }).kind, KIND_UNSOURCED);
  assert.equal(makeEntry({ kind: KIND_UNSOURCED }).outcome, 'flagged');
  assert.equal(makeEntry({ kind: KIND_DESTRUCTIVE }).outcome, 'blocked');
  // Anything unrecognised is treated as the more serious of the two rather than
  // being invented — a row with an unknown kind must not soften itself.
  assert.equal(makeEntry({ kind: 'something-new' }).kind, KIND_DESTRUCTIVE);
});

test('long text is clipped, not stored whole', () => {
  const huge = 'x'.repeat(MAX_EXCERPT * 3);
  const entry = makeEntry({ query: huge, conversation: huge, text: huge });
  assert.equal(entry.query.length, MAX_EXCERPT);
  assert.equal(entry.conversation.length, MAX_EXCERPT);
  assert.equal(entry.text.length, MAX_EXCERPT);
  assert.ok(entry.query.endsWith('…'), 'a clipped field says it was clipped');
});

test('IT SURVIVES THE WORKER DYING — a second read sees the first write', async () => {
  // The whole reason this file exists. Chrome evicts an idle service worker
  // after about 30 seconds; the old in-memory queue died with it.
  const storage = memoryStorage();
  await appendEntry(storage, makeEntry({ site: 'chatgpt.com', text: 'rm -rf /', now: AT }));

  // A brand-new module scope reading the same storage — i.e. the worker restarted.
  const afterRestart = await readLedger(storage);
  assert.equal(afterRestart.length, 1);
  assert.equal(afterRestart[0].text, 'rm -rf /');
  assert.ok(Object.prototype.hasOwnProperty.call(storage._bag, LEDGER_KEY),
    'the ledger is persisted under its own key');
});

test('rows accumulate in order', async () => {
  const storage = memoryStorage();
  for (let i = 0; i < 5; i += 1) {
    await appendEntry(storage, makeEntry({ text: `entry ${i}`, now: AT }));
  }
  const entries = await readLedger(storage);
  assert.deepEqual(entries.map((e) => e.text), ['entry 0', 'entry 1', 'entry 2', 'entry 3', 'entry 4']);
});

test('THE CAP EVICTS OLDEST FIRST AND COUNTS WHAT IT DROPPED', () => {
  // A ledger that loses rows without saying so is not evidence.
  const many = Array.from({ length: MAX_ENTRIES + 25 }, (_, i) => makeEntry({ text: `e${i}` }));
  const { kept, dropped } = applyCaps(many);
  assert.equal(kept.length, MAX_ENTRIES);
  assert.equal(dropped, 25);
  assert.equal(kept[0].text, 'e25', 'the OLDEST rows go, not the newest');
  assert.equal(kept[kept.length - 1].text, `e${MAX_ENTRIES + 24}`);
});

test('a byte cap bites even when the row count is legal', () => {
  // Measured, not guessed: a maximally-clipped row serialises to ~4.2 KB, so it
  // takes about 992 of them to pass 4 MB — well under the 2,000-row cap. That is
  // the case this proves: the count is legal and the bytes are not.
  //
  // An earlier version of this test used 50 rows and passed vacuously by never
  // reaching the limit at all.
  const fat = Array.from({ length: 1200 }, (_, i) =>
    makeEntry({ text: 'y'.repeat(MAX_EXCERPT), conversation: 'z'.repeat(MAX_EXCERPT), query: `q${i}` }));
  assert.ok(fat.length < MAX_ENTRIES, 'precondition: the row COUNT is within the cap');
  assert.ok(JSON.stringify(fat).length > 4 * 1024 * 1024, 'precondition: the BYTES are not');

  const { kept, dropped } = applyCaps(fat);
  assert.ok(kept.length < 1200, 'the byte cap trimmed the list');
  assert.ok(dropped > 0, 'and said how many it dropped');
  assert.ok(JSON.stringify(kept).length <= 4 * 1024 * 1024, 'the result fits');
  assert.equal(kept[kept.length - 1].query, 'q1199', 'the NEWEST row survives');
});

test('stats separate the two kinds and name the sites', async () => {
  const storage = memoryStorage();
  await appendEntry(storage, makeEntry({ kind: KIND_DESTRUCTIVE, site: 'claude.ai', now: AT }));
  await appendEntry(storage, makeEntry({ kind: KIND_DESTRUCTIVE, site: 'grok.com', now: AT }));
  await appendEntry(storage, makeEntry({ kind: KIND_UNSOURCED, site: 'claude.ai', now: AT }));

  const stats = await ledgerStats(storage);
  assert.equal(stats.total, 3);
  assert.equal(stats.destructive, 2);
  assert.equal(stats.unsourced, 1);
  assert.deepEqual(stats.sites.sort(), ['claude.ai', 'grok.com']);
  assert.ok(stats.newest && stats.oldest);
});

test('THE EXPORT WARNS THE USER WHAT IS IN THE FILE', async () => {
  // It holds fragments of their own conversations. Anyone about to send it to a
  // vendor or paste it in a forum should learn that from the file, not after.
  const storage = memoryStorage();
  await appendEntry(storage, makeEntry({ query: 'a private question', text: 'rm -rf /', now: AT }));

  const bundle = await exportBundle(storage, { now: AT });
  assert.equal(bundle.tool, 'Helmion Guard');
  assert.equal(bundle.exportedAt, '2026-07-30T09:15:00.000Z');
  assert.match(bundle.disclosure, /excerpts of your own AI conversations/);
  assert.match(bundle.disclosure, /never uploaded/);
  assert.match(bundle.disclosure, /Read it before you share it/);
  assert.equal(bundle.entries.length, 1);
  assert.equal(bundle.stats.total, 1);
});

test('clearing empties it, and the export then says so honestly', async () => {
  const storage = memoryStorage();
  await appendEntry(storage, makeEntry({ text: 'rm -rf /', now: AT }));
  await clearLedger(storage);
  assert.deepEqual(await readLedger(storage), []);
  const stats = await ledgerStats(storage);
  assert.equal(stats.total, 0);
  assert.equal(stats.oldest, null);
});

test('A BROKEN STORAGE DOES NOT TAKE THE GUARD DOWN', async () => {
  // The scanners must keep working even if the ledger cannot be read. Losing
  // the record is bad; losing the warning is worse.
  const broken = {
    async get() { throw new Error('storage quota exceeded'); },
    async set() { throw new Error('storage quota exceeded'); },
    async remove() { throw new Error('nope'); },
  };
  assert.deepEqual(await readLedger(broken), [], 'an unreadable ledger reads as empty, it does not throw');
  await assert.rejects(appendEntry(broken, makeEntry({})), /quota/,
    'a failed WRITE still rejects, so the caller can report it rather than believing it saved');
});

test('garbage in storage is ignored rather than crashing the popup', async () => {
  for (const junk of ['not an array', 42, null, { nope: true }]) {
    const storage = memoryStorage({ [LEDGER_KEY]: junk });
    assert.deepEqual(await readLedger(storage), []);
  }
});
