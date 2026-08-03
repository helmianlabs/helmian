import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const connectionString = String(process.env.HELMION_HERALD_DATABASE_URL ?? '').trim();
if (!connectionString) throw new Error('HELMION_HERALD_DATABASE_URL is not configured.');

const here = dirname(fileURLToPath(import.meta.url));
const migration = await readFile(resolve(here, '../../../sql/herald-account-control.sql'), 'utf8');
const expected = [
  'herald_accounts',
  'herald_desktop_enrollments',
  'herald_enrollment_confirmation_limits',
  'herald_registered_desktops',
  'herald_account_sessions',
  'herald_control_grants',
  'herald_desktop_nonces',
  'herald_account_nonces',
];

const client = new pg.Client({ connectionString, connectionTimeoutMillis: 8_000 });
await client.connect();
try {
  await client.query('begin');
  await client.query("select pg_advisory_xact_lock(hashtext('helmian-herald-account-control-v1'))");
  await client.query(migration);
  const result = await client.query(
    `select relname from pg_class
     where relkind='r' and relname = any($1::text[])
     order by relname`, [expected],
  );
  if (result.rows.length !== expected.length) {
    throw new Error('Herald account-control migration verification did not find every expected table.');
  }
  await client.query('commit');
  process.stdout.write(`Herald account-control migration verified (${result.rows.length} tables).\n`);
} catch (error) {
  await client.query('rollback').catch(() => {});
  throw error;
} finally { await client.end(); }
