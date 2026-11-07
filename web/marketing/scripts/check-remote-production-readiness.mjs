import { access, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const requiredFiles = [
  'herald/index.html', 'herald/shell.js', 'herald/account-runtime.js',
];
const source = {};
for (const file of requiredFiles) {
  try { await access(resolve(root, file)); source[file] = true; }
  catch { source[file] = false; }
}
// The remote/v1 routes have no physical files: vercel.json rewrites
// multi-segment /api paths to the api/[...path].js catch-all, whose exported
// route table maps each route key to a handler module under server/. Check
// the route table itself, plus that each mapped handler module exists,
// instead of looking for per-route files the routing design never creates.
const remoteRoutes = {
  'remote/v1/enrollment': 'herald-enrollment.js',
  'remote/v1/desktop': 'herald-desktop.js',
  'remote/v1/desktops': 'herald-desktops.js',
  'remote/v1/control': 'herald-control.js',
  'remote/v1/control-token': 'herald-realtime-token.js',
  'remote/v1/desktop-token': 'herald-desktop-realtime-token.js',
};
let catchAllSource = '';
try {
  catchAllSource = await readFile(resolve(root, 'api/[...path].js'), 'utf8');
  source['api/[...path].js'] = true;
} catch { source['api/[...path].js'] = false; }
for (const [route, handlerFile] of Object.entries(remoteRoutes)) {
  let handlerPresent = false;
  try { await access(resolve(root, 'server', handlerFile)); handlerPresent = true; }
  catch { handlerPresent = false; }
  source[`route:${route}`] = catchAllSource.includes(`'${route}':`) && handlerPresent;
}
const vercel = JSON.parse(await readFile(resolve(root, 'vercel.json'), 'utf8'));
const policy = vercel.headers?.flatMap((item) => item.headers ?? [])
  .find((header) => header.key === 'Content-Security-Policy')?.value ?? '';
source.scopedRealtimeCsp = policy.includes('cdn.ably.com')
  && policy.includes('ably-realtime.com') && policy.includes('clerk.accounts')
  && policy.includes('clerk.helmian.cloud');

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
