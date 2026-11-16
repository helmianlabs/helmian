import pg from 'pg';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

const sql = readFileSync('/app/sql083.sql', 'utf8');
const canonical = sql.replace(/\r\n/g, '\n');
const checksum = createHash('sha256').update(canonical).digest('hex');
const client = new pg.Client({ connectionString: process.env.HELMION_DATABASE_URL });
await client.connect();
try {
  const before = await client.query(
    `select pg_get_constraintdef(oid) as def from pg_constraint where conname = 'guard_findings_source_check'`);
  console.log('BEFORE:', JSON.stringify(before.rows));
  await client.query('begin');
  await client.query(`select pg_advisory_xact_lock(hashtext('helmion.schema_migrations'))`);
  const existing = await client.query(
    `select version from helmion.schema_migrations where version = '083'`);
  if (existing.rows.length === 0) {
    await client.query(sql);
    await client.query(
      `insert into helmion.schema_migrations (version, name, checksum) values ('083', 'site_guard_finding_source', $1)`,
      [checksum]);
    console.log('APPLIED 083, checksum', checksum);
  } else {
    console.log('083 ALREADY IN LEDGER — DDL skipped');
  }
  await client.query('commit');
  const after = await client.query(
    `select pg_get_constraintdef(oid) as def from pg_constraint where conname = 'guard_findings_source_check'`);
  console.log('AFTER:', JSON.stringify(after.rows));
  const ledger = await client.query(
    `select version, name, applied_at from helmion.schema_migrations where version = '083'`);
  console.log('LEDGER:', JSON.stringify(ledger.rows));
} catch (e) {
  await client.query('rollback').catch(() => {});
  console.log('FAILED:', e.message);
  process.exitCode = 1;
} finally {
  await client.end();
}
