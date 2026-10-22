// Static checks on the self-host files (nothing is built or deployed here).
import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..', '..');
const deploy = join(here, '..', 'deploy');
const dockerfile = readFileSync(join(deploy, 'Dockerfile'), 'utf8');

test('Dockerfile: non-root user, healthcheck on /healthz, separate key and audit volumes', () => {
  const user = /^USER\s+(\S+)/m.exec(dockerfile);
  assert.ok(user && !/^(root|0)(:|$)/.test(user[1]), 'container must not run as root');
  assert.match(dockerfile, /^HEALTHCHECK .*\/healthz/ms);
  assert.match(dockerfile, /VOLUME \["\/var\/lib\/executive-guard\/keys", "\/var\/lib\/executive-guard\/audit"\]/);
  assert.match(dockerfile, /EXEC_GUARD_KEY_PATH=\/var\/lib\/executive-guard\/keys\//);
  assert.match(dockerfile, /EXEC_GUARD_AUDIT_PATH=\/var\/lib\/executive-guard\/audit\//);
});

test('the env example carries no real secrets: every token is a CHANGE_ME placeholder', () => {
  const env = readFileSync(join(deploy, 'executive-guard.env.example'), 'utf8');
  for (const line of env.split('\n').filter((l) => /^EXEC_GUARD_(DEVICE|APPROVER)_TOKENS=/.test(l))) {
    for (const pair of line.split('=').slice(1).join('=').split(',')) {
      assert.match(pair.split('=')[1], /^CHANGE_ME/, `not a placeholder: ${pair}`);
    }
  }
});

test('the files the image copies are enough to start the server', async () => {
  const copies = [...dockerfile.matchAll(/^COPY\s+(?:--\S+\s+)*(\S+)\s+(\S+)/gm)].map((m) => m[1]);
  assert.deepEqual(copies.sort(), ['executive-guard/bin', 'executive-guard/src', 'extension/background/redact.js']);
  const root = mkdtempSync(join(tmpdir(), 'eg-image-'));
  for (const rel of copies) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    cpSync(join(repo, rel), join(root, rel), { recursive: true });
  }
  const child = spawn(process.execPath, ['executive-guard/bin/executive-guard.mjs'], {
    cwd: root,
    env: {
      PATH: process.env.PATH, EXEC_GUARD_PORT: '0', EXEC_GUARD_DATA_DIR: join(root, 'data'),
      EXEC_GUARD_KEY_PATH: join(root, 'keys', 'signing-key.pem'), EXEC_GUARD_AUDIT_PATH: join(root, 'audit', 'audit.jsonl'),
      EXEC_GUARD_DEVICE_TOKENS: 'hands-mcp=test-device-token-not-real-000000', EXEC_GUARD_APPROVER_TOKENS: 'troy=test-approver-token-not-real-0000',
    },
  });
  const line = await new Promise((resolve, reject) => {
    let out = '';
    child.stdout.on('data', (d) => { out += d; if (out.includes('\n')) resolve(out); });
    child.on('exit', (code) => reject(new Error(`exited ${code}`)));
  });
  assert.equal(JSON.parse(line).service, 'executive-guard');
  const exited = new Promise((resolve) => child.on('exit', resolve));
  child.kill('SIGTERM');
  assert.equal(await exited, 0, 'SIGTERM should shut down cleanly');
  assert.ok(readFileSync(join(root, 'keys', 'signing-key.pem'), 'utf8').includes('PRIVATE KEY'));
  assert.equal(readFileSync(join(root, 'audit', 'state.jsonl'), 'utf8'), '', 'restart state lives next to the audit (same volume)');
});
