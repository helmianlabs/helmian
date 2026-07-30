// DOES THE WRITE LEASE ACTUALLY STOP A WRITE?
//
// `README.md:19` advertises "a database-enforced single active write lease per
// project" and the desktop UI repeats it as a "Lease invariant". Until
// 2026-07-29 nothing in the write path consulted a lease: `requireActiveLease`
// (src/adapters/neon.mjs:151) had four callers and every one was a Postgres
// write to a coordination table, and `grep -c lease` over `src/agent/tools.mjs`
// and `src/core/governance-gate.mjs` returned 0 and 0.
//
// `test/lease.test.mjs` proves the lease MECHANISM — mutual exclusion, stale
// takeover, fail-closed, a twelve-process race. This file proves the WIRING,
// and it proves it the only way that counts: by the side effect on disk. Every
// refusal here asserts the file was NOT created. A refusal message with a
// created file beside it would be theatre.

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import path from 'node:path';

import { createToolRuntime } from '../src/agent/tools.mjs';
import {
  DEFAULT_TTL_MS,
  acquireLease,
  leasePath,
  readLease,
} from '../src/core/lease.mjs';
import { LEASE_REQUIRED_TOOLS, requiresWriteLease } from '../src/core/governance-gate.mjs';

function workspace() {
  return mkdtempSync(path.join(tmpdir(), 'helmion-lease-enforce-'));
}

/**
 * Plant a lease held by a DIFFERENT machine. A foreign host is judged on expiry
 * alone (pid liveness is only meaningful locally), so an unexpired one is a live
 * rival — which is exactly the condition a second Claude Code session creates.
 */
function plantForeignLease(dir, { expiresInMs = DEFAULT_TTL_MS, token = 'rival-token' } = {}) {
  const file = leasePath(dir);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({
    version: 1,
    projectSlug: 'helmion',
    leaseToken: token,
    coordinatorId: 'claude-code',
    instanceId: 'rival-session',
    pid: 4242,
    host: 'some-other-machine',
    acquiredAt: new Date(Date.now() - 1000).toISOString(),
    renewedAt: new Date(Date.now() - 1000).toISOString(),
    expiresAt: new Date(Date.now() + expiresInMs).toISOString(),
    ttlMs: DEFAULT_TTL_MS,
    tookOverFrom: null,
  }), 'utf8');
  return token;
}

const full = (ws) => createToolRuntime(ws, { permissionMode: 'full' });

test('the policy set is the two mutating tools, and only those', () => {
  assert.deepEqual([...LEASE_REQUIRED_TOOLS].sort(), ['run_command', 'write_file']);
  assert.equal(requiresWriteLease('write_file'), true);
  assert.equal(requiresWriteLease('run_command'), true);
  // Reading cannot conflict with another writer, and requiring a lease to read
  // would make a second session useless rather than safe.
  for (const readTool of ['read_file', 'list_dir', 'search_text']) {
    assert.equal(requiresWriteLease(readTool), false, `${readTool} must not need a lease`);
  }
});

