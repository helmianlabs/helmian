// The advisory lane read path and its human-approval gate.
//
// docs/FLYWHEEL_AUDIT_2026-07-28.md finding #2. CLAUDE.md Rule 0.27: advisory
// output is low-trust and NEVER auto-promotes into the trusted layer. These
// tests exist to make that rule fail loudly if someone later adds a shortcut.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AdvisoryApprovalError,
  MINIMUM_NOTE_LENGTH,
  assertReviewApproval,
  buildListQuery,
  buildReviewUpdate,
  confirmationPhrase,
  createAdvisoryLane,
  laneCapabilities,
  normalizeState,
  summarizeRow,
} from '../src/core/advisory-lane.mjs';

const MIGRATED = laneCapabilities([
  'id', 'project_slug', 'advisor', 'question', 'response', 'created_at',
  'promoted', 'promoted_at', 'reviewed_at', 'reviewed_by', 'review_decision', 'review_note',
]);

// The schema as it actually stands on the bigsister endpoint, verified against
// information_schema 2026-07-28: promoted exists, the review columns do not.
const LEGACY = laneCapabilities([
  'id', 'project_slug', 'advisor', 'question', 'response', 'promoted', 'created_at',
]);

const approval = {
  id: 4,
  decision: 'PROMOTED',
  reviewer: 'Troy',
  note: 'Matches the measured row count in the probe and cites a real file:line.',
  confirmation: 'PROMOTE 4',
};

// ---------------------------------------------------------------------------
// The approval gate
// ---------------------------------------------------------------------------

test('a well-formed human approval is accepted', () => {
  const result = assertReviewApproval(approval);
  assert.equal(result.id, 4);
  assert.equal(result.decision, 'PROMOTED');
  assert.equal(result.reviewer, 'Troy');
});

test('promotion without a named reviewer is refused', () => {
  for (const reviewer of [undefined, null, '', '   ']) {
    assert.throws(
      () => assertReviewApproval({ ...approval, reviewer }),
      AdvisoryApprovalError,
      `reviewer ${JSON.stringify(reviewer)} should have been refused`,
    );
  }
});

test('promotion without a substantive reason is refused', () => {
  assert.throws(
    () => assertReviewApproval({ ...approval, note: 'ok' }),
    (error) => {
      assert.ok(error instanceof AdvisoryApprovalError);
      assert.match(error.message, new RegExp(String(MINIMUM_NOTE_LENGTH)));
      return true;
    },
  );
});

test('a confirmation for a different row cannot promote this row', () => {
  assert.throws(
    () => assertReviewApproval({ ...approval, confirmation: 'PROMOTE 5' }),
    /did not match/i,
  );
});

test('a reject confirmation cannot be replayed as a promote', () => {
  assert.throws(
    () => assertReviewApproval({ ...approval, confirmation: 'REJECT 4' }),
    /did not match/i,
  );
  assert.equal(confirmationPhrase('PROMOTED', 4), 'PROMOTE 4');
  assert.equal(confirmationPhrase('REJECTED', 4), 'REJECT 4');
});

test('a missing or empty confirmation never promotes', () => {
  for (const confirmation of [undefined, null, '', 'yes', 'y', 'PROMOTE', 'promote 4']) {
    assert.throws(
      () => assertReviewApproval({ ...approval, confirmation }),
      AdvisoryApprovalError,
      `confirmation ${JSON.stringify(confirmation)} should have been refused`,
    );
  }
});

// ---------------------------------------------------------------------------
// Query shaping across both schema versions
// ---------------------------------------------------------------------------

test('unreviewed listing works before the review migration is applied', () => {
  const query = buildListQuery({ state: 'unreviewed', capabilities: LEGACY });
  assert.match(query.text, /promoted = false/);
  assert.doesNotMatch(query.text, /review_decision/);
});

test('unreviewed listing uses review_decision once the migration is applied', () => {
  const query = buildListQuery({ state: 'unreviewed', capabilities: MIGRATED });
  assert.match(query.text, /review_decision is null/);
});

test('asking for rejected rows pre-migration says so instead of returning the wrong set', () => {
  assert.throws(
    () => buildListQuery({ state: 'rejected', capabilities: LEGACY }),
    /no review_decision column yet/i,
  );
});

test('an unknown state is refused rather than silently listing everything', () => {
  assert.throws(() => normalizeState('promotedish'), TypeError);
  assert.equal(normalizeState('ALL'), 'all');
});

