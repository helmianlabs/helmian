import { createHash, randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  assertExpectedNeonEndpoint,
  describeDatabaseTarget,
} from '../core/database-target.mjs';
import {
  HumanConfirmationRequiredError,
  handoffActionHash,
  normalizeHumanConfirmationClaims,
  verifyHumanConfirmationAssertion,
} from '../core/human-confirmation.mjs';
import {
  assertResolutionEvidence,
  classifyOperation,
  consensusStatus,
} from '../core/governance.mjs';
import {
  UnregisteredGovernanceActionError,
  assertActionHashMatches,
  assertOperationShape,
  governanceActionHash,
} from '../core/advisory-action.mjs';
import {
  IdempotencyConflictError,
  LeaseAuthorizationError,
  LeaseConflictError,
  buildMaestroHandoff,
  canonicalJson,
  normalizeCheckpoint,
  normalizeCoordinatorId,
  normalizeInstanceId,
  operationFingerprint,
  requireIdempotencyKey,
} from '../core/maestro.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDirectory = join(here, '..', '..', 'sql');
const MIGRATION_LOCK_NAME = 'helmion.schema_migrations';

// This deliberately names only schema prerequisites. It is not a product
// feature switch: callers must still request an exact, ordered migration set.
// A prerequisite may be included in that set or already match the ledger.
const EXPLICIT_MIGRATION_PREREQUISITES = Object.freeze({
  '001': [], '002': ['001'], '003': ['001'], '004': ['001'],
  '005': ['004'], '006': ['004'], '007': ['004'], '008': ['004'],
  '009': ['004'], '010': ['004'], '011': ['004'], '012': ['004'],
  '013': ['004'], '014': ['013'], '015': ['010'], '016': ['004'],
  '017': ['004'], '018': ['004'], '019': ['004'], '020': ['004'],
  '021': ['004'], '022': ['009'], '023': ['010'], '024': ['004'],
  '025': ['004'], '026': ['004'], '030': [], '031': ['004'],
  '032': ['004'], '033': ['004'], '034': ['004'], '035': ['004'],
  '036': ['013', '014'], '037': ['035'], '038': ['032', '037'], '039': ['038'], '040': ['032'],
});

function requiredText(value, field) {
  const normalized = String(value ?? '').trim();
  if (!normalized) throw new TypeError(`${field} is required`);
  return normalized;
}

function normalizeLeaseTtl(value) {
  const ttlSeconds = Number(value ?? 900);
  if (!Number.isInteger(ttlSeconds) || ttlSeconds < 30 || ttlSeconds > 86_400) {
    throw new TypeError('ttlSeconds must be an integer between 30 and 86400');
  }
  return ttlSeconds;
}

function normalizeProjectSlug(value) {
  const projectSlug = requiredText(value, 'projectSlug');
  if (projectSlug.length > 200) throw new TypeError('projectSlug must be 200 characters or fewer');
  return projectSlug;
}

function durableJson(value) {
  return JSON.parse(canonicalJson(value));
}

function publicConfirmation(row) {
  return {
    id: row.id,
    project_slug: row.project_slug,
    handoff_id: row.handoff_id,
    identity: {
      provider: row.identity_provider,
      subject: row.identity_subject,
      key_id: row.identity_key_id_snapshot,
    },
    action_hash: row.action_hash,
    issued_at: row.issued_at,
    expires_at: row.expires_at,
    recorded_at: row.recorded_at,
    consumed_at: row.consumed_at,
    consumed_by_coordinator: row.consumed_by_coordinator,
    consumed_by_instance: row.consumed_by_instance,
  };
}

async function withCommittedTransaction(pool, work) {
  const client = await pool.connect();
  try {
    await client.query('begin');
    const result = await work(client);
    await client.query('commit');
    return { durability: 'committed', ...result };
  } catch (error) {
    try {
      await client.query('rollback');
    } catch {
      // Preserve the original error. A failed rollback makes the pooled
      // connection unusable, and pg will discard it when released.
    }
    throw error;
  } finally {
    client.release();
  }
}

async function lockProject(client, projectSlug) {
  const project = await client.query(
    'select * from helmion.projects where slug=$1 for update',
    [projectSlug],
  );
  if (project.rowCount !== 1) throw new Error(`Project ${projectSlug} was not found`);
  return project.rows[0];
}

async function runIdempotentProjectOperation({
  pool,
  projectSlug,
  idempotencyKey,
  operationType,
  requestHash,
  work,
}) {
  return withCommittedTransaction(pool, async (client) => {
    await lockProject(client, projectSlug);
    const prior = await client.query(
      `select operation_type, request_hash, response
       from helmion.maestro_operations
       where project_slug=$1 and idempotency_key=$2`,
      [projectSlug, idempotencyKey],
    );
    if (prior.rowCount === 1) {
      const row = prior.rows[0];
      if (row.operation_type !== operationType || row.request_hash !== requestHash) {
        throw new IdempotencyConflictError(idempotencyKey);
      }
      return { replayed: true, data: row.response };
    }

    const data = durableJson(await work(client));
    await client.query(
      `insert into helmion.maestro_operations
         (project_slug, idempotency_key, operation_type, request_hash, response)
       values ($1,$2,$3,$4,$5::jsonb)`,
      [projectSlug, idempotencyKey, operationType, requestHash, JSON.stringify(data)],
    );
    return { replayed: false, data };
  });
}

