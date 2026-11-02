// Round-trip proof for the Envoy profile save (Settings > ENVOY PROFILE).
//
// The defect: sql/059_user_profiles.sql created a trigger calling
// helmion.set_updated_at(), a function no migration defines, so the whole
// file failed and helmion.user_profiles never existed — GET/POST
// /api/admin/profile could never persist anything (the handler answers
// 503 PROFILE_STORE_MISSING and the Settings page reads back empty).
//
// This test needs a real Postgres because the break lives in real DDL.
// Harness: it uses the Postgres binaries from the optional
// `embedded-postgres` package (installed --no-save in the work copy only;
// not a package dependency), copied to a scratch dir under /tmp and run
// as the `postgres` user. If those binaries are unavailable the test
// skips itself rather than failing the suite. It is a local proof
// harness and is deliberately not in the package.json test list.
//
// Legs:
//  1. The pre-fix 059 (test/fixtures/059_user_profiles.broken.sql) fails as
//     a whole and leaves no table behind — the defect, demonstrated.
//  2. The current sql/059_user_profiles.sql applies cleanly.
//  3. The real profile handler round-trips: POST save -> GET reload-read
//     returns the same nickname + avatar; a second POST updates in place.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync, existsSync, cpSync, chmodSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const NATIVE_DIR = fileURLToPath(new URL('../node_modules/@embedded-postgres/linux-x64/native', import.meta.url));
const HAVE_PG_BINARIES = existsSync(join(NATIVE_DIR, 'bin', 'initdb'));

const BROKEN_059 = readFileSync(new URL('./fixtures/059_user_profiles.broken.sql', import.meta.url), 'utf8');
const CURRENT_059 = readFileSync(new URL('../sql/059_user_profiles.sql', import.meta.url), 'utf8');

const PORT = 55439;
const CONN = `postgresql://postgres@127.0.0.1:${PORT}/profile_test`;

function asPostgres(cmd) {
  return execFileSync('su', ['postgres', '-s', '/bin/bash', '-c', cmd], { stdio: 'pipe' });
}

// NOTE on the scratch location: in this VM /tmp is a noexec tmpfs and
// /home/hatch is not traversable by the postgres user, so the scratch
// cluster lives under /opt (exec-allowed overlay, world-traversable).
function startScratchPostgres(t) {
  const scratch = mkdtempSync('/opt/helmian-pgproof-');
  chmodSync(scratch, 0o755); // mkdtemp is 0700; the postgres user must traverse it
  const native = join(scratch, 'native');
  // cp -a (not fs.cpSync): cpSync rewrites relative symlinks (libpq.so.5 ->
  // libpq.so.5.18) into absolute ones pointing back at the source tree,
  // which the postgres user cannot traverse.
  execFileSync('cp', ['-a', NATIVE_DIR, native]);
  chmodSync(native, 0o755);
  execFileSync('chmod', ['-R', 'a+rX', native]);
  const data = join(scratch, 'data');
  const run = join(scratch, 'run');
  mkdirSync(data);
  mkdirSync(run);
  execFileSync('chown', ['-R', 'postgres:postgres', data, run]);
  const bin = join(native, 'bin');
  asPostgres(`LC_ALL=C "${bin}/initdb" -D "${data}" -U postgres --auth=trust -E UTF8`);
  asPostgres(`"${bin}/pg_ctl" -D "${data}" -l "${join(run, 'server.log')}" -o "-p ${PORT} -k ${run} -h 127.0.0.1" -w start`);
  t.after(() => {
    try { asPostgres(`"${bin}/pg_ctl" -D "${data}" -m immediate -w stop`); } catch { /* already down */ }
    rmSync(scratch, { recursive: true, force: true });
  });
  return scratch;
}

function mockRes() {
  return {
    status: null,
    body: null,
    writeHead(status) { this.status = status; },
    end(chunk) { this.body = chunk ? JSON.parse(chunk) : null; },
  };
}

function mockReq({ method, session = 'test-session', json = null }) {
  const req = Readable.from(json === null ? [] : [Buffer.from(JSON.stringify(json))]);
  req.method = method;
  req.headers = session ? { cookie: `helmion_admin_session=${session}` } : {};
  return req;
}

test('profile save persists: migration applies and handler round-trips nickname + avatar', { skip: !HAVE_PG_BINARIES && 'embedded-postgres binaries not installed (optional proof harness)' }, async (t) => {
  startScratchPostgres(t);

  const { Client } = await import('pg');
  const admin = new Client({ connectionString: `postgresql://postgres@127.0.0.1:${PORT}/postgres` });
  await admin.connect();
  await admin.query('create database profile_test');
  await admin.end();

  const ddl = new Client({ connectionString: CONN });
  await ddl.connect();
  t.after(() => ddl.end().catch(() => {}));
  await ddl.query('create schema helmion');

  // Leg 1: the broken 059 fails on the undefined trigger function and,
  // running as one batch, leaves no table behind.
  await assert.rejects(
    ddl.query(BROKEN_059),
    /set_updated_at/,
    'pre-fix 059 must fail on helmion.set_updated_at()',
  );
  const afterBroken = await ddl.query(
    "select count(*)::int as n from information_schema.tables where table_schema = 'helmion' and table_name = 'user_profiles'",
  );
  assert.equal(afterBroken.rows[0].n, 0, 'failed 059 leaves helmion.user_profiles missing — the live defect');

  // Leg 2: the current (fixed) 059 applies cleanly.
  await ddl.query(CURRENT_059);
  const afterFixed = await ddl.query(
    "select count(*)::int as n from information_schema.tables where table_schema = 'helmion' and table_name = 'user_profiles'",
  );
  assert.equal(afterFixed.rows[0].n, 1, 'fixed 059 creates helmion.user_profiles');
  await ddl.end();

  // Leg 3: the real handler — save, then reload-read, then update.
  process.env.HELMION_DATABASE_URL = CONN;
  const { createProfileHandler } = await import('../src/cloud/user-profile.mjs');
  const handler = createProfileHandler({
    getIdentity: () => ({
      getSession: (id) => (id === 'test-session' ? { subject: 'user_profile_test' } : null),
    }),
  });

  let res = mockRes();
  await handler(mockReq({ method: 'GET' }), res);
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { nickname: null, avatarEmoji: null }, 'fresh profile reads empty');

  res = mockRes();
  await handler(mockReq({ method: 'POST', json: { nickname: 'Troy', avatarEmoji: '😀' } }), res);
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);

  res = mockRes();
  await handler(mockReq({ method: 'GET' }), res);
  assert.equal(res.status, 200);
  assert.deepEqual(
    res.body,
    { nickname: 'Troy', avatarEmoji: '😀' },
    'reload-read returns the saved nickname + avatar — the save persisted',
  );

  res = mockRes();
  await handler(mockReq({ method: 'POST', json: { avatarEmoji: '😎' } }), res);
  assert.equal(res.status, 200);
  res = mockRes();
  await handler(mockReq({ method: 'GET' }), res);
  assert.deepEqual(
    res.body,
    { nickname: 'Troy', avatarEmoji: '😎' },
    'second save updates the same row (latest wins, nickname kept)',
  );

  res = mockRes();
  await handler(mockReq({ method: 'GET', session: null }), res);
  assert.equal(res.status, 401, 'no session, no profile');

  // The handler's pool is module-internal with no close API; let its idle
  // clients drain (pg default idle timeout is 10s) before teardown stops
  // the scratch server, so no socket error lands after the test ends.
  await new Promise((r) => setTimeout(r, 11_000));
});
