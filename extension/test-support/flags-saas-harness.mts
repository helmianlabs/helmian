// Starts Paul's real Flags API (shared-memory-mcp, branch saas) IN THIS PROCESS,
// on 127.0.0.1, with an in-memory PGlite database, the dev mailer and no Stripe,
// using that repo's own test helpers. Creates one account and one API key and
// prints {"base","key"} as one JSON line. Nothing leaves the machine. Used only by
// test/flags-live-saas.test.mjs, which is skipped unless SMM_SAAS_APP_DIR is set.
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';

const dir = process.env.SMM_SAAS_APP_DIR;
if (!dir) throw new Error('SMM_SAAS_APP_DIR is not set');
const h = await import(pathToFileURL(join(dir, 'test', 'helpers.ts')).href);
const s = await h.startSaas();
const cookie = await h.signIn(s, 'guard-e2e@example.com');
const made = await h.api(s, cookie)('/api/keys', { method: 'POST', body: JSON.stringify({ name: 'Guard extension', scopes: ['flags.write', 'flags.read'] }) });
if (made.status !== 201) throw new Error(`key create ${made.status}`);
process.stdout.write(`${JSON.stringify({ base: s.base, key: made.body.key })}\n`);
const stop = async () => { await s.close(); process.exit(0); };
process.on('SIGTERM', stop);
process.stdin.on('end', stop);
process.stdin.resume();