async function requireActiveLease(client, {
  projectSlug,
  leaseToken,
  coordinatorId,
  holderInstanceId,
}) {
  const result = await client.query(
    `select *
     from helmion.maestro_leases
     where project_slug=$1
       and lease_token=$2::uuid
       and coordinator_id=$3
       and holder_instance_id=$4
       and status='ACTIVE'
       and expires_at > clock_timestamp()
     for update`,
    [projectSlug, leaseToken, coordinatorId, holderInstanceId],
  );
  if (result.rowCount !== 1) {
    throw new LeaseAuthorizationError(
      `Active lease ${leaseToken} is not held by ${coordinatorId}/${holderInstanceId}`,
      { projectSlug, leaseToken, coordinatorId, holderInstanceId },
    );
  }
  return result.rows[0];
}

// Idempotent by construction: action_hash is derived from the operation, so a
// conflict means the identical operation was already registered. Returns the
// durable row either way so a caller can tell a fresh registration from a replay.
async function insertGovernanceAction(client, {
  actionHash,
  projectSlug,
  tier,
  operation,
  diffSummary,
}) {
  const inserted = await client.query(
    `insert into helmion.governance_actions
       (action_hash, project_slug, tier, operation, diff_summary)
     values ($1,$2,$3,$4::jsonb,$5)
     on conflict (action_hash) do nothing
     returning *`,
    [actionHash, projectSlug, tier, JSON.stringify(operation), diffSummary ?? null],
  );
  if (inserted.rowCount === 1) return { inserted: true, row: inserted.rows[0] };

  const existing = await client.query(
    'select * from helmion.governance_actions where action_hash=$1',
    [actionHash],
  );
  if (existing.rowCount !== 1) {
    throw new Error(`Governance action ${actionHash} could not be registered or read back`);
  }
  return { inserted: false, row: existing.rows[0] };
}

export function canonicalizeMigrationSql(sql) {
  return String(sql).replace(/\r\n?/g, '\n');
}

async function loadMigrations() {
  const names = (await readdir(migrationsDirectory))
    .filter((name) => /^\d+_[a-z0-9_-]+\.sql$/i.test(name))
    .sort((left, right) => left.localeCompare(right));
  return Promise.all(names.map(async (name) => {
    // Git records these migrations with LF line endings, but a Windows build
    // context can materialize them as CRLF. Hashing the raw checkout made the
    // same immutable migration appear modified after a Windows-origin deploy.
    // Execute and hash one canonical representation so the migration ledger is
    // stable across Linux and Windows without weakening checksum enforcement.
    const sql = canonicalizeMigrationSql(
      await readFile(join(migrationsDirectory, name), 'utf8'),
    );
    return {
      version: name.slice(0, name.indexOf('_')),
      name,
      sql,
      checksum: createHash('sha256').update(sql).digest('hex'),
    };
  }));
}

/** Read-only release manifest; never opens a database or returns migration SQL. */
export async function listExpectedMigrationManifest() {
  return (await loadMigrations()).map(({ version, name, checksum }) => ({
    version,
    name,
    checksum,
  }));
}

async function applyMigration(pool, migration) {
  return withCommittedTransaction(pool, async (client) => {
    await client.query('select pg_advisory_xact_lock(hashtext($1))', [MIGRATION_LOCK_NAME]);
    await client.query('create schema if not exists helmion');
    await client.query(
      `create table if not exists helmion.schema_migrations (
         version text primary key,
         name text not null unique,
         checksum text not null,
         applied_at timestamptz not null default clock_timestamp()
       )`,
    );
    const existing = await client.query(
      'select name, checksum from helmion.schema_migrations where version=$1',
      [migration.version],
    );
    if (existing.rowCount === 1) {
      const row = existing.rows[0];
      if (row.name !== migration.name || row.checksum !== migration.checksum) {
        throw new Error(`Applied migration ${migration.version} does not match ${migration.name}`);
      }
      return { applied: false, migration: migration.name, receipt: { version: migration.version, name: row.name, checksum: row.checksum } };
    }
    await client.query(migration.sql);
    await client.query(
      `insert into helmion.schema_migrations(version, name, checksum)
       values ($1,$2,$3)`,
      [migration.version, migration.name, migration.checksum],
    );
    const receipt = await client.query(
      'select name, checksum from helmion.schema_migrations where version=$1',
      [migration.version],
    );
    if (receipt.rowCount !== 1 || receipt.rows[0].name !== migration.name || receipt.rows[0].checksum !== migration.checksum) {
      throw new Error(`Applied migration ${migration.version} did not produce a matching durable receipt`);
    }
    return { applied: true, migration: migration.name, receipt: { version: migration.version, name: receipt.rows[0].name, checksum: receipt.rows[0].checksum } };
  });
}

async function readMigrationLedger(pool, versions) {
  const client = await pool.connect();
  try {
    const rows = new Map();
    for (const version of versions) {
      const result = await client.query(
        'select name, checksum from helmion.schema_migrations where version=$1',
        [version],
      );
      if (result.rowCount === 1) rows.set(version, result.rows[0]);
    }
    return rows;
  } catch (error) {
    throw new Error(`Scoped migration requires a readable Helmion migration ledger: ${error.message}`);
  } finally {
    client.release();
  }
}

