// helmian.cloud/admin and /api/admin/* on Vercel (replaces the Fly app).
// vercel.json rewrites those paths here with the original path in ?__p=.
// Needs env: HELMION_DATABASE_URL (Neon pooled URL), HELMION_EXPECTED_ENDPOINT_ID,
// HELMION_ADMIN_ISSUER, HELMION_ADMIN_CLIENT_ID, HELMION_ADMIN_REDIRECT_URI,
// HELMION_ADMIN_SESSION_SECRET (sealed cookies; no in-memory sessions on serverless).
import { createLiveHelmianCloudAdminHandler, LIVE_ADMIN_CONSOLE_COMMANDS_PATH, LIVE_ADMIN_CORA_TASKS_PATH } from '../helmian-admin/src/cloud/live-admin.mjs';
import { createConsoleCommandWorker } from '../helmian-admin/src/cloud/console-command-worker.mjs';
import { createAgentTaskWorker } from '../helmian-admin/src/cora/agent-task-worker.mjs';
import pg from 'pg';

const REQUIRED = ['HELMION_DATABASE_URL', 'HELMION_EXPECTED_ENDPOINT_ID', 'HELMION_ADMIN_ISSUER', 'HELMION_ADMIN_CLIENT_ID', 'HELMION_ADMIN_REDIRECT_URI', 'HELMION_ADMIN_SESSION_SECRET'];
let state = null;

function boot() {
  if (!state) {
    state = (async () => {
      const missing = REQUIRED.filter((k) => !String(process.env[k] ?? '').trim());
      if (missing.length) return { missing };
      const pool = new pg.Pool({ connectionString: process.env.HELMION_DATABASE_URL, max: 3, idleTimeoutMillis: 10_000 });
      const admin = await createLiveHelmianCloudAdminHandler({ env: { HELMION_CLOUD_ENVIRONMENT: 'production', ...process.env }, pool, logger: (e) => console.log(JSON.stringify(e)) });
      const worker = createConsoleCommandWorker({ pool, workerId: 'worker:vercel-console' });
      const agentTaskWorker = createAgentTaskWorker({ pool, workerId: 'worker:vercel-agent-tasks' });
      return { admin, worker, agentTaskWorker };
    })().catch((error) => { state = null; throw error; });
  }
  return state;
}

export function restorePath(rawUrl) {
  const url = new URL(rawUrl || '/', 'http://local');
  const original = url.searchParams.get('__p');
  url.searchParams.delete('__p');
  if (!original || !/^\/(admin|api\/admin)(\/|$)/.test(original)) return null;
  const query = url.searchParams.toString();
  // Vercel strips trailing slashes (trailingSlash:false), so serve the page for /admin directly.
  const target = original === '/admin' ? '/admin/' : original;
  return `${target}${query ? `?${query}` : ''}`;
}

export default async function handler(req, res) {
  const path = restorePath(req.url);
  if (!path) { res.statusCode = 404; res.end('{"valid":false,"code":"ADMIN_ROUTE_NOT_FOUND"}'); return; }
  req.url = path;
  let booted;
  try { booted = await boot(); } catch { res.statusCode = 503; res.setHeader('content-type', 'application/json'); res.end('{"valid":false,"code":"ADMIN_BOOT_FAILED"}'); return; }
  if (booted.missing) { res.statusCode = 503; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ valid: false, code: 'ADMIN_NOT_CONFIGURED', missing: booted.missing })); return; }
  // No always-on worker on Vercel Hobby: drain queued console commands when the console is read.
  if (req.method === 'GET' && path.split('?')[0] === LIVE_ADMIN_CONSOLE_COMMANDS_PATH) await booted.worker.runOnce().catch((e) => console.log('console worker', e.message));
  // Same for prepared agent task intents: triage them (needs_desktop / refused) when the task list is read.
  if (req.method === 'GET' && path.split('?')[0] === LIVE_ADMIN_CORA_TASKS_PATH) await booted.agentTaskWorker.runOnce().catch((e) => console.log('agent task worker', e.message));
  const handled = await booted.admin.handler(req, res);
  if (!handled && !res.writableEnded) { res.statusCode = 404; res.setHeader('content-type', 'application/json'); res.end('{"valid":false,"code":"ADMIN_ROUTE_NOT_FOUND"}'); }
}
