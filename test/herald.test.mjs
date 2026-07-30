// Helmion Herald — the phone companion.
//
// It opens a port, so most of this file is about what it REFUSES: no token, no
// answer; no write methods; no route that reaches the filesystem; and never a
// calm-looking page when it could not actually read anything.
//
// The digest half is pure and is tested against real files in a temp workspace.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  buildDigest,
  readAdvisory,
  readBlocks,
  readLease,
  summarize,
} from '../src/herald/digest.mjs';
import {
  mintToken,
  renderPage,
  startHerald,
  tokenMatches,
} from '../src/herald/server.mjs';

async function workspaceWith({ blocks = [], advisory = [], lease = null } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'helmion-herald-'));
  if (blocks.length) {
    await mkdir(join(root, '.helmion', 'audit'), { recursive: true });
    await writeFile(join(root, '.helmion', 'audit', 'blocks-2026-07-30.jsonl'),
      blocks.map((b) => JSON.stringify(b)).join('\n') + '\n');
  }
  if (advisory.length) {
    await mkdir(join(root, '.helmion', 'advisory'), { recursive: true });
    await writeFile(join(root, '.helmion', 'advisory', 'advisory-2026-07-30.jsonl'),
      advisory.map((a) => JSON.stringify(a)).join('\n') + '\n');
  }
  if (lease) {
    await mkdir(join(root, '.helmion'), { recursive: true });
    await writeFile(join(root, '.helmion', 'lease.json'), JSON.stringify(lease));
  }
  return root;
}

const refusedDecision = {
  kind: 'decision',
  at: '2026-07-30T09:00:00.000Z',
  summary: 'delete the audit folder to speed up tests',
  decision: {
    allowed: false,
    reason: 'no usable review from: gemini.',
    missing: ['gemini'],
    blocks: [],
    concerns: [{ advisor: 'chatgpt', reason: 'this destroys the evidence ledger' }],
  },
};