async function resolveExplicitMigrationSet(pool, requestedVersions) {
  if (!Array.isArray(requestedVersions) || requestedVersions.length === 0) {
    throw new TypeError('Scoped migration requires a non-empty explicit version allowlist');
  }
  const manifest = await loadMigrations();
  const byVersion = new Map(manifest.map((migration, index) => [migration.version, { ...migration, index }]));
  const versions = requestedVersions.map((version) => String(version ?? '').trim());
  if (versions.some((version) => version.length === 0)) throw new TypeError('Scoped migration version is required');
  if (new Set(versions).size !== versions.length) throw new TypeError('Scoped migration allowlist contains a duplicate version');
  const selected = versions.map((version) => {
    const migration = byVersion.get(version);
    if (!migration) throw new TypeError(`Scoped migration version ${version} is not in the checked-in manifest`);
    return migration;
  });
  if (selected.some((migration, index) => index > 0 && migration.index <= selected[index - 1].index)) {
    throw new TypeError('Scoped migration allowlist must be in checked-in manifest order');
  }
  const unknownPolicy = selected.find((migration) => !(migration.version in EXPLICIT_MIGRATION_PREREQUISITES));
  if (unknownPolicy) throw new TypeError(`Scoped migration ${unknownPolicy.version} has no declared prerequisite policy`);
  const selectedVersions = new Set(versions);
  const prerequisiteVersions = new Set(selected.flatMap((migration) => EXPLICIT_MIGRATION_PREREQUISITES[migration.version]));
  const ledger = await readMigrationLedger(pool, [...new Set([...versions, ...prerequisiteVersions])]);
  for (const migration of selected) {
    const row = ledger.get(migration.version);
    if (row && (row.name !== migration.name || row.checksum !== migration.checksum)) {
      throw new Error(`Applied migration ${migration.version} does not match ${migration.name}`);
    }
    for (const prerequisite of EXPLICIT_MIGRATION_PREREQUISITES[migration.version]) {
      if (selectedVersions.has(prerequisite)) continue;
      const required = byVersion.get(prerequisite);
      const rowForPrerequisite = ledger.get(prerequisite);
      if (!rowForPrerequisite || rowForPrerequisite.name !== required.name || rowForPrerequisite.checksum !== required.checksum) {
        throw new Error(`Scoped migration ${migration.version} is missing prerequisite ${prerequisite}`);
      }
    }
  }
  return selected;
}

