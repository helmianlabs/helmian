// Mint a fresh desktop pairing code via the container DB road (same pattern as
// the 02:57Z mint + neon-check-sync-2026-11-05.mjs). Code format + hash mirror
// src/cloud/org-invites.mjs exactly: newDesktopCode() alphabet/shape, sha256 hex.
// 12h expiry (deliberate: a 10-min code cannot survive approval+resume).
// The plaintext code is printed ONCE to stdout for capture into the fired
// command; it is never written to disk here.
import pg from 'pg';
import { createHash, randomBytes } from 'node:crypto';

const url = process.env.HELMION_DATABASE_URL;
if (!url) { console.log('NO_URL'); process.exit(1); }
const host = new URL(url).hostname;
const endpoint = host.split('.')[0];
console.log('endpoint-guard:', endpoint.startsWith('ep-proud-truth-a69e8vg4') ? 'PASS' : 'FAIL');
if (!endpoint.startsWith('ep-proud-truth-a69e8vg4')) process.exit(2);

const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const b = randomBytes(8);
const s = [...b].map((x) => alphabet[x % alphabet.length]).join('');
const code = `${s.slice(0, 4)}-${s.slice(4)}`;
const sha = (v) => createHash('sha256').update(String(v)).digest('hex');

const pool = new pg.Pool({ connectionString: url });
try {
  const r = await pool.query(
    `insert into helmion.desktop_links(tenant_id, subject, code_hash, code_expires_at, label)
     values ($1, $2, $3, clock_timestamp() + interval '12 hours', $4)
     returning id, created_at, code_expires_at`,
    ['0d7ca4d3-a2f4-458a-936b-d8a002a569e0', 'user_3L5HJWjja14knkqqi8dZBHxPdQg', sha(code), 'sync repair re-fire 2026-11-05'],
  );
  console.log('minted row:', JSON.stringify(r.rows[0]));
  console.log('CODE:' + code);
} finally {
  await pool.end();
}
