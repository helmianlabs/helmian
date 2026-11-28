import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
const url = process.env.HELMION_DATABASE_URL || process.env.DATABASE_URL;
const { default: pg } = await import('pg');
const pool = new pg.Pool({ connectionString: url, ssl: { rejectUnauthorized: false }, max: 1 });
let token = null;
try { const j = JSON.parse(readFileSync('/opt/helmian-agentbox/worker/device-token.json', 'utf8')); token = j.token || j.deviceToken || null; console.log('worker token file keys:', Object.keys(j).join(','), '| stamped tenant:', j.tenantId || j.tenant_id || 'none'); } catch (e) { console.log('token file read failed:', e.code || e.message); }
if (token) {
  const h = createHash('sha256').update(String(token)).digest('hex');
  const r = await pool.query('select id, tenant_id, subject, label, linked_at, last_used_at from helmion.desktop_links where token_hash=', [h]);
  console.log('WORKER LINK MATCH:', JSON.stringify(r.rows));
} else console.log('no token value found in file');
await pool.end();