export async function createNeonStore(
  connectionString = process.env.HELMION_DATABASE_URL,
  options = {},
) {
  const suppliedPool = options.pool ?? null;
  if (!connectionString && !suppliedPool) throw new Error('HELMION_DATABASE_URL is required');
  const target = connectionString
    ? options.expectedEndpointId
      ? assertExpectedNeonEndpoint(connectionString, options.expectedEndpointId)
      : describeDatabaseTarget(connectionString)
    : null;
  let pool = suppliedPool;
  if (!pool) {
    const { Pool } = await import('pg');
    pool = new Pool({
      connectionString,
      ssl: connectionString.includes('sslmode=disable') ? false : undefined,
    });
  }

  return {
    async inspectDatabase() {
      const [identity, schema, objects] = await Promise.all([
        pool.query(
          `select current_database() as database_name,
                  current_user as role_name,
                  current_setting('server_version') as server_version`,
        ),
        pool.query(
          `select to_regnamespace('helmion') is not null as schema_exists`,
        ),
        pool.query(
          `select c.relname as object_name, c.relkind as object_kind
           from pg_catalog.pg_class c
           join pg_catalog.pg_namespace n on n.oid=c.relnamespace
           where n.nspname='helmion'
           order by c.relname`,
        ),
      ]);
      const expectedMigrations = await loadMigrations();
      const hasMigrationTable = objects.rows.some(
        (row) => row.object_name === 'schema_migrations' && row.object_kind === 'r',
      );
      const appliedMigrations = hasMigrationTable
        ? (await pool.query(
          `select version, name, checksum, applied_at
           from helmion.schema_migrations
           order by version`,
        )).rows
        : [];
      const appliedByVersion = new Map(
        appliedMigrations.map((migration) => [migration.version, migration]),
      );
      const migrations = expectedMigrations.map((migration) => {
        const applied = appliedByVersion.get(migration.version);
        if (!applied) {
          return {
            version: migration.version,
            name: migration.name,
            checksum: migration.checksum,
            status: 'pending',
          };
        }
        const matches = applied.name === migration.name && applied.checksum === migration.checksum;
        return {
          version: migration.version,
          name: migration.name,
          checksum: migration.checksum,
          status: matches ? 'applied' : 'mismatch',
        };
      });
      const expectedVersions = new Set(expectedMigrations.map((migration) => migration.version));
      const unexpectedMigrations = appliedMigrations
        .filter((migration) => !expectedVersions.has(migration.version))
        .map(({ version, name }) => ({ version, name }));

      return {
        target,
        identity: identity.rows[0],
        helmion: {
          schemaExists: schema.rows[0].schema_exists,
          objects: objects.rows,
        },
        migrations,
        unexpectedMigrations,
        migrationsReady: (
          migrations.every((migration) => migration.status === 'applied')
          && unexpectedMigrations.length === 0
        ),
      };
    },

    async migrate() {
      const results = [];
      for (const migration of await loadMigrations()) {
        results.push(await applyMigration(pool, migration));
      }
      return results;
    },

    async migrateExplicitlyAllowedSet(versions) {
      const selected = await resolveExplicitMigrationSet(pool, versions);
      const results = [];
      for (const migration of selected) results.push(await applyMigration(pool, migration));
      const receipts = await readMigrationLedger(pool, selected.map((migration) => migration.version));
      const readBack = selected.map((migration) => {
        const receipt = receipts.get(migration.version);
        if (!receipt || receipt.name !== migration.name || receipt.checksum !== migration.checksum) {
          throw new Error(`Scoped migration ${migration.version} did not retain a matching durable receipt`);
        }
        return Object.freeze({ version: migration.version, name: receipt.name, checksum: receipt.checksum });
      });
      return Object.freeze({
        mode: 'explicit_allowlist',
        target,
        requestedVersions: Object.freeze(selected.map((migration) => migration.version)),
        results: Object.freeze(results),
        receipts: Object.freeze(readBack),
      });
    },

    async ensureProject(input) {
      const projectSlug = normalizeProjectSlug(input.projectSlug);
      const name = requiredText(input.name, 'name');
      const rootPath = input.rootPath == null ? null : requiredText(input.rootPath, 'rootPath');
      return withCommittedTransaction(pool, async (client) => {
        const inserted = await client.query(
          `insert into helmion.projects(slug, name, root_path)
           values ($1,$2,$3)
           on conflict (slug) do nothing
           returning *`,
          [projectSlug, name, rootPath],
        );
        if (inserted.rowCount === 1) {
          return { created: true, data: inserted.rows[0] };
        }
        const existing = await client.query(
          'select * from helmion.projects where slug=$1',
          [projectSlug],
        );
        if (existing.rowCount !== 1) throw new Error(`Project ${projectSlug} was not found`);
        const project = existing.rows[0];
        if (project.name !== name || project.root_path !== rootPath) {
          throw new Error(`Project ${projectSlug} already exists with different metadata`);
        }
        return { created: false, data: project };
      });
    },

    async getContext(projectSlug) {
      const [blockers, rules, context] = await Promise.all([
        pool.query(
          `select * from helmion.blockers
           where status in ('OPEN','ACTIVE','BLOCKED')
             and (project_slug = $1 or project_slug is null)
           order by severity desc, created_at`,
          [projectSlug],
        ),
        pool.query(
          `select * from helmion.autonomy_rules
           where active and (project_slug = $1 or project_slug is null)
           order by case severity when 'block' then 0 else 1 end, created_at`,
          [projectSlug],
        ),
        pool.query(
          `select key, value from helmion.context_entries
           where project_slug = $1 or project_slug is null
           order by key`,
          [projectSlug],
        ),
      ]);
      return { blockers: blockers.rows, rules: rules.rows, context: context.rows };
    },

    async listActiveBlockers(projectSlug = null) {
      const result = await pool.query(
        `select * from helmion.blockers
         where status in ('OPEN','ACTIVE','BLOCKED')
           and ($1::text is null or project_slug = $1 or project_slug is null)
         order by severity desc, created_at`,
        [projectSlug],
      );
      return result.rows;
    },

    async resolveBlocker(id, evidence) {
      assertResolutionEvidence(evidence);
      return withCommittedTransaction(pool, async (client) => {
        const result = await client.query(
          `update helmion.blockers
           set status='RESOLVED', outcome=$2, citation=$3, root_cause=$4,
               snippet=$5, lesson=$6, resolved_at=clock_timestamp()
           where id=$1 and status <> 'RESOLVED'
           returning *`,
          [
            id,
            evidence.outcome,
            evidence.citation,
            evidence.root_cause,
            evidence.snippet,
            evidence.lesson ?? null,
          ],
        );
        if (result.rowCount !== 1) throw new Error(`Open blocker ${id} was not found`);
        return { data: result.rows[0] };
      });
    },

    // The missing writer for helmion.governance_actions. Without it the NOT NULL
    // foreign key at sql/001_helmion.sql:83 made every recordReview call fail
    // 23503 and roll back (docs/archive/FLYWHEEL_AUDIT_2026-07-28.md finding #3).
    //
    // The hash is derived from the operation, never supplied, so re-registering
    // the same operation is a no-op and a different operation is a different
    // action. That is what makes "immutable action hash" (src/mcp/server.mjs:43)
    // true rather than aspirational.
    async registerGovernanceAction(input = {}) {
      const operation = assertOperationShape(input.operation);
      const actionHash = governanceActionHash(operation);
      if (input.actionHash ?? input.action_hash) {
        assertActionHashMatches(input.actionHash ?? input.action_hash, operation);
      }
      const projectSlug = input.projectSlug ?? input.project_slug ?? null;
      const { tier } = classifyOperation(operation);
      return withCommittedTransaction(pool, async (client) => {
        const data = await insertGovernanceAction(client, {
          actionHash,
          projectSlug,
          tier,
          operation,
          diffSummary: input.diffSummary ?? input.diff_summary ?? null,
        });
        return { registered: data.inserted, action_hash: actionHash, data: data.row };
      });
    },

    async recordReview(review) {
      const actionHash = requiredText(review?.action_hash, 'action_hash');
      // An optional operation lets a caller register and vote in one round trip.
      // It is still hashed, not trusted: a mismatch is rejected rather than
      // silently registering a second action nobody reviewed.
      const operation = review?.operation ?? null;
      if (operation) assertActionHashMatches(actionHash, operation);

      return withCommittedTransaction(pool, async (client) => {
        const existing = await client.query(
          'select action_hash from helmion.governance_actions where action_hash=$1',
          [actionHash],
        );
        if (existing.rowCount !== 1) {
          if (!operation) throw new UnregisteredGovernanceActionError(actionHash);
          await insertGovernanceAction(client, {
            actionHash,
            projectSlug: review.project_slug ?? review.projectSlug ?? null,
            tier: classifyOperation(operation).tier,
            operation,
            diffSummary: review.diff_summary ?? null,
          });
        }
        const result = await client.query(
          `insert into helmion.advisory_reviews
             (action_hash, advisor, decision, read_only, rationale, evidence)
           values ($1,$2,$3,$4,$5,$6)
           on conflict (action_hash, advisor) do update
             set decision=excluded.decision, read_only=excluded.read_only,
                 rationale=excluded.rationale, evidence=excluded.evidence,
                 reviewed_at=clock_timestamp()
           returning *`,
          [
            actionHash,
            String(review.advisor).toLowerCase(),
            String(review.decision).toUpperCase(),
            review.read_only === true,
            review.rationale ?? null,
            review.evidence ?? {},
          ],
        );
        return { data: result.rows[0] };
      });
    },

    async getConsensus(actionHashInput, operation) {
      const actionHash = requiredText(actionHashInput, 'actionHash');
      const [action, reviews] = await Promise.all([
        pool.query(
          'select * from helmion.governance_actions where action_hash=$1',
          [actionHash],
        ),
        pool.query(
          'select * from helmion.advisory_reviews where action_hash=$1',
          [actionHash],
        ),
      ]);

      const registered = action.rowCount === 1;
      // The registered operation is authoritative. A caller-supplied operation
      // is only ever a cross-check: if it does not hash to this action, the
      // votes on file were cast for something else and must not be inherited.
      if (registered && operation != null) assertActionHashMatches(actionHash, operation);
      if (!registered && operation == null) {
        throw new UnregisteredGovernanceActionError(actionHash);
      }

      const status = consensusStatus({
        operation: registered ? action.rows[0].operation : operation,
        actionHash,
        reviews: reviews.rows,
      });
      return {
        ...status,
        action_registered: registered,
        ...(registered ? { action_state: action.rows[0].state } : {
          // Tier A short-circuits before reviews are consulted, so say plainly
          // that this verdict rests on an operation nobody pinned down.
          unregistered_action_note:
            'No helmion.governance_actions row exists for this hash, so this verdict '
            + 'rests on the caller-supplied operation and no advisor vote can be '
            + 'recorded against it yet. Register the action first.',
        }),
      };
    },

    async getMaestroProjectState(projectSlugInput) {
      const projectSlug = normalizeProjectSlug(projectSlugInput);
      const [project, activeLease, checkpoint, handoff] = await Promise.all([
        pool.query('select * from helmion.projects where slug=$1', [projectSlug]),
        pool.query(
          `select * from helmion.maestro_leases
           where project_slug=$1 and status='ACTIVE' and expires_at > clock_timestamp()
           order by acquired_at desc, id desc limit 1`,
          [projectSlug],
        ),
        pool.query(
          `select * from helmion.project_checkpoints
           where project_slug=$1
           order by created_at desc, id desc limit 1`,
          [projectSlug],
        ),
        pool.query(
          `select * from helmion.maestro_handoffs
           where project_slug=$1
           order by created_at desc, id desc limit 1`,
          [projectSlug],
        ),
      ]);
      if (project.rowCount !== 1) throw new Error(`Project ${projectSlug} was not found`);
      return {
        project: project.rows[0],
        active_lease: activeLease.rows[0] ?? null,
        latest_checkpoint: checkpoint.rows[0] ?? null,
        latest_handoff: handoff.rows[0] ?? null,
      };
    },

    async getLatestMaestroHandoff(projectSlugInput) {
      const projectSlug = normalizeProjectSlug(projectSlugInput);
      const result = await pool.query(
        `select * from helmion.maestro_handoffs
         where project_slug=$1
         order by created_at desc, id desc limit 1`,
        [projectSlug],
      );
      if (result.rowCount === 0) return null;
      const row = result.rows[0];
      return {
        ...row.payload,
        id: row.id,
        confirmed_by: row.confirmed_by,
        confirmed_at: row.confirmed_at,
      };
    },

    async recordHumanConfirmation(input) {
      const projectSlug = normalizeProjectSlug(input.projectSlug);
      const targetHandoffId = requiredText(input.handoffId, 'handoffId');
      const operation = durableJson(input.operation);
      if (classifyOperation(operation).tier !== 'B') {
        throw new TypeError('Human confirmations are accepted only for Tier B actions');
      }
      const actionHash = handoffActionHash({
        projectSlug,
        handoffId: targetHandoffId,
        operation,
      });
      const claims = normalizeHumanConfirmationClaims(input.assertion?.claims);

      return withCommittedTransaction(pool, async (client) => {
        await lockProject(client, projectSlug);
        const handoff = await client.query(
          `select id from helmion.maestro_handoffs
           where id=$1 and project_slug=$2
           for update`,
          [targetHandoffId, projectSlug],
        );
        if (handoff.rowCount !== 1) {
          throw new Error(`Handoff ${targetHandoffId} was not found for ${projectSlug}`);
        }
        const identity = await client.query(
          `select * from helmion.human_identity_keys
           where provider=$1 and subject=$2 and key_id=$3
             and algorithm='Ed25519'
             and active
             and revoked_at is null
             and valid_from <= clock_timestamp()
             and (valid_until is null or valid_until > clock_timestamp())
           for share`,
          [claims.provider, claims.subject, claims.key_id],
        );
        if (identity.rowCount !== 1) {
          throw new HumanConfirmationRequiredError(
            'The signed confirmer does not have an active trusted identity key',
          );
        }
        const clock = await client.query('select clock_timestamp() as now');
        const verified = verifyHumanConfirmationAssertion({
          assertion: input.assertion,
          trustedIdentity: identity.rows[0],
          expected: {
            projectSlug,
            handoffId: targetHandoffId,
            actionHash,
          },
          now: clock.rows[0].now,
        });

        const prior = await client.query(
          `select * from helmion.human_handoff_confirmations
           where identity_key_id=$1 and nonce=$2
           for update`,
          [identity.rows[0].id, verified.claims.nonce],
        );
        if (prior.rowCount === 1) {
          if (prior.rows[0].assertion_hash !== verified.assertionHash) {
            throw new IdempotencyConflictError(verified.claims.nonce);
          }
          return { replayed: true, data: publicConfirmation(prior.rows[0]) };
        }

        const inserted = await client.query(
          `insert into helmion.human_handoff_confirmations
             (project_slug, handoff_id, identity_key_id, identity_provider,
              identity_subject, identity_key_id_snapshot, nonce, action_hash,
              action, claims, signature, assertion_hash, issued_at, expires_at)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10::jsonb,$11,$12,$13,$14)
           returning *`,
          [
            projectSlug,
            targetHandoffId,
            identity.rows[0].id,
            verified.identity.provider,
            verified.identity.subject,
            verified.identity.key_id,
            verified.claims.nonce,
            actionHash,
            JSON.stringify(operation),
            JSON.stringify(verified.claims),
            verified.signature,
            verified.assertionHash,
            verified.claims.issued_at,
            verified.claims.expires_at,
          ],
        );
        return { replayed: false, data: publicConfirmation(inserted.rows[0]) };
      });
    },

    async consumeHumanConfirmation(input) {
      const projectSlug = normalizeProjectSlug(input.projectSlug);
      const coordinatorId = normalizeCoordinatorId(input.coordinatorId);
      const holderInstanceId = normalizeInstanceId(input.holderInstanceId);
      const leaseToken = requiredText(input.leaseToken, 'leaseToken');
      const idempotencyKey = requireIdempotencyKey(input.idempotencyKey);
      const targetHandoffId = requiredText(input.handoffId, 'handoffId');
      const operation = durableJson(input.operation);
      const classification = classifyOperation(operation);
      if (classification.tier !== 'B') {
        throw new TypeError('One-time human confirmation is required only for Tier B actions');
      }
      const actionHash = handoffActionHash({
        projectSlug,
        handoffId: targetHandoffId,
        operation,
      });
      const request = {
        projectSlug,
        coordinatorId,
        holderInstanceId,
        leaseToken,
        handoffId: targetHandoffId,
        actionHash,
        operation,
      };
      const requestHash = operationFingerprint('CONSUME_CONFIRMATION', request);

      return runIdempotentProjectOperation({
        pool,
        projectSlug,
        idempotencyKey,
        operationType: 'CONSUME_CONFIRMATION',
        requestHash,
        work: async (client) => {
          const lease = await requireActiveLease(client, request);
          const handoff = await client.query(
            `select id from helmion.maestro_handoffs
             where id=$1 and project_slug=$2 and to_lease_id=$3
             for update`,
            [targetHandoffId, projectSlug, lease.id],
          );
          if (handoff.rowCount !== 1) {
            throw new HumanConfirmationRequiredError(
              'The handoff does not target the active lease held by this coordinator',
            );
          }
          const available = await client.query(
            `select c.id
             from helmion.human_handoff_confirmations c
             join helmion.human_identity_keys k on k.id=c.identity_key_id
             where c.project_slug=$1
               and c.handoff_id=$2
               and c.action_hash=$3
               and c.action=$4::jsonb
               and c.consumed_at is null
               and c.expires_at > clock_timestamp()
               and k.active
               and k.revoked_at is null
               and k.valid_from <= clock_timestamp()
               and (k.valid_until is null or k.valid_until > clock_timestamp())
             order by c.expires_at, c.id
             for update of c skip locked
             limit 1`,
            [projectSlug, targetHandoffId, actionHash, JSON.stringify(operation)],
          );
          if (available.rowCount !== 1) {
            throw new HumanConfirmationRequiredError(
              'No matching unexpired unused human confirmation is available',
              { projectSlug, handoffId: targetHandoffId, actionHash },
            );
          }
          const consumed = await client.query(
            `update helmion.human_handoff_confirmations
             set consumed_at=clock_timestamp(),
                 consumed_by_coordinator=$2,
                 consumed_by_instance=$3
             where id=$1 and consumed_at is null
             returning *`,
            [available.rows[0].id, coordinatorId, holderInstanceId],
          );
          if (consumed.rowCount !== 1) {
            throw new HumanConfirmationRequiredError(
              'The matching human confirmation was already consumed',
            );
          }
          return {
            allowed: true,
            tier: classification.tier,
            reasons: classification.reasons,
            action_hash: actionHash,
            confirmation: publicConfirmation(consumed.rows[0]),
          };
        },
      });
    },

    async acquireMaestroLease(input) {
      const projectSlug = normalizeProjectSlug(input.projectSlug);
      const coordinatorId = normalizeCoordinatorId(input.coordinatorId);
      const holderInstanceId = normalizeInstanceId(input.holderInstanceId);
      const idempotencyKey = requireIdempotencyKey(input.idempotencyKey);
      const ttlSeconds = normalizeLeaseTtl(input.ttlSeconds);
      const request = { projectSlug, coordinatorId, holderInstanceId, ttlSeconds };
      const requestHash = operationFingerprint('ACQUIRE_LEASE', request);

      return runIdempotentProjectOperation({
        pool,
        projectSlug,
        idempotencyKey,
        operationType: 'ACQUIRE_LEASE',
        requestHash,
        work: async (client) => {
          await client.query(
            `update helmion.maestro_leases
             set status='EXPIRED', closed_at=clock_timestamp(),
                 close_reason='lease TTL elapsed'
             where project_slug=$1 and status='ACTIVE'
               and expires_at <= clock_timestamp()`,
            [projectSlug],
          );
          const active = await client.query(
            `select * from helmion.maestro_leases
             where project_slug=$1 and status='ACTIVE'
             for update`,
            [projectSlug],
          );
          if (active.rowCount > 0) {
            const lease = active.rows[0];
            throw new LeaseConflictError(
              `Project ${projectSlug} already has an active ${lease.coordinator_id} lease`,
              {
                projectSlug,
                coordinatorId: lease.coordinator_id,
                holderInstanceId: lease.holder_instance_id,
                expiresAt: lease.expires_at,
              },
            );
          }
          const inserted = await client.query(
            `insert into helmion.maestro_leases
               (lease_token, project_slug, coordinator_id, holder_instance_id, expires_at)
             values ($1::uuid,$2,$3,$4,clock_timestamp() + make_interval(secs => $5::double precision))
             returning *`,
            [randomUUID(), projectSlug, coordinatorId, holderInstanceId, ttlSeconds],
          );
          return inserted.rows[0];
        },
      });
    },

    async createProjectCheckpoint(input) {
      const projectSlug = normalizeProjectSlug(input.projectSlug);
      const coordinatorId = normalizeCoordinatorId(input.coordinatorId);
      const holderInstanceId = normalizeInstanceId(input.holderInstanceId);
      const leaseToken = requiredText(input.leaseToken, 'leaseToken');
      const idempotencyKey = requireIdempotencyKey(input.idempotencyKey);
      const checkpoint = normalizeCheckpoint(input.checkpoint);
      const request = {
        projectSlug,
        coordinatorId,
        holderInstanceId,
        leaseToken,
        checkpoint,
      };
      const requestHash = operationFingerprint('CREATE_CHECKPOINT', request);

      return runIdempotentProjectOperation({
        pool,
        projectSlug,
        idempotencyKey,
        operationType: 'CREATE_CHECKPOINT',
        requestHash,
        work: async (client) => {
          const lease = await requireActiveLease(client, request);
          const result = await client.query(
            `insert into helmion.project_checkpoints
               (project_slug, lease_id, coordinator_id, work_completed,
                files_changed, test_results, open_blockers, unresolved_risks,
                next_safe_action)
             values ($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7::jsonb,$8::jsonb,$9)
             returning *`,
            [
              projectSlug,
              lease.id,
              coordinatorId,
              checkpoint.work_completed,
              JSON.stringify(checkpoint.files_changed),
              JSON.stringify(checkpoint.test_results),
              JSON.stringify(checkpoint.open_blockers),
              JSON.stringify(checkpoint.unresolved_risks),
              checkpoint.next_safe_action,
            ],
          );
          return result.rows[0];
        },
      });
    },

    async releaseMaestroLease(input) {
      const projectSlug = normalizeProjectSlug(input.projectSlug);
      const coordinatorId = normalizeCoordinatorId(input.coordinatorId);
      const holderInstanceId = normalizeInstanceId(input.holderInstanceId);
      const leaseToken = requiredText(input.leaseToken, 'leaseToken');
      const idempotencyKey = requireIdempotencyKey(input.idempotencyKey);
      const reason = requiredText(input.reason, 'reason');
      const request = {
        projectSlug,
        coordinatorId,
        holderInstanceId,
        leaseToken,
        reason,
      };
      const requestHash = operationFingerprint('RELEASE_LEASE', request);

      return runIdempotentProjectOperation({
        pool,
        projectSlug,
        idempotencyKey,
        operationType: 'RELEASE_LEASE',
        requestHash,
        work: async (client) => {
          const lease = await requireActiveLease(client, request);
          const result = await client.query(
            `update helmion.maestro_leases
             set status='RELEASED', closed_at=clock_timestamp(), close_reason=$2
             where id=$1
             returning *`,
            [lease.id, reason],
          );
          return result.rows[0];
        },
      });
    },

    async transferMaestroLease(input) {
      const projectSlug = normalizeProjectSlug(input.projectSlug);
      const coordinatorId = normalizeCoordinatorId(input.coordinatorId);
      const holderInstanceId = normalizeInstanceId(input.holderInstanceId);
      const leaseToken = requiredText(input.leaseToken, 'leaseToken');
      const idempotencyKey = requireIdempotencyKey(input.idempotencyKey);
      const toCoordinatorId = normalizeCoordinatorId(input.toCoordinatorId);
      const toHolderInstanceId = normalizeInstanceId(input.toHolderInstanceId);
      const switchedBy = requiredText(input.switchedBy, 'switchedBy');
      const ttlSeconds = normalizeLeaseTtl(input.ttlSeconds);
      const checkpointId = input.checkpointId == null ? null : String(input.checkpointId);
      const incompleteReason = input.incompleteReason == null
        ? null
        : requiredText(input.incompleteReason, 'incompleteReason');
      if (toCoordinatorId === coordinatorId && toHolderInstanceId === holderInstanceId) {
        throw new TypeError('A lease transfer must select a different coordinator or instance');
      }
      if (checkpointId == null && incompleteReason == null) {
        throw new TypeError('checkpointId or incompleteReason is required for a lease transfer');
      }

      const request = {
        projectSlug,
        coordinatorId,
        holderInstanceId,
        leaseToken,
        toCoordinatorId,
        toHolderInstanceId,
        switchedBy,
        ttlSeconds,
        checkpointId,
        incompleteReason,
      };
      const requestHash = operationFingerprint('TRANSFER_LEASE', request);

      return runIdempotentProjectOperation({
        pool,
        projectSlug,
        idempotencyKey,
        operationType: 'TRANSFER_LEASE',
        requestHash,
        work: async (client) => {
          const fromLease = await requireActiveLease(client, request);
          let checkpoint = null;
          if (checkpointId != null) {
            const checkpointResult = await client.query(
              `select * from helmion.project_checkpoints
               where id=$1 and project_slug=$2 and lease_id=$3`,
              [checkpointId, projectSlug, fromLease.id],
            );
            if (checkpointResult.rowCount !== 1) {
              throw new Error(
                `Checkpoint ${checkpointId} does not belong to active lease ${leaseToken}`,
              );
            }
            checkpoint = checkpointResult.rows[0];
          }

          const [blockers, context, rules, occurred] = await Promise.all([
            client.query(
              `select * from helmion.blockers
               where status in ('OPEN','ACTIVE','BLOCKED')
                 and (project_slug=$1 or project_slug is null)
               order by severity desc, id`,
              [projectSlug],
            ),
            client.query(
              `select key, value, updated_at from helmion.context_entries
               where project_slug=$1 or project_slug is null
               order by key`,
              [projectSlug],
            ),
            client.query(
              `select * from helmion.autonomy_rules
               where active and (project_slug=$1 or project_slug is null)
               order by severity desc, id`,
              [projectSlug],
            ),
            client.query('select clock_timestamp() as occurred_at'),
          ]);

          await client.query(
            `update helmion.maestro_leases
             set status='TRANSFERRED', closed_at=clock_timestamp(),
                 close_reason=$2
             where id=$1`,
            [fromLease.id, `transferred to ${toCoordinatorId}/${toHolderInstanceId}`],
          );
          const insertedLease = await client.query(
            `insert into helmion.maestro_leases
               (lease_token, project_slug, coordinator_id, holder_instance_id, expires_at)
             values ($1::uuid,$2,$3,$4,clock_timestamp() + make_interval(secs => $5::double precision))
             returning *`,
            [randomUUID(), projectSlug, toCoordinatorId, toHolderInstanceId, ttlSeconds],
          );
          const toLease = insertedLease.rows[0];
          const handoff = buildMaestroHandoff({
            projectSlug,
            fromLease,
            toLease,
            checkpoint,
            sharedState: {
              blockers: blockers.rows,
              context: context.rows,
              rules: rules.rows,
            },
            switchedBy,
            switchedAt: occurred.rows[0].occurred_at,
            incompleteReason,
          });
          const insertedHandoff = await client.query(
            `insert into helmion.maestro_handoffs
               (project_slug, from_lease_id, to_lease_id, checkpoint_id,
                from_coordinator_id, to_coordinator_id, status, warning,
                requires_human_confirmation, payload, switched_by)
             values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11)
             returning *`,
            [
              projectSlug,
              fromLease.id,
              toLease.id,
              checkpoint?.id ?? null,
              coordinatorId,
              toCoordinatorId,
              handoff.status,
              handoff.warning,
              handoff.requires_human_confirmation,
              JSON.stringify(handoff),
              switchedBy,
            ],
          );
          return {
            lease: toLease,
            handoff: {
              ...handoff,
              id: insertedHandoff.rows[0].id,
            },
          };
        },
      });
    },

    async recordTelemetry(input) {
      const eventType = requiredText(input.eventType, 'eventType');
      const result = await pool.query(
        `insert into helmion.telemetry_events
           (project_slug, coordinator_id, holder_instance_id, event_type, payload)
         values ($1,$2,$3,$4,$5::jsonb)
         returning id, created_at`,
        [
          input.projectSlug == null ? null : normalizeProjectSlug(input.projectSlug),
          input.coordinatorId == null ? null : normalizeCoordinatorId(input.coordinatorId),
          input.holderInstanceId ?? null,
          eventType,
          JSON.stringify(input.payload ?? {}),
        ],
      );
      return {
        ok: true,
        recorded: true,
        id: result.rows[0].id,
        created_at: result.rows[0].created_at,
      };
    },

    async close() {
      if (!suppliedPool) await pool.end();
    },
  };
}
