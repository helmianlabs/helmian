// Fix A9 — the NULL-namespace close (audit AT-5/T13).
//
// The shared-memory tables (helmion.context_entries,
// helmion.blockers, helmion.autonomy_rules) predate tenants and
// carried a shared namespace: rows filed under a NULL project_slug
// that every tenant's read included alongside its own. AT-5's
// census found production holding exactly one such row (a
// hand-written build note, key seat-build-winner-2026-11-06) and
// the writer list closed — the Librarian store is the only runtime
// writer and binds the membership-checked tenant's slug on every
// filing, so no code path can produce a NULL row (the one-pen pin,
// test/envoy-librarian-one-pen.test.mjs). The residual seam was
// the READ side, and this bite closes it: every read binds the
// tenant slug exactly, so a NULL-slug row is visible to NO tenant,
// in any read shape.
//
// This file pins the close two ways. The source pin (always runs)
// is the read-side complement of the one-pen write pin: no file
// under src/ may carry a NULL-slug arm on a read again. The
// Postgres tests (HELMIAN_TEST_PG_URL, the tenant-isolation
// pattern) plant a NULL-slug context row under the production
// row's exact key, a NULL-slug blocker (open and resolved, with a
// lesson), and a NULL-slug autonomy rule, then prove no tenant's
// read shape returns them — the notebook block, the structured
// notebook entries, the Neon adapter's getContext, and the
// slug-scoped listActiveBlockers — while each tenant's own rows
// read exactly as before. The one deliberate exception is named,
// not hidden: listActiveBlockers with NO slug is the operator's
// unscoped listing (the MCP/CLI road), not a tenant read, and it
// still returns every active blocker.
import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';

const SRC = new URL('../src/', import.meta.url);

test('null namespace: no read under src/ carries a NULL-slug arm', async () => {
  const names = (await readdir(SRC, { recursive: true })).filter((name) => name.endsWith('.mjs')).sort();
  assert.ok(names.length > 0, 'the source walk found the tree');
  for (const rel of names) {
    const text = await readFile(new URL(rel, SRC), 'utf8');
    assert.equal(/project_slug\s+is\s+null/i.test(text), false,
      `${rel.replaceAll('\\', '/')} carries no NULL-slug read arm (fix A9)`);
  }
});

// ---------- the desk test on a real database (HELMIAN_TEST_PG_URL) ----------

const pgUrl = process.env.HELMIAN_TEST_PG_URL;
const pgSkip = pgUrl ? false : 'HELMIAN_TEST_PG_URL is not set';

function makeTenants() {
  const run = randomUUID().slice(0, 8);
  return {
    run,
    A: `a9a-${run}`,
    B: `a9b-${run}`,
    NULL_FACT: `NULL-FACT-${run}`,
    NULL_BLOCKER: `NULL-BLOCKER-${run}`,
    NULL_LESSON: `NULL-LESSON-${run}`,
    NULL_RULE: `NULL-RULE-${run}`,
  };
}

async function makePool() {
  const { default: pg } = await import('pg');
  return new pg.Pool({ connectionString: pgUrl });
}

async function seed(pool, t) {
  for (const slug of [t.A, t.B]) {
    await pool.query('insert into helmion.projects(slug, name) values ($1,$2) on conflict (slug) do nothing', [slug, slug]);
  }
  const entry = (slug, key, value) => pool.query(
    'insert into helmion.context_entries(project_slug, key, value) values ($1,$2,$3::jsonb)',
    [slug, key, JSON.stringify(value)],
  );
  await entry(t.A, 'a9-a-fact', `A-FACT-${t.run}`);
  await entry(t.B, 'a9-b-fact', `B-FACT-${t.run}`);
  // The production row's exact key and shape: a NULL-slug build note.
  await entry(null, 'seat-build-winner-2026-11-06', t.NULL_FACT);
  const blocker = (slug, status, description, lesson) => pool.query(
    `insert into helmion.blockers(project_slug, status, severity, description, outcome, citation, root_cause, snippet, lesson, resolved_at)
     values ($1,$2,'high',$3,$4,$5,$6,$7,$8, case when $2='RESOLVED' then clock_timestamp() else null end)`,
    [slug, status, description,
      status === 'RESOLVED' ? 'done' : null,
      status === 'RESOLVED' ? 'proof.mjs:1' : null,
      status === 'RESOLVED' ? 'canary cause' : null,
      status === 'RESOLVED' ? 'canary snippet' : null,
      lesson],
  );
  await blocker(t.A, 'OPEN', `A-BLOCKER-${t.run}`, null);
  await blocker(t.B, 'OPEN', `B-BLOCKER-${t.run}`, null);
  await blocker(null, 'OPEN', t.NULL_BLOCKER, null);
  await blocker(t.A, 'RESOLVED', `A-OLD-${t.run}`, `A-LESSON-${t.run}`);
  await blocker(null, 'RESOLVED', `NULL-OLD-${t.run}`, t.NULL_LESSON);
  const rule = (slug, pattern) => pool.query(
    'insert into helmion.autonomy_rules(project_slug, pattern, reason, snippet, citation) values ($1,$2,$3,$4,$5)',
    [slug, pattern, 'a9 canary rule', 'a9 snippet', 'a9 citation'],
  );
  await rule(t.A, `A-RULE-${t.run}`);
  await rule(null, t.NULL_RULE);
}

