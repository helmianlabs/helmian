// The local write lease: does it actually exclude a second writer?
//
// README.md advertises "a single active write lease per project" and the desktop
// UI calls it a "Lease invariant". Before 2026-07-29 neither statement was
// enforced anywhere — the file-write path contained zero references to a lease.
// These tests are the difference between the sentence and the mechanism.
//
// The one that matters most is THE RACE, near the bottom: it spawns real OS
// processes that all reach for the same lease at once and asserts exactly one
// wins. Asserting "open with wx is atomic" in prose proves nothing; making
// twelve processes fight over it does.

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  DEFAULT_TTL_MS,
  LeaseHeldError,
  LeaseUnreadableError,
  acquireLease,
  inspectLease,
  leasePath,
  readLease,
  releaseLease,
  renewLease,
  verifyLeaseHeld,
} from '../src/core/lease.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');

function workspace() {
  const dir = mkdtempSync(path.join(tmpdir(), 'helmion-lease-'));
  return dir;
}

function writeRawLease(dir, body) {
  const file = leasePath(dir);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, body, 'utf8');
  return file;
}

test('a fresh workspace has no lease, and that is not the same as holding one', () => {
  const dir = workspace();
  try {
    assert.equal(readLease(dir), null);
    const verdict = verifyLeaseHeld(dir, { leaseToken: 'anything' });
    assert.equal(verdict.held, false);
    assert.match(verdict.reason, /no write lease on disk/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('THE INVARIANT: a second writer cannot take a lease that is live', () => {
  const dir = workspace();
  try {
    const first = acquireLease(dir, { projectSlug: 'helmion', instanceId: 'writer-one' });
    assert.ok(first.record.leaseToken);
    assert.equal(first.tookOverFrom, null);

    assert.throws(
      () => acquireLease(dir, { projectSlug: 'helmion', instanceId: 'writer-two' }),
      (err) => err instanceof LeaseHeldError && /another writer holds the lease/.test(err.message),
      'a second acquire against a live lease must be refused',
    );

    // And the first holder still holds it — a refused attempt must not disturb it.
    const verdict = verifyLeaseHeld(dir, { leaseToken: first.record.leaseToken });
    assert.equal(verdict.held, true, 'the refused attempt damaged the incumbent lease');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('holding a lease does not authorize a DIFFERENT session', () => {
  const dir = workspace();
  try {
    acquireLease(dir, { projectSlug: 'helmion', instanceId: 'writer-one' });
    const verdict = verifyLeaseHeld(dir, { leaseToken: 'some-other-token' });
    assert.equal(verdict.held, false);
    assert.match(verdict.reason, /held by .*writer-one/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an EXPIRED lease is takeable, and the takeover is recorded with its reason', () => {
  const dir = workspace();
  try {
    const t0 = Date.now();
    const first = acquireLease(dir, { projectSlug: 'helmion', instanceId: 'writer-one', ttlMs: 1000, now: t0 });

    const later = t0 + 5000;
    const second = acquireLease(dir, { projectSlug: 'helmion', instanceId: 'writer-two', now: later });
    assert.ok(second.tookOverFrom, 'the takeover was not recorded');
    assert.equal(second.tookOverFrom.instanceId, 'writer-one');
    assert.match(second.tookOverFrom.reason, /expired/);

    // The displaced holder is no longer authorized, and is told why.
    const old = verifyLeaseHeld(dir, { leaseToken: first.record.leaseToken, now: later });
    assert.equal(old.held, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('A CRASHED HOLDER DOES NOT PARK THE PROJECT: a dead pid is takeable before expiry', () => {
  const dir = workspace();
  try {
    // A lease that has NOT expired, written by a pid that does not exist. This is
    // the hard-crash case: without pid liveness the project would be locked for
    // the full TTL with nobody holding it.
    const record = {
      version: 1,
      projectSlug: 'helmion',
      leaseToken: 'dead-holder-token',
      coordinatorId: 'claude-code',
      instanceId: 'crashed-writer',
      pid: 999_999_998,
      host: require_hostname(),
      acquiredAt: new Date(Date.now() - 1000).toISOString(),
      renewedAt: new Date(Date.now() - 1000).toISOString(),
      expiresAt: new Date(Date.now() + DEFAULT_TTL_MS).toISOString(),
      ttlMs: DEFAULT_TTL_MS,
      tookOverFrom: null,
    };
    writeRawLease(dir, JSON.stringify(record));

    const state = readLease(dir);
    assert.equal(state.expired, false, 'the fixture must NOT be expired or it proves the other case');
    assert.equal(state.holderAlive, false);
    assert.equal(state.takeable, true);

    const taken = acquireLease(dir, { projectSlug: 'helmion', instanceId: 'writer-two' });
    assert.match(taken.tookOverFrom.reason, /no longer running/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('A LIVE HOLDER IS NOT TAKEABLE just because the lease is young', () => {
  const dir = workspace();
  try {
    // pid = this process, which is definitely alive.
    acquireLease(dir, { projectSlug: 'helmion', instanceId: 'writer-one' });
    const state = readLease(dir);
    assert.equal(state.holderAlive, true);
    assert.equal(state.takeable, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── FAILS CLOSED ─────────────────────────────────────────────────────────────
//
// Each of these is a lease file we cannot understand. Every one must produce
// "not held", never "no lease found, carry on". That distinction is the whole
// difference between a guard and a decoration.

test('FAILS CLOSED: corrupt JSON refuses the write instead of allowing it', () => {
  const dir = workspace();
  try {
    writeRawLease(dir, '{ this is not json');
    const verdict = verifyLeaseHeld(dir, { leaseToken: 'anything' });
    assert.equal(verdict.held, false);
    assert.equal(verdict.failedClosed, true, 'a corrupt lease must fail CLOSED');
    assert.match(verdict.reason, /fails closed/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('FAILS CLOSED: a lease missing a field refuses rather than guessing', () => {
  const dir = workspace();
  try {
    writeRawLease(dir, JSON.stringify({ projectSlug: 'helmion', expiresAt: new Date().toISOString() }));
    const verdict = verifyLeaseHeld(dir, { leaseToken: 'anything' });
    assert.equal(verdict.held, false);
    assert.equal(verdict.failedClosed, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('FAILS CLOSED: an unparseable expiry refuses', () => {
  const dir = workspace();
  try {
    writeRawLease(dir, JSON.stringify({
      leaseToken: 'x', projectSlug: 'helmion', expiresAt: 'the day after tomorrow', pid: 1, host: 'h',
    }));
    const verdict = verifyLeaseHeld(dir, { leaseToken: 'x' });
    assert.equal(verdict.held, false);
    assert.equal(verdict.failedClosed, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a corrupt lease also refuses a TAKEOVER — cannot tell is not permission', () => {
  const dir = workspace();
  try {
    writeRawLease(dir, '{ broken');
    assert.throws(
      () => acquireLease(dir, { projectSlug: 'helmion' }),
      LeaseUnreadableError,
      'a corrupt lease must not be silently overwritten by the next writer',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── RENEW AND RELEASE ────────────────────────────────────────────────────────

test('only the holder can renew, and renewing moves the expiry out', () => {
  const dir = workspace();
  try {
    const t0 = Date.now();
    const held = acquireLease(dir, { projectSlug: 'helmion', ttlMs: 5000, now: t0 });
    const renewed = renewLease(dir, { leaseToken: held.record.leaseToken, now: t0 + 1000 });
    assert.ok(Date.parse(renewed.expiresAt) > Date.parse(held.record.expiresAt));

    assert.throws(
      () => renewLease(dir, { leaseToken: 'not-mine', now: t0 + 1000 }),
      LeaseHeldError,
      'a session that does not hold the lease must not be able to renew it',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('only the holder can release, so nobody frees somebody else\'s project', () => {
  const dir = workspace();
  try {
    const held = acquireLease(dir, { projectSlug: 'helmion' });
    assert.throws(
      () => releaseLease(dir, { leaseToken: 'not-mine' }),
      LeaseHeldError,
    );
    // Still held after the refused release.
    assert.equal(verifyLeaseHeld(dir, { leaseToken: held.record.leaseToken }).held, true);

    const out = releaseLease(dir, { leaseToken: held.record.leaseToken });
    assert.equal(out.released, true);
    assert.equal(readLease(dir), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('after a release the project is free for the next writer', () => {
  const dir = workspace();
  try {
    const first = acquireLease(dir, { projectSlug: 'helmion', instanceId: 'writer-one' });
    releaseLease(dir, { leaseToken: first.record.leaseToken });
    const second = acquireLease(dir, { projectSlug: 'helmion', instanceId: 'writer-two' });
    assert.equal(second.tookOverFrom, null, 'a clean handover is not a takeover');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── THE UI POSTURE ───────────────────────────────────────────────────────────

test('inspectLease reports four DISTINCT states, and unreadable is not none', () => {
  const none = workspace();
  const active = workspace();
  const stale = workspace();
  const broken = workspace();
  try {
    assert.equal(inspectLease(none).status, 'NONE');

    acquireLease(active, { projectSlug: 'helmion' });
    const live = inspectLease(active);
    assert.equal(live.status, 'ACTIVE');
    assert.equal(live.isLive, true);
    assert.match(live.detail, /until /);

    const t0 = Date.now();
    acquireLease(stale, { projectSlug: 'helmion', ttlMs: 10, now: t0 });
    const old = inspectLease(stale, { now: t0 + 60_000 });
    assert.equal(old.status, 'STALE');
    assert.equal(old.isLive, false);

    writeRawLease(broken, 'nope');
    const bad = inspectLease(broken);
    assert.equal(bad.status, 'UNREADABLE', 'a corrupt lease must not be reported as NONE');
    assert.equal(bad.isLive, false);
  } finally {
    for (const dir of [none, active, stale, broken]) rmSync(dir, { recursive: true, force: true });
  }
});

// ── THE RACE ─────────────────────────────────────────────────────────────────

test('THE RACE: twelve real processes reach for one lease and exactly one wins', async () => {
  const dir = workspace();
  const runner = path.join(dir, 'racer.mjs');
  // Cleanup happens AFTER the awaited race, never in a synchronous finally. The
  // first version of this test deleted the temp workspace with setTimeout(0)
  // while the children were still starting, so it removed the runner script and
  // the .helmion directory mid-race and reported "0 of 12 won" — a harness bug
  // wearing the costume of a broken lease.
  try {
    // Each child tries to acquire and prints WON or LOST. They are started as
    // separate OS processes on purpose: this has to test the operating system's
    // exclusive-create guarantee, not Node's single-threaded event loop, which
    // would serialize the attempts and prove nothing.
    // pathToFileURL, not a bare path: `import "E:/..."` throws
    // ERR_UNSUPPORTED_ESM_URL_SCHEME on Windows, every child dies before it can
    // race, and the test reads as "nobody won" — which would have looked like a
    // broken lease instead of a broken harness.
    const moduleUrl = pathToFileURL(path.join(REPO, 'src', 'core', 'lease.mjs')).href;
    writeFileSync(runner, `
import { acquireLease, LeaseHeldError } from ${JSON.stringify(moduleUrl)};
const dir = process.argv[2];
try {
  const out = acquireLease(dir, { projectSlug: 'race', instanceId: 'racer-' + process.pid });
  console.log('WON ' + out.record.leaseToken);
  // HOLD IT. A winner that exits immediately has a dead pid, and a dead pid on
  // this machine makes the lease legitimately takeable — so the next racer
  // would take over and "exactly one wins" would be measuring nothing. Staying
  // alive is what makes the other eleven contend with a LIVE holder, which is
  // the invariant under test.
  await new Promise((r) => setTimeout(r, 2500));
} catch (err) {
  if (err instanceof LeaseHeldError) console.log('LOST');
  else console.log('ERROR ' + err.name + ' ' + err.message);
}
`, 'utf8');

    const RACERS = 12;
    const results = [];
    const children = [];
    for (let i = 0; i < RACERS; i += 1) {
      children.push(new Promise((resolve) => {
        execFile(process.execPath, [runner, dir], { timeout: 30_000 }, (err, stdout, stderr) => {
          const out = String(stdout ?? '').trim();
          // Surface stderr. Swallowing it is what made the first run of this test
          // report "0 of 12 won" with no explanation.
          if (!out) resolve(`ERROR child produced no stdout: ${String(stderr ?? '').trim().split('\n')[0] || 'no stderr either'}`);
          else resolve(out);
        });
      }));
    }

    const lines = await Promise.all(children);
    results.push(...lines);
    const won = results.filter((line) => line.startsWith('WON'));
    const lost = results.filter((line) => line === 'LOST');
    const errored = results.filter((line) => line.startsWith('ERROR'));

    assert.deepEqual(errored, [], `a racer errored instead of winning or losing: ${errored.join(' | ')}`);
    assert.equal(
      won.length,
      1,
      `exactly one writer must win the lease; ${won.length} of ${RACERS} did. This is the invariant.`,
    );
    assert.equal(lost.length, RACERS - 1, 'every other racer must be told it lost');

    // And the winner's token is what is actually on disk.
    const onDisk = JSON.parse(readFileSync(leasePath(dir), 'utf8'));
    assert.equal(`WON ${onDisk.leaseToken}`, won[0], 'the lease on disk is not the winner\'s');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// The crashed-holder fixture must claim THIS machine, because pid liveness is
// only consulted when the record's host matches. os.hostname() is what
// lease.mjs writes, so the test uses the same source.
function require_hostname() {
  return hostname();
}
