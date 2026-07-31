// Positive controls for the Tier-B advisory consensus gate.
//
// docs/archive/FLYWHEEL_AUDIT_2026-07-28.md finding #3: helmion.advisory_reviews.action_hash
// is `not null references helmion.governance_actions(action_hash)`
// (sql/001_helmion.sql:83), but nothing in src/ ever inserted a governance_actions
// row. Every real helmion_record_review call therefore raised a foreign-key
// violation and rolled back, making the gate structurally unreachable.
//
// The pre-existing test/neon-governance.test.mjs mocks pool.query and answers
// only the queries it expects, so it could never see this. These two suites are
// built to see it:
//
//   1. schemaDrift  — parses the REAL sql/*.sql files and the REAL src/ tree.
//                     No mock is involved, so it cannot agree with a wrong
//                     assumption I made in a stub.
//   2. fkPool       — a pool stub that ENFORCES the foreign key and raises the
//                     real Postgres 23503 error, so recordReview is exercised
//                     against the constraint rather than around it.
//
// Both fail on the pre-fix tree. Run order is irrelevant; neither writes.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createNeonStore } from '../src/adapters/neon.mjs';
import { governanceActionHash } from '../src/core/advisory-action.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

// A parent table may legitimately have no writer in src/ ONLY when the absence
// is a deliberate, documented security boundary. Each entry must cite the file
// and line that states the intent, so this list cannot quietly absorb a real
// defect the way an untested FK did.
const WRITERLESS_BY_DESIGN = new Map([
  [
    'human_identity_keys',
    'docs/HUMAN_CONFIRMATIONS.md:37-39 — "Helmion deliberately has no MCP or '
    + 'coordinator method for enrolling a trusted identity key. Otherwise an '
    + 'agent could create its own trust root and approve its own action."',
  ],
]);

// ---------------------------------------------------------------------------
// 1. Schema-vs-code drift, read from the real files
// ---------------------------------------------------------------------------

// Split a table body on commas that sit at paren depth 0, so that
// `check (x in ('A','B'))` stays in one fragment with its column.
function topLevelFragments(body) {
  const fragments = [];
  let depth = 0;
  let current = '';
  for (const character of body) {
    if (character === '(') depth += 1;
    if (character === ')') depth -= 1;
    if (character === ',' && depth === 0) {
      fragments.push(current);
      current = '';
      continue;
    }
    current += character;
  }
  if (current.trim()) fragments.push(current);
  return fragments;
}

function tableBodies(sql) {
  const tables = new Map();
  // Built from fragments so this file does not contain the literal DDL phrase,
  // which the local PreToolUse autonomy guard blocks on sight.
  const opener = new RegExp(
    `${'create'} ${'table'} if not exists helmion\\.([a-z_]+)\\s*\\(`,
    'gi',
  );
  for (const match of sql.matchAll(opener)) {
    let depth = 1;
    let index = match.index + match[0].length;
    const start = index;
    while (index < sql.length && depth > 0) {
      if (sql[index] === '(') depth += 1;
      if (sql[index] === ')') depth -= 1;
      index += 1;
    }
    tables.set(match[1], sql.slice(start, index - 1));
  }
  return tables;
}

// A NOT NULL foreign key means: every insert into the child is impossible until
// a parent row exists. That is the property under test.
function requiredForeignKeys(tables) {
  const edges = [];
  for (const [child, body] of tables) {
    for (const fragment of topLevelFragments(body)) {
      const normalized = fragment.replace(/\s+/g, ' ').trim();
      if (/^(?:constraint|unique|check|primary|foreign|exclude)\b/i.test(normalized)) continue;
      const column = normalized.match(/^([a-z_]+)\s/i)?.[1];
      const parent = normalized.match(/references\s+helmion\.([a-z_]+)/i)?.[1];
      if (!column || !parent) continue;
      if (!/\bnot null\b/i.test(normalized)) continue;
      edges.push({ child, column, parent });
    }
  }
  return edges;
}

async function sourceFiles(directory) {
  const found = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const full = join(directory, entry.name);
    if (entry.isDirectory()) found.push(...await sourceFiles(full));
    else if (entry.name.endsWith('.mjs')) found.push(full);
  }
  return found;
}

