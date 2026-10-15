#!/usr/bin/env node
// Standalone cloud console worker. Needs HELMION_DATABASE_URL (Neon).
// Run: node bin/helmion-cloud-worker.mjs [--once]
import pg from 'pg';
import { createConsoleCommandWorker } from '../src/cloud/console-command-worker.mjs';

const url = process.env.HELMION_DATABASE_URL;
if (!url) { console.error('HELMION_DATABASE_URL is required'); process.exit(2); }
const pool = new pg.Pool({ connectionString: url, max: 2 });
const worker = createConsoleCommandWorker({ pool, workerId: process.env.HELMION_WORKER_ID || 'worker:cloud-console', log: (m) => console.log(new Date().toISOString(), m) });
if (process.argv.includes('--once')) {
  const done = await worker.runOnce();
  console.log(JSON.stringify({ processed: done.length, runs: done }));
  await pool.end();
} else {
  const loop = worker.start({ intervalMs: Number(process.env.HELMION_WORKER_INTERVAL_MS) || 5000 });
  const stop = async () => { loop.stop(); await pool.end(); process.exit(0); };
  process.on('SIGTERM', stop); process.on('SIGINT', stop);
  console.log('helmian console worker running');
}
