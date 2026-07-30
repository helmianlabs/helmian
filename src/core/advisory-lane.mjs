// The advisory lane's READ path.
//
// docs/FLYWHEEL_AUDIT_2026-07-28.md finding #2: bigsister.advisory_outputs gets
// rows (bigsister_neon_log.mjs:48-51) and nothing consumes them. The only reader
// on disk, scripts/neon/_verify_advisory.mjs, has no caller. A store nothing
// reads is a diary.
//
// CLAUDE.md Rule 0.27 governs what may happen to a row once read: "advisory
// agents never write decisions, curated context, blockers, or sprint status
// directly... I review their output and decide what (if anything) gets promoted
// into the trusted layer." So promotion here is never automatic and never
// implicit — it requires a named human, a written reason, and an exact typed
// confirmation. There is deliberately no "promote all" and no default reviewer.
//
// Everything above the createAdvisoryLane factory is pure and DB-free so the
// approval rules can be tested without touching Neon.

// Verified against the live CHECK constraint 2026-07-28:
//   advisory_outputs_advisor_check CHECK (advisor = ANY (ARRAY['grok','gemini','chatgpt']))
export const ADVISORY_ADVISORS = Object.freeze(['grok', 'gemini', 'chatgpt']);

export const ADVISORY_STATES = Object.freeze(['unreviewed', 'promoted', 'rejected', 'all']);

// A note short enough to be typed without thinking is not a review. Rule 0.29:
// a lesson that names nothing does not change behavior.
export const MINIMUM_NOTE_LENGTH = 20;

export class AdvisoryApprovalError extends Error {
  constructor(message) {
    super(message);
    this.name = 'AdvisoryApprovalError';
  }
}

export function normalizeState(value) {
  const state = String(value ?? 'unreviewed').trim().toLowerCase();
  if (!ADVISORY_STATES.includes(state)) {
    throw new TypeError(`state must be one of ${ADVISORY_STATES.join(', ')}`);
  }
  return state;
}

export function normalizeId(value) {
  const id = Number(value);
  if (!Number.isInteger(id) || id <= 0) {
    throw new TypeError('advisory row id must be a positive integer');
  }
  return id;
}

// The exact phrase the human must type. Bound to the row id so a confirmation
// cannot be reused for a different row, and to the verb so a reject cannot be
// replayed as a promote.
export function confirmationPhrase(decision, id) {
  return `${decision === 'PROMOTED' ? 'PROMOTE' : 'REJECT'} ${normalizeId(id)}`;
}

export function assertReviewApproval({ id, decision, reviewer, note, confirmation }) {
  if (!['PROMOTED', 'REJECTED'].includes(decision)) {
    throw new TypeError('decision must be PROMOTED or REJECTED');
  }
  const named = String(reviewer ?? '').trim();
  if (!named) {
    throw new AdvisoryApprovalError(
      'A review must name the human who made it (--reviewer). Rule 0.27 promotion '
      + 'is a human decision, so an anonymous promotion is not a promotion.',
    );
  }
  const written = String(note ?? '').trim();
  if (written.length < MINIMUM_NOTE_LENGTH) {
    throw new AdvisoryApprovalError(
      `A review must say why in at least ${MINIMUM_NOTE_LENGTH} characters (--note). `
      + `Got ${written.length}.`,
    );
  }
  const expected = confirmationPhrase(decision, id);
  if (String(confirmation ?? '').trim() !== expected) {
    throw new AdvisoryApprovalError(
      `Confirmation did not match. Expected exactly "${expected}". Nothing was written.`,
    );
  }
  return { id: normalizeId(id), decision, reviewer: named, note: written };
}

export function summarizeRow(row, width = 96) {
  const text = String(row.response ?? '').replace(/\s+/g, ' ').trim();
  return {
    id: row.id,
    project_slug: row.project_slug,
    advisor: row.advisor,
    created_at: row.created_at,
    promoted: row.promoted === true,
    review_decision: row.review_decision ?? null,
    reviewed_by: row.reviewed_by ?? null,
    question: String(row.question ?? '').replace(/\s+/g, ' ').trim(),
    response_chars: text.length,
    response_preview: text.length > width ? `${text.slice(0, width - 1)}…` : text,
  };
}

// The review columns arrive with a migration that HAS NOT BEEN WRITTEN. This
// comment, and the error below, used to tell the operator to apply a migration
// file under sql/bigsister/ as though it were sitting in the repo. There is no
// such directory: sql/ holds 001_helmion.sql, 002_maestro_phase_one.sql and
// 003_human_confirmations.sql and nothing else, so anyone following that
// instruction went looking for a file nobody had written. Naming a remediation
// that does not exist is worse than naming none — it costs the reader the trip.
//
// The DDL text is real and it is written down: docs/FLYWHEEL_AUDIT_2026-07-28.md
// section 6.5. It was not turned into a migration file because
// hook_autonomy_boundary.ps1 classifies that as a Tier B schema change needing
// Troy, and that gate has not been bypassed.
//
// None of this stops the lane working. It falls back to the `promoted` boolean
// that already exists, and the human attribution is written to
// bigsister.agent_logs so it is never lost.
export function laneCapabilities(columnNames) {
  const columns = new Set(columnNames);
  return {
    columns,
    hasReviewState: columns.has('review_decision'),
    hasPromoted: columns.has('promoted'),
  };
}

