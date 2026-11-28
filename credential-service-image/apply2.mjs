import pg from 'pg';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
const jobs = [
  { version: '80', name: 'connector_mcp_local_entries', file: '/app/sqlA.sql', probe: "SELECT column_name FROM information_schema.columns WHERE table_schema='helmion' AND table_name='connector_entries' AND column_name IN ('installed_path','config_snippet','baseline_fingerprint') ORDER BY column_name" },
  { version: '82', name: 'workspace_plugins', file: '/app/sqlB.sql', probe: "SELECT table_name FROM information_schema.tables WHERE table_schema='helmion' AND table_name='workspace_plugins'" },
];
const client = new pg.Client({ connectionString: process.env.HELMION_DATABASE_URL });
await client.connect();
for (const job of jobs) {
  const sql = readFileSync(job.file, 'utf8');
  const canonical = sql.replace(/\r\n/g, '\n');
  const checksum = createHash('sha256').update(canonical).digest('hex');
  try {
    await client.query('BEGIN');
    await client.query("SELECT pg_advisory_xact_lock(hashtext('helmion.schema_migrations'))");
    const existing = await client.query('SELECT checksum FROM helmion.schema_migrations WHERE version = $1', [job.version]);
    if (existing.rows.length) {
      console.log(job.version, 'ALREADY APPLIED, checksum match:', existing.rows[0].checksum === checksum);
      await client.query('ROLLBACK');
    } else {
      await client.query(canonical);
      await client.query('INSERT INTO helmion.schema_migrations (version, name, checksum) VALUES ($1, $2, $3)', [job.version, job.name, checksum]);
      await client.query('COMMIT');
      console.log(job.version, 'APPLIED');
    }
    const probe = await client.query(job.probe);
    console.log(job.version, 'PROBE:', JSON.stringify(probe.rows));
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    console.log(job.version, 'FAILED:', e.message);
  }
}
await client.end();