async function cleanup(pool, t) {
  await pool.query("delete from helmion.context_entries where project_slug is null and value::text like $1", [`%${t.run}%`]).catch(() => {});
  await pool.query('delete from helmion.blockers where project_slug is null and description like $1', [`%${t.run}%`]).catch(() => {});
  await pool.query('delete from helmion.autonomy_rules where project_slug is null and pattern like $1', [`%${t.run}%`]).catch(() => {});
  for (const slug of [t.A, t.B]) {
    // Deleting the project cascades the tenant's notebook rows away.
    await pool.query('delete from helmion.projects where slug = $1', [slug]).catch(() => {});
  }
}

test('null namespace: the notebook block and entries return a NULL-slug row to no tenant', { skip: pgSkip }, async () => {
  const { readNotebookBlock, readNotebookEntries } = await import('../src/cloud/envoy-notebook.mjs');
  const t = makeTenants();
  const pool = await makePool();
  try {
    await seed(pool, t);
    for (const [slug, own, other] of [[t.A, `A-FACT-${t.run}`, `B-FACT-${t.run}`], [t.B, `B-FACT-${t.run}`, `A-FACT-${t.run}`]]) {
      const block = await readNotebookBlock(pool, slug, { log: () => {} });
      assert.ok(block, `tenant ${slug} has a notebook block`);
      // Ordinary tenant rows read exactly as before.
      assert.ok(block.includes(own), `tenant ${slug} block carries its own entry`);
      assert.ok(block.includes(`${slug === t.A ? 'A' : 'B'}-BLOCKER-${t.run}`), `tenant ${slug} block carries its own blocker`);
      if (slug === t.A) assert.ok(block.includes(`A-LESSON-${t.run}`), 'tenant A block carries its own lesson');
      // The other tenant's rows never appear (the boundary that predates A9).
      assert.ok(!block.includes(other), `tenant ${slug} block never carries the other tenant`);
      // The NULL-slug rows appear for NO tenant, in any section.
      assert.ok(!block.includes(t.NULL_FACT), `tenant ${slug} block never carries the NULL-slug entry`);
      assert.ok(!block.includes(t.NULL_BLOCKER), `tenant ${slug} block never carries the NULL-slug blocker`);
      assert.ok(!block.includes(t.NULL_LESSON), `tenant ${slug} block never carries the NULL-slug lesson`);
      const entries = await readNotebookEntries(pool, slug, { log: () => {} });
      assert.ok(Array.isArray(entries), `tenant ${slug} entries read`);
      const keys = entries.map((e) => e.key);
      assert.ok(keys.includes(slug === t.A ? 'a9-a-fact' : 'a9-b-fact'), `tenant ${slug} entries carry its own fact`);
      assert.ok(!keys.includes('seat-build-winner-2026-11-06'), `tenant ${slug} entries never carry the NULL-slug row`);
      assert.ok(!JSON.stringify(entries).includes(t.NULL_FACT), `tenant ${slug} entries never carry the NULL-slug value`);
    }
  } finally {
    await cleanup(pool, t);
    await pool.end();
  }
});

test('null namespace: getContext and the scoped blocker list return a NULL-slug row to no tenant', { skip: pgSkip }, async () => {
  const { createNeonStore } = await import('../src/adapters/neon.mjs');
  const t = makeTenants();
  const pool = await makePool();
  try {
    await seed(pool, t);
    const store = await createNeonStore(null, { pool });
    for (const [slug, ownFact, ownRule] of [[t.A, `A-FACT-${t.run}`, `A-RULE-${t.run}`], [t.B, `B-FACT-${t.run}`, null]]) {
      const ctx = await store.getContext(slug);
      const text = JSON.stringify(ctx);
      assert.ok(text.includes(ownFact), `getContext(${slug}) carries its own entry`);
      if (ownRule) assert.ok(text.includes(ownRule), `getContext(${slug}) carries its own rule`);
      assert.ok(!text.includes(t.NULL_FACT), `getContext(${slug}) never carries the NULL-slug entry`);
      assert.ok(!text.includes(t.NULL_BLOCKER), `getContext(${slug}) never carries the NULL-slug blocker`);
      assert.ok(!text.includes(t.NULL_RULE), `getContext(${slug}) never carries the NULL-slug rule`);
      const scoped = await store.listActiveBlockers(slug);
      const scopedText = JSON.stringify(scoped);
      assert.ok(!scopedText.includes(t.NULL_BLOCKER), `listActiveBlockers(${slug}) never carries the NULL-slug blocker`);
    }
    const scopedA = JSON.stringify(await store.listActiveBlockers(t.A));
    assert.ok(scopedA.includes(`A-BLOCKER-${t.run}`), 'listActiveBlockers(A) carries tenant A blocker exactly as before');
    // The named exception: no slug at all is the operator's unscoped
    // listing (the MCP/CLI road), not a tenant read — it still
    // returns every active blocker, NULL-slug rows included.
    const unscoped = JSON.stringify(await store.listActiveBlockers());
    assert.ok(unscoped.includes(t.NULL_BLOCKER), 'the unscoped operator listing still returns every active blocker');
    assert.ok(unscoped.includes(`A-BLOCKER-${t.run}`), 'the unscoped operator listing still returns tenant blockers');
  } finally {
    await cleanup(pool, t);
    await pool.end();
  }
});
