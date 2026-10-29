// Signing path for Helmion Guard builds. DRY RUN BY DEFAULT.
//
//   node tools/sign-guard.mjs --target firefox|chrome|edge [--execute]
//
// Without --execute it only checks what is present and prints the exact command
// it would run. With --execute it ALSO requires GUARD_SIGNING_APPROVED=yes (Troy's
// sign-off) and every credential for the target. It never uploads to a public
// listing: Firefox is signed on the UNLISTED channel (self-distributed .xpi,
// AMO does not list it); Chrome produces a self-hosted CRX locally; Edge has no
// signing step outside the store, so it only reports what store submission needs.
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const PLACEHOLDER_GECKO_ID = 'guard@helmion.example';
export const REQUIREMENTS = Object.freeze({
  firefox: ['AMO_JWT_ISSUER', 'AMO_JWT_SECRET'],
  chrome: ['CHROME_CRX_KEY_PATH', 'CHROME_BIN'],
  edge: ['EDGE_PRODUCT_ID', 'EDGE_CLIENT_ID', 'EDGE_API_KEY'],
});

export async function plan(target, env = process.env) {
  const need = REQUIREMENTS[target];
  if (!need) throw new Error(`Unknown target ${target}; use firefox, chrome or edge`);
  const missing = need.filter((k) => !env[k]);
  const blockers = [...missing.map((k) => `missing ${k}`)];
  const stage = join(ROOT, 'artifacts', `helmion-guard-${target}`);
  let command = null;
  if (target === 'firefox') {
    const m = JSON.parse(await readFile(join(ROOT, 'extension', 'manifest.firefox.json'), 'utf8'));
    const id = m.browser_specific_settings?.gecko?.id;
    if (!id || id === PLACEHOLDER_GECKO_ID) blockers.push(`gecko id is the placeholder ${PLACEHOLDER_GECKO_ID}; set Troy's real add-on id`);
    command = ['npx', '--yes', 'web-ext@8', 'sign', '--source-dir', stage, '--artifacts-dir', join(ROOT, 'artifacts', 'signed'),
      '--channel', 'unlisted', '--api-key', '$AMO_JWT_ISSUER', '--api-secret', '$AMO_JWT_SECRET'];
  } else if (target === 'chrome') {
    command = ['$CHROME_BIN', `--pack-extension=${stage}`, '--pack-extension-key=$CHROME_CRX_KEY_PATH'];
  } else {
    blockers.push('Edge: no off-store signing; Microsoft signs on Partner Center submission (needs Troy\'s approval to submit)');
  }
  return { target, missing, blockers, command, ready: blockers.length === 0 };
}

function expand(arg, env) { return arg.replace(/\$([A-Z_]+)/g, (_, k) => env[k] || ''); }

export async function run(target, { execute = false, env = process.env } = {}) {
  const p = await plan(target, env);
  if (!execute) return { ...p, executed: false, note: 'dry run; pass --execute to sign' };
  if (env.GUARD_SIGNING_APPROVED !== 'yes') return { ...p, executed: false, note: 'refused: GUARD_SIGNING_APPROVED=yes (Troy sign-off) not set' };
  if (!p.ready) return { ...p, executed: false, note: 'refused: blockers remain' };
  const [cmd, ...args] = p.command.map((a) => expand(a, env));
  const r = spawnSync(cmd, args, { stdio: 'inherit', cwd: ROOT });
  return { ...p, command: p.command, executed: true, exitCode: r.status };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const i = process.argv.indexOf('--target');
  const result = await run(i >= 0 ? process.argv[i + 1] : 'firefox', { execute: process.argv.includes('--execute') });
  // Commands are printed with $VAR placeholders, never the secret values.
  console.log(JSON.stringify(result, null, 2));
  if (result.executed && result.exitCode !== 0) process.exitCode = 1;
}
