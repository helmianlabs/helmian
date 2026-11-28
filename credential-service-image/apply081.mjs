import pg from 'pg';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
const sql = readFileSync('/app/sql081.sql', 'utf8');
const canonical = sql.replace(/\r\n/g, '\n');
const checksum = createHash('sha256').update(canonical).digest('hex');
const client = new pg.Client({ connectionString: process.env.HELMION_DATABASE_URL });
await client.connect();
try {
  await client.query('BEGIN');
  await client.query("SELECT pg_advisory_xact_lock(hashtext('helmion.schema_migrations'))");
  const existing = await client.query('SELECT version, checksum FROM helmion.schema_migrations WHERE version = $1', ['81']);
  if (existing.rows.length) {
    console.log('ALREADY APPLIED, checksum match:', existing.rows[0].checksum === checksum);
    await client.query('ROLLBACK');
  } else {
    await client.query(canonical);
    await client.query('INSERT INTO helmion.schema_migrations (version, name, checksum) VALUES ($1, $2, $3)', ['81', 'connector_oauth_pending_dcr', checksum]);
    await client.query('COMMIT');
    console.log('APPLIED 081');
  }
  const cols = await client.query("SELECT column_name FROM information_schema.columns WHERE table_schema='helmion' AND table_name='connector_oauth_pending' AND column_name IN ('client_secret','token_endpoint','token_endpoint_auth_method') ORDER BY column_name");
  console.log('COLUMNS:', cols.rows.map(r => r.column_name).join(','));
} catch (e) {
  await client.query('ROLLBACK').catch(() => {});
  console.log('FAILED:', e.message);
} finally { await client.end(); }