export function buildListQuery({ state, projectSlug = null, limit = 20, capabilities }) {
  const normalized = normalizeState(state);
  const values = [projectSlug];
  const filters = ['($1::text is null or project_slug = $1)'];

  if (capabilities.hasReviewState) {
    if (normalized === 'unreviewed') filters.push('review_decision is null');
    if (normalized === 'promoted') filters.push(`review_decision = 'PROMOTED'`);
    if (normalized === 'rejected') filters.push(`review_decision = 'REJECTED'`);
  } else if (normalized === 'unreviewed') {
    filters.push('promoted = false');
  } else if (normalized === 'promoted') {
    filters.push('promoted = true');
  } else if (normalized === 'rejected') {
    // Pre-migration there is no way to record a rejection on the row itself.
    // Say so rather than quietly returning the wrong set.
    throw new AdvisoryApprovalError(
      'This database has no review_decision column yet, so rejections are not '
      + 'recorded on the row. The migration that adds it has not been written — it is '
      + 'a schema change and needs Troy. The exact DDL is in '
      + 'docs/FLYWHEEL_AUDIT_2026-07-28.md section 6.5. Until it is applied, list with '
      + '--state unreviewed.',
    );
  }

  const selected = ['id', 'project_slug', 'advisor', 'question', 'response', 'created_at'];
  if (capabilities.hasPromoted) selected.push('promoted');
  if (capabilities.hasReviewState) {
    selected.push('review_decision', 'reviewed_by', 'review_note', 'reviewed_at');
  }

  const bounded = Math.max(1, Math.min(Number(limit) || 20, 200));
  return {
    text: `select ${selected.join(', ')} from bigsister.advisory_outputs
           where ${filters.join(' and ')}
           order by created_at asc, id asc
           limit ${bounded}`,
    values,
  };
}

export function buildReviewUpdate({ id, decision, reviewer, note, capabilities }) {
  const rowId = normalizeId(id);
  if (capabilities.hasReviewState) {
    return {
      text: `update bigsister.advisory_outputs
                set review_decision = $2,
                    reviewed_by = $3,
                    review_note = $4,
                    reviewed_at = now(),
                    promoted = ($2 = 'PROMOTED'),
                    promoted_at = case when $2 = 'PROMOTED' then now() else null end
              where id = $1 and review_decision is null
              returning *`,
      values: [rowId, decision, reviewer, note],
    };
  }
  // Legacy shape. Only a promotion is representable on the row; a rejection is
  // recorded in agent_logs by the caller.
  return {
    text: `update bigsister.advisory_outputs
              set promoted = $2
            where id = $1 and promoted = false
            returning *`,
    values: [rowId, decision === 'PROMOTED'],
  };
}

export function createAdvisoryLane({ client }) {
  let capabilities = null;

  async function loadCapabilities() {
    if (capabilities) return capabilities;
    const { rows } = await client.query(
      `select column_name from information_schema.columns
        where table_schema = 'bigsister' and table_name = 'advisory_outputs'`,
    );
    if (rows.length === 0) {
      throw new Error(
        'bigsister.advisory_outputs was not found on this connection. Point '
        + 'BIGSISTER_DATABASE_URL at the bigsister endpoint (it is a different '
        + 'Neon endpoint from HELMION_DATABASE_URL).',
      );
    }
    capabilities = laneCapabilities(rows.map((row) => row.column_name));
    return capabilities;
  }

  return {
    loadCapabilities,

    async list({ state = 'unreviewed', projectSlug = null, limit = 20 } = {}) {
      const caps = await loadCapabilities();
      const query = buildListQuery({ state, projectSlug, limit, capabilities: caps });
      const { rows } = await client.query(query.text, query.values);
      return {
        capabilities: { hasReviewState: caps.hasReviewState },
        state: normalizeState(state),
        rows: rows.map((row) => summarizeRow(row)),
      };
    },

    async show(idInput) {
      const id = normalizeId(idInput);
      const caps = await loadCapabilities();
      const selected = ['id', 'project_slug', 'advisor', 'question', 'response', 'created_at'];
      if (caps.hasPromoted) selected.push('promoted');
      if (caps.hasReviewState) {
        selected.push('review_decision', 'reviewed_by', 'review_note', 'reviewed_at');
      }
      const { rows } = await client.query(
        `select ${selected.join(', ')} from bigsister.advisory_outputs where id = $1`,
        [id],
      );
      if (rows.length !== 1) throw new Error(`Advisory row ${id} was not found`);
      return rows[0];
    },

    // Never call this without a human-supplied confirmation. assertReviewApproval
    // is the gate and it runs before any write.
    async review({ id, decision, reviewer, note, confirmation }) {
      const approved = assertReviewApproval({ id, decision, reviewer, note, confirmation });
      const caps = await loadCapabilities();
      const update = buildReviewUpdate({ ...approved, capabilities: caps });

      const { rows } = await client.query(update.text, update.values);
      if (rows.length !== 1) {
        throw new Error(
          `Advisory row ${approved.id} was not found, or has already been reviewed. `
          + 'Nothing was written.',
        );
      }

      // Attribution goes to agent_logs regardless of schema version, so who
      // promoted what and why survives even before the review columns exist.
      await client.query(
        `insert into bigsister.agent_logs (project_slug, source, event, detail)
         values ($1, 'claude-code', $2, $3)`,
        [
          rows[0].project_slug ?? null,
          `advisory-${approved.decision.toLowerCase()} #${approved.id}`,
          {
            outcome: approved.decision === 'PROMOTED' ? 'success' : 'rejected',
            advisory_id: approved.id,
            advisor: rows[0].advisor,
            reviewed_by: approved.reviewer,
            review_note: approved.note,
            citation: 'src/core/advisory-lane.mjs:review',
            lesson:
              'Advisory output is low-trust (Rule 0.27). This row was reviewed by a '
              + 'named human before any promotion; it was never auto-promoted.',
            schema_mode: caps.hasReviewState ? 'review_columns' : 'legacy_promoted_boolean',
          },
        ],
      );

      return { data: rows[0], decision: approved.decision, reviewer: approved.reviewer };
    },
  };
}