test('an empty workspace is quiet, and says so without inventing anything', async () => {
  const root = await workspaceWith({});
  try {
    const digest = await buildDigest(root);
    assert.equal(digest.summary.state, 'quiet');
    assert.equal(digest.summary.waiting, 0);
    assert.equal(digest.blocks.computed, true);
    assert.equal(digest.advisory.computed, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('A REFUSED CHANGE IS THE HEADLINE — that is the whole point of a herald', async () => {
  const root = await workspaceWith({ advisory: [refusedDecision] });
  try {
    const digest = await buildDigest(root);
    assert.equal(digest.summary.state, 'needs-you');
    assert.equal(digest.summary.waiting, 1);
    assert.match(digest.summary.detail, /delete the audit folder/);
    assert.match(digest.summary.detail, /gemini/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('an ALLOWED decision is not news and does not raise the headline', async () => {
  const root = await workspaceWith({
    advisory: [{
      kind: 'decision', at: '2026-07-30T09:00:00.000Z', summary: 'rename a variable',
      decision: { allowed: true, reason: '3 advisors approved', missing: [], blocks: [], concerns: [] },
    }],
  });
  try {
    const digest = await buildDigest(root);
    assert.equal(digest.summary.state, 'quiet');
    assert.equal(digest.summary.waiting, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('blocked commands are reported, but do not claim to need a decision', async () => {
  // The guard already handled them. Reporting them as "waiting on you" would
  // train him to ignore the one that is.
  const root = await workspaceWith({
    blocks: [{
      timestamp: '2026-07-30T08:00:00.000Z', layer: 'execution',
      matchedPattern: 'recursive/forced rm', text: 'rm -rf /', outcome: 'blocked',
    }],
  });
  try {
    const digest = await buildDigest(root);
    assert.equal(digest.summary.state, 'quiet');
    assert.equal(digest.summary.waiting, 0);
    assert.equal(digest.blocks.items.length, 1);
    assert.match(digest.summary.detail, /1 command blocked recently/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('UNKNOWN OUTRANKS QUIET — it never looks calm because it could not read', () => {
  const summary = summarize({
    blocks: { computed: false, items: [], reason: 'permission denied' },
    advisory: { computed: true, items: [] },
    lease: { computed: true, state: 'none' },
  });
  assert.equal(summary.state, 'unknown');
  assert.match(summary.headline, /Could not read: block ledger/);
  assert.match(summary.detail, /not an all-clear/);
});

test('a stale lease is reported as stale, an expired one is not called active', async () => {
  const root = await workspaceWith({
    lease: { instanceId: 'troy:41876', projectSlug: 'Helmion', expiresAt: '2020-01-01T00:00:00.000Z' },
  });
  try {
    const lease = await readLease(root, new Date('2026-07-30T09:00:00.000Z'));
    assert.equal(lease.state, 'stale');
    assert.equal(lease.holder, 'troy:41876');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a torn journal line is skipped, not fatal', async () => {
  const root = await mkdtemp(join(tmpdir(), 'helmion-herald-torn-'));
  try {
    await mkdir(join(root, '.helmion', 'advisory'), { recursive: true });
    await writeFile(join(root, '.helmion', 'advisory', 'advisory-2026-07-30.jsonl'),
      `${JSON.stringify(refusedDecision)}\n{ this line is torn\n`);
    const advisory = await readAdvisory(root);
    assert.equal(advisory.computed, true);
    assert.equal(advisory.items.length, 1, 'the good line survived');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// ─── the server half ───────────────────────────────────────────────────────

test('the token is 32 bytes of entropy and compares in constant time', () => {
  const a = mintToken();
  const b = mintToken();
  assert.equal(a.length, 64, '32 bytes, hex');
  assert.notEqual(a, b, 'minted per run, never reused');
  assert.equal(tokenMatches(a, a), true);
  assert.equal(tokenMatches(a, b), false);
  // A length mismatch must be false, not a throw — timingSafeEqual rejects
  // unequal lengths and an unguarded call would crash the request.
  assert.equal(tokenMatches(a, 'short'), false);
  assert.equal(tokenMatches(a, ''), false);
  assert.equal(tokenMatches(a, undefined), false);
  assert.equal(tokenMatches('', ''), false, 'an empty expected token never matches anything');
});

test('NO TOKEN, NO ANSWER — on every route', async () => {
  const root = await workspaceWith({ advisory: [refusedDecision] });
  const herald = await startHerald({ workspace: root, port: 0 });
  try {
    for (const path of ['/', '/api/digest', '/anything']) {
      const response = await fetch(`http://127.0.0.1:${herald.port}${path}`);
      assert.equal(response.status, 401, `${path} must refuse without a token`);
      const body = await response.text();
      assert.ok(!body.includes('audit folder'), 'and it leaks nothing about the workspace');
    }

    const wrong = await fetch(`http://127.0.0.1:${herald.port}/?token=nope`);
    assert.equal(wrong.status, 401);
  } finally {
    await herald.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('with the token it serves the page and the JSON', async () => {
  const root = await workspaceWith({ advisory: [refusedDecision] });
  const herald = await startHerald({ workspace: root, port: 0 });
  try {
    const page = await fetch(`http://127.0.0.1:${herald.port}/?token=${herald.token}`);
    assert.equal(page.status, 200);
    const html = await page.text();
    assert.match(html, /Helmion Herald/);
    assert.match(html, /NEEDS-YOU/);
    assert.match(html, /delete the audit folder/);

    const api = await fetch(`http://127.0.0.1:${herald.port}/api/digest`, {
      headers: { 'x-helmion-token': herald.token },
    });
    assert.equal(api.status, 200);
    const digest = await api.json();
    assert.equal(digest.summary.state, 'needs-you');
  } finally {
    await herald.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('IT IS READ-ONLY — every write method is refused even WITH a valid token', async () => {
  const root = await workspaceWith({});
  const herald = await startHerald({ workspace: root, port: 0 });
  try {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      const response = await fetch(`http://127.0.0.1:${herald.port}/?token=${herald.token}`, { method });
      assert.equal(response.status, 405, `${method} must be refused`);
      assert.match(await response.text(), /read-only/i);
    }
  } finally {
    await herald.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('no request path can reach the filesystem', async () => {
  // There is no static handler; every path renders the same digest. This pins
  // that a traversal attempt returns the page rather than a file.
  const root = await workspaceWith({});
  const herald = await startHerald({ workspace: root, port: 0 });
  try {
    const response = await fetch(
      `http://127.0.0.1:${herald.port}/../../../../Windows/win.ini?token=${herald.token}`,
    );
    const body = await response.text();
    assert.equal(response.status, 200);
    assert.match(body, /Helmion Herald/, 'it rendered the page, not a file');
    assert.ok(!/\[fonts\]|for 16-bit app support/i.test(body), 'and no system file leaked');
  } finally {
    await herald.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('it defaults to LOOPBACK — reaching the LAN is an explicit choice', async () => {
  const root = await workspaceWith({});
  const herald = await startHerald({ workspace: root, port: 0 });
  try {
    assert.equal(herald.host, '127.0.0.1');
    assert.ok(herald.urls.every((u) => u.includes('127.0.0.1')));
  } finally {
    await herald.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('the page escapes what it renders', () => {
  const digest = {
    tool: 'Helmion Herald',
    workspace: 'E:\\Helmion',
    generatedAt: '2026-07-30T09:00:00.000Z',
    summary: { state: 'needs-you', headline: '<img src=x onerror=alert(1)>', detail: '', waiting: 1 },
    lease: { computed: true, state: 'none', holder: '', expiresAt: null, reason: '' },
    advisory: { computed: true, items: [] },
    blocks: { computed: true, items: [] },
  };
  const html = renderPage(digest, 'tok');
  assert.ok(!html.includes('<img src=x'), 'injected markup is escaped');
  assert.match(html, /&lt;img src=x/);
});