test('THE WRITE IS REFUSED AND THE FILE IS NOT CREATED when another writer holds the lease', async () => {
  const ws = workspace();
  try {
    plantForeignLease(ws);
    const runtime = full(ws);

    const result = await runtime.execute('write_file', { path: 'should-not-exist.txt', content: 'x' });

    assert.match(result, /write lease/i, `the refusal must say why: ${result}`);
    assert.match(result, /rival-session|another writer/i);
    assert.equal(
      existsSync(path.join(ws, 'should-not-exist.txt')),
      false,
      'THE FILE WAS WRITTEN ANYWAY — the lease is decoration, not enforcement',
    );
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test('THE SHELL COMMAND IS REFUSED TOO, and leaves no side effect', async () => {
  const ws = workspace();
  try {
    plantForeignLease(ws);
    const runtime = full(ws);

    const result = await runtime.execute('run_command', {
      command: 'node -e "require(\'fs\').writeFileSync(\'shell-made-this.txt\',\'x\')"',
    });

    assert.match(result, /write lease/i, `the refusal must say why: ${result}`);
    assert.equal(
      existsSync(path.join(ws, 'shell-made-this.txt')),
      false,
      'the command ran despite the lease being held elsewhere',
    );
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test('READING IS STILL ALLOWED while another writer holds the lease', async () => {
  // The invariant is single-WRITER. A rival lease must not turn the project into
  // a black box for everyone else.
  const ws = workspace();
  try {
    writeFileSync(path.join(ws, 'readable.txt'), 'hello from disk', 'utf8');
    plantForeignLease(ws);
    const runtime = full(ws);

    const read = await runtime.execute('read_file', { path: 'readable.txt' });
    assert.match(read, /hello from disk/, `a read was blocked by a write lease: ${read}`);

    const listed = await runtime.execute('list_dir', { path: '.' });
    assert.match(listed, /readable\.txt/);
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test('A FREE PROJECT JUST WORKS: the lease is taken on the first write, with no configuration', async () => {
  // The enforcement is worthless if it makes the ordinary single-session case
  // require setup. Nobody passes a token here.
  const ws = workspace();
  try {
    const runtime = full(ws);
    assert.equal(readLease(ws), null, 'a fresh workspace must not already hold a lease');

    const result = await runtime.execute('write_file', { path: 'made.txt', content: 'hello' });
    assert.doesNotMatch(result, /write lease/i, `an unheld project refused a write: ${result}`);
    assert.equal(readFileSync(path.join(ws, 'made.txt'), 'utf8'), 'hello');

    const lease = readLease(ws);
    assert.ok(lease, 'the first write must have taken the lease');
    assert.equal(lease.pid, process.pid);
    assert.equal(lease.host, hostname());
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test('A READ-ONLY SESSION DOES NOT TAKE THE LEASE', async () => {
  // Acquisition is lazy on purpose. A session that only reads must not park the
  // project for ninety seconds and lock out a real writer.
  const ws = workspace();
  try {
    writeFileSync(path.join(ws, 'readable.txt'), 'x', 'utf8');
    const runtime = full(ws);

    await runtime.execute('read_file', { path: 'readable.txt' });
    await runtime.execute('list_dir', { path: '.' });

    assert.equal(readLease(ws), null, 'reading took the write lease; it must not');
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test('A STALE RIVAL DOES NOT BLOCK FOREVER: an expired lease is taken over and the write lands', async () => {
  const ws = workspace();
  try {
    plantForeignLease(ws, { expiresInMs: -5000, token: 'expired-rival' });
    const runtime = full(ws);

    const result = await runtime.execute('write_file', { path: 'after-takeover.txt', content: 'ok' });
    assert.doesNotMatch(result, /write lease/i, `a stale lease blocked a write: ${result}`);
    assert.equal(readFileSync(path.join(ws, 'after-takeover.txt'), 'utf8'), 'ok');

    const lease = readLease(ws);
    assert.equal(lease.pid, process.pid, 'the takeover did not record us as the holder');
    assert.match(lease.tookOverFrom.reason, /expired/);
    assert.equal(lease.tookOverFrom.instanceId, 'rival-session', 'who was displaced must be recorded');
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test('FAILS CLOSED: an unreadable lease file refuses the write rather than assuming nobody holds it', async () => {
  const ws = workspace();
  try {
    const file = leasePath(ws);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, '{ this is not json', 'utf8');

    const runtime = full(ws);
    const result = await runtime.execute('write_file', { path: 'nope.txt', content: 'x' });

    assert.match(result, /write lease/i, `a corrupt lease did not refuse: ${result}`);
    assert.equal(
      existsSync(path.join(ws, 'nope.txt')),
      false,
      'a corrupt lease was treated as "no lease, carry on" — the exact fail-open this must not have',
    );
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test('THE KERNEL STILL WINS: holding the lease does not authorize a destructive command', async () => {
  // Ordering matters. Holding the lease is permission to be the one writer, never
  // permission to do something the kernel forbids. If the lease check ran first
  // and short-circuited, "I hold the lease" would read as an authorization.
  const ws = workspace();
  try {
    acquireLease(ws, { projectSlug: 'helmion' });
    const runtime = full(ws);

    const result = await runtime.execute('run_command', { command: 'rm -rf /' });
    assert.match(result, /BLOCKED by Helmion governance/, `the kernel did not fire: ${result}`);
    assert.match(result, /destructive/i);
    assert.doesNotMatch(result, /write lease/i, 'it should be refused by the kernel, not the lease');
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test('a second runtime in this process keeps writing — the same writer, not a rival', async () => {
  // The deadlock this prevents: bridge.mjs builds a new runtime on every
  // permission-mode change, in the same process, for the same workspace.
  const ws = workspace();
  try {
    const first = full(ws);
    await first.execute('write_file', { path: 'one.txt', content: 'a' });

    const second = full(ws);
    const result = await second.execute('write_file', { path: 'two.txt', content: 'b' });

    assert.doesNotMatch(result, /write lease/i, `a mode change deadlocked the session: ${result}`);
    assert.equal(readFileSync(path.join(ws, 'two.txt'), 'utf8'), 'b');
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});