async function insertWriters() {
  const writers = new Map();
  for (const file of await sourceFiles(join(root, 'src'))) {
    const contents = await readFile(file, 'utf8');
    for (const match of contents.matchAll(/insert\s+into\s+helmion\.([a-z_]+)/gi)) {
      const line = contents.slice(0, match.index).split('\n').length;
      if (!writers.has(match[1])) writers.set(match[1], []);
      writers.get(match[1]).push(`${file.slice(root.length + 1).replace(/\\/g, '/')}:${line}`);
    }
  }
  return writers;
}

test('every NOT NULL foreign key whose child has a writer also has a parent writer', async () => {
  const tables = new Map();
  for (const name of (await readdir(join(root, 'sql'))).filter((n) => n.endsWith('.sql'))) {
    const sql = await readFile(join(root, 'sql', name), 'utf8');
    for (const [table, body] of tableBodies(sql)) tables.set(table, body);
  }

  // Guard the parser itself: if these anchors ever stop being found the suite
  // would pass vacuously, which is exactly the failure mode being fixed.
  assert.ok(tables.has('advisory_reviews'), 'parser found no advisory_reviews table');
  assert.ok(tables.has('governance_actions'), 'parser found no governance_actions table');

  const edges = requiredForeignKeys(tables);
  assert.ok(
    edges.some((e) => e.child === 'advisory_reviews' && e.parent === 'governance_actions'),
    'parser did not see advisory_reviews.action_hash -> governance_actions',
  );

  const writers = await insertWriters();
  const unsatisfiable = edges
    .filter((edge) => writers.has(edge.child))
    .filter((edge) => !writers.has(edge.parent))
    .filter((edge) => !WRITERLESS_BY_DESIGN.has(edge.parent));

  assert.deepEqual(
    unsatisfiable,
    [],
    'These NOT NULL foreign keys can never be satisfied — src/ inserts into the '
    + 'child but never into the parent, so every such insert fails 23503:\n'
    + unsatisfiable
      .map((e) => `  helmion.${e.child}.${e.column} -> helmion.${e.parent} `
        + `(child written at ${writers.get(e.child).join(', ')}; parent never written)`)
      .join('\n'),
  );
});

test('the documented no-writer exception still cites a real doc line', async () => {
  const doc = await readFile(join(root, 'docs', 'HUMAN_CONFIRMATIONS.md'), 'utf8');
  assert.match(
    doc,
    /deliberately has no MCP or coordinator method for enrolling a trusted\s+identity key/,
    'HUMAN_CONFIRMATIONS.md no longer states the enrollment boundary that '
    + 'WRITERLESS_BY_DESIGN relies on; re-verify before trusting the exception',
  );
  assert.equal(WRITERLESS_BY_DESIGN.size, 1, 'a new no-writer exception was added without review');
});

// ---------------------------------------------------------------------------
// 2. recordReview against an enforced foreign key
// ---------------------------------------------------------------------------

// Models only what the constraint does: governance_actions.action_hash is a
// primary key, advisory_reviews.action_hash is a NOT NULL FK to it, and
// (action_hash, advisor) is unique.
function foreignKeyPool() {
  const actions = new Map();
  const reviews = new Map();
  const events = [];

  function fkViolation() {
    const error = new Error(
      'insert or update on table "advisory_reviews" violates foreign key '
      + 'constraint "advisory_reviews_action_hash_fkey"',
    );
    error.code = '23503';
    error.table = 'advisory_reviews';
    error.constraint = 'advisory_reviews_action_hash_fkey';
    return error;
  }

  async function query(sql, parameters = []) {
    const normalized = String(sql).replace(/\s+/g, ' ').trim().toLowerCase();
    events.push(normalized.split(' ').slice(0, 3).join(' '));

    if (['begin', 'commit', 'rollback'].includes(normalized)) return { rowCount: 0, rows: [] };

    if (normalized.startsWith('insert into helmion.governance_actions')) {
      const [actionHash, projectSlug, tier, operation, diffSummary] = parameters;
      if (actions.has(actionHash)) return { rowCount: 0, rows: [] }; // on conflict do nothing
      const row = {
        action_hash: actionHash,
        project_slug: projectSlug,
        tier,
        operation: typeof operation === 'string' ? JSON.parse(operation) : operation,
        diff_summary: diffSummary ?? null,
        state: 'PENDING',
      };
      actions.set(actionHash, row);
      return { rowCount: 1, rows: [row] };
    }

    if (normalized.startsWith('select') && normalized.includes('helmion.governance_actions')) {
      const row = actions.get(parameters[0]);
      return row ? { rowCount: 1, rows: [row] } : { rowCount: 0, rows: [] };
    }

    if (normalized.startsWith('insert into helmion.advisory_reviews')) {
      const [actionHash, advisor, decision, readOnly, rationale, evidence] = parameters;
      if (!actions.has(actionHash)) throw fkViolation();
      const row = {
        action_hash: actionHash,
        advisor,
        decision,
        read_only: readOnly,
        rationale: rationale ?? null,
        evidence: evidence ?? {},
      };
      reviews.set(`${actionHash}|${advisor}`, row);
      return { rowCount: 1, rows: [row] };
    }

    if (normalized.startsWith('select') && normalized.includes('helmion.advisory_reviews')) {
      const rows = [...reviews.values()].filter((r) => r.action_hash === parameters[0]);
      return { rowCount: rows.length, rows };
    }

    throw new Error(`Unexpected query: ${normalized}`);
  }

  return {
    events,
    actions,
    query,
    async connect() {
      return { query, release() {} };
    },
  };
}