test('the limit is bounded so a typo cannot pull the whole table', () => {
  assert.match(buildListQuery({ state: 'all', limit: 99999, capabilities: MIGRATED }).text, /limit 200/);
  assert.match(buildListQuery({ state: 'all', limit: -5, capabilities: MIGRATED }).text, /limit 1/);
});

test('the review update only ever touches an unreviewed row', () => {
  const migrated = buildReviewUpdate({ ...approval, capabilities: MIGRATED });
  assert.match(migrated.text, /where id = \$1 and review_decision is null/);
  const legacy = buildReviewUpdate({ ...approval, capabilities: LEGACY });
  assert.match(legacy.text, /where id = \$1 and promoted = false/);
});

test('a rejection never sets promoted true', () => {
  const legacy = buildReviewUpdate({ ...approval, decision: 'REJECTED', capabilities: LEGACY });
  assert.equal(legacy.values[1], false);
});

test('the response preview is truncated but the true length is reported', () => {
  const summary = summarizeRow({ id: 1, response: 'x'.repeat(500), question: 'q' }, 40);
  assert.equal(summary.response_chars, 500);
  assert.equal(summary.response_preview.length, 40);
});

// ---------------------------------------------------------------------------
// End to end against a fake client
// ---------------------------------------------------------------------------

function fakeClient({ columns, rows }) {
  const writes = [];
  return {
    writes,
    async query(sql, values = []) {
      const normalized = String(sql).replace(/\s+/g, ' ').trim().toLowerCase();
      if (normalized.includes('information_schema.columns')) {
        return { rows: columns.map((column_name) => ({ column_name })) };
      }
      if (normalized.startsWith('select') && normalized.includes('advisory_outputs')) {
        const matched = values[0] ? rows.filter((r) => r.id === values[0]) : rows;
        return { rows: matched };
      }
      if (normalized.startsWith('update bigsister.advisory_outputs')) {
        writes.push({ sql: normalized, values });
        const row = rows.find((r) => r.id === values[0]);
        return { rows: row ? [{ ...row, promoted: true }] : [] };
      }
      if (normalized.startsWith('insert into bigsister.agent_logs')) {
        writes.push({ sql: 'agent_logs', values });
        return { rows: [] };
      }
      throw new Error(`Unexpected query: ${normalized}`);
    },
  };
}

const sampleRow = {
  id: 4,
  project_slug: 'sitevector',
  advisor: 'grok',
  question: 'How should stop-sign confidence be scored?',
  response: 'A long advisory answer.',
  promoted: false,
  created_at: new Date('2026-07-26T16:34:58Z'),
};

test('the lane refuses to write anything when the confirmation is wrong', async () => {
  const client = fakeClient({ columns: Object.keys(sampleRow), rows: [sampleRow] });
  const lane = createAdvisoryLane({ client });
  await assert.rejects(
    lane.review({ ...approval, confirmation: 'yes' }),
    AdvisoryApprovalError,
  );
  assert.deepEqual(client.writes, [], 'a refused review must not write anything');
});

test('a confirmed promotion writes the row and records who did it', async () => {
  const client = fakeClient({ columns: Object.keys(sampleRow), rows: [sampleRow] });
  const lane = createAdvisoryLane({ client });
  const result = await lane.review(approval);

  assert.equal(result.decision, 'PROMOTED');
  assert.equal(result.reviewer, 'Troy');
  assert.equal(client.writes.length, 2, 'expected the row update plus the attribution log');

  const log = client.writes.find((write) => write.sql === 'agent_logs');
  assert.ok(log, 'attribution was not written to agent_logs');
  const detail = log.values[2];
  assert.equal(detail.reviewed_by, 'Troy');
  assert.equal(detail.outcome, 'success');
  assert.equal(detail.advisory_id, 4);
  assert.ok(detail.review_note.length >= MINIMUM_NOTE_LENGTH);
  // Pre-migration the lane must say which shape it wrote, so a later reader
  // knows the row itself carries no reviewer.
  assert.equal(detail.schema_mode, 'legacy_promoted_boolean');
});

test('listing surfaces whether the review migration has been applied', async () => {
  const client = fakeClient({ columns: Object.keys(sampleRow), rows: [sampleRow] });
  const lane = createAdvisoryLane({ client });
  const result = await lane.list({ state: 'unreviewed' });
  assert.equal(result.capabilities.hasReviewState, false);
  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0].advisor, 'grok');
});

test('a lane pointed at the wrong endpoint says so instead of returning nothing', async () => {
  const client = fakeClient({ columns: [], rows: [] });
  const lane = createAdvisoryLane({ client });
  await assert.rejects(lane.list({}), /different\s+Neon endpoint/i);
});
