import { access, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const requiredFiles = [
  'herald/index.html', 'herald/shell.js', 'herald/account-runtime.js',
  'api/remote/v1/enrollment.js', 'api/remote/v1/desktop.js',
  'api/remote/v1/desktops.js', 'api/remote/v1/control.js',
  'api/remote/v1/control-token.js', 'api/remote/v1/desktop-token.js',
];
const source = {};
for (const file of requiredFiles) {
  try { await access(resolve(root, file)); source[file] = true; }
  catch { source[file] = false; }
}
const vercel = JSON.parse(await readFile(resolve(root, 'vercel.json'), 'utf8'));
const policy = vercel.headers?.flatMap((item) => item.headers ?? [])
  .find((header) => header.key === 'Content-Security-Policy')?.value ?? '';
source.scopedRealtimeCsp = policy.includes('cdn.ably.com')
  && policy.includes('ably-realtime.com') && policy.includes('clerk.accounts');

const environment = Object.fromEntries([
  'CLERK_PUBLISHABLE_KEY', 'CLERK_SECRET_KEY',
  'HELMION_HERALD_CLERK_AUTHORIZED_PARTIES',
  'HELMION_HERALD_ENROLLMENT_PEPPER', 'HELMION_HERALD_DATABASE_URL',
  'ABLY_API_KEY',
].map((name) => [name, String(process.env[name] ?? '').trim().length > 0]));

let publicDeployment = null;
const url = process.argv.find((value) => value.startsWith('https://'));
if (url) {
  try {
    const response = await fetch(new URL('/api/herald-config', url), {
      headers: { accept: 'application/json' }, signal: AbortSignal.timeout(10_000),
    });
    const value = await response.json();
    publicDeployment = {
      reachable: response.ok,
      accountConfigured: value?.accountIdentity?.configured === true,
      enrollmentConfigured: value?.accountIdentity?.desktopEnrollmentConfigured === true,
      realtimeConfigured: value?.transport?.ablyTokenServiceConfigured === true,
      realtimeClientActive: value?.transport?.realtimeClientActive === true,
    };
  } catch { publicDeployment = { reachable: false }; }
}

const ready = Object.values(source).every(Boolean)
  && Object.values(environment).every(Boolean)
  && (!publicDeployment || Object.values(publicDeployment).every(Boolean));
process.stdout.write(`${JSON.stringify({ ready, source, environment, publicDeployment }, null, 2)}\n`);
process.exitCode = ready ? 0 : 2;