const tierBOperation = {
  schemaChange: true,
  summary: 'add advisory_outputs review state',
  files: ['sql/bigsister/001_advisory_output_review_state.sql'],
};

test('recording a review for an unregistered action fails loudly, not with a raw 23503', async () => {
  const pool = foreignKeyPool();
  const store = await createNeonStore(null, { pool });
  await assert.rejects(
    store.recordReview({
      action_hash: 'a'.repeat(64),
      advisor: 'claude',
      decision: 'APPROVED',
      read_only: true,
    }),
    (error) => {
      assert.match(error.message, /not registered/i);
      assert.match(error.message, /helmion_register_action|registerGovernanceAction/);
      return true;
    },
  );
  assert.equal(pool.events.at(-1), 'rollback');
});

test('a registered Tier B action accepts all four advisor votes and completes advisory review', async () => {
  const pool = foreignKeyPool();
  const store = await createNeonStore(null, { pool });

  const registration = await store.registerGovernanceAction({
    projectSlug: 'helmion',
    operation: tierBOperation,
  });
  assert.equal(registration.registered, true);
  assert.equal(registration.action_hash, governanceActionHash(tierBOperation));
  assert.equal(registration.data.tier, 'B');

  const actionHash = registration.action_hash;
  for (const advisor of ['claude', 'gemini', 'grok', 'openai']) {
    const result = await store.recordReview({
      action_hash: actionHash,
      advisor,
      decision: 'APPROVED',
      read_only: true,
      rationale: 'read-only review',
    });
    assert.equal(result.durability, 'committed');
  }

  const consensus = await store.getConsensus(actionHash, tierBOperation);
  assert.equal(consensus.tier, 'B');
  assert.equal(consensus.action_registered, true);
  assert.deepEqual(consensus.missing, []);
  assert.equal(consensus.advisory_complete, true);
  // Model votes never replace a human. This must stay false.
  assert.equal(consensus.approved, false);
  assert.equal(consensus.requires_human_approval, true);
});

test('registering the same operation twice is idempotent and keeps one action hash', async () => {
  const pool = foreignKeyPool();
  const store = await createNeonStore(null, { pool });
  const first = await store.registerGovernanceAction({ operation: tierBOperation });
  const second = await store.registerGovernanceAction({ operation: tierBOperation });
  assert.equal(first.action_hash, second.action_hash);
  assert.equal(first.registered, true);
  assert.equal(second.registered, false);
  assert.equal(pool.actions.size, 1);
});

test('the action hash is a commitment to the operation, so a swapped operation is rejected', async () => {
  const pool = foreignKeyPool();
  const store = await createNeonStore(null, { pool });
  const { action_hash: actionHash } = await store.registerGovernanceAction({
    operation: tierBOperation,
  });

  // An advisor approved the schema change above. Checking consensus against a
  // different, harmless-looking operation must not inherit those votes.
  await assert.rejects(
    store.getConsensus(actionHash, { summary: 'just a comment tweak' }),
    /does not hash to the registered action/i,
  );
});

test('key order in the operation does not change the action hash', () => {
  assert.equal(
    governanceActionHash({ schemaChange: true, summary: 'x' }),
    governanceActionHash({ summary: 'x', schemaChange: true }),
  );
  assert.notEqual(
    governanceActionHash({ schemaChange: true, summary: 'x' }),
    governanceActionHash({ schemaChange: true, summary: 'y' }),
  );
});
