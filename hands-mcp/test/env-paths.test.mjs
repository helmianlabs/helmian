// The PC-seat root and the spoke's own protocol path used to be hardcoded
// for one user. They now come from the environment (protocol.mjs,
// "Machine-specific paths"). These tests pin the contract: for a Windows
// profile at C:\Users\<name> the computed values are exactly the old
// literal shapes, every override wins, and with no environment at all the
// standing-grant coverage fails closed. Signed action hashes never depend
// on these paths.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const PROTOCOL = fileURLToPath(new URL('../src/shared/protocol.mjs', import.meta.url));
const NAME = 'someone';
const PROFILE = `C:\\Users\\${NAME}`;
const UUID = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';

function probe(env) {
  const script = `
    const m = await import(${JSON.stringify('file://' + PROTOCOL)});
    const R = ${JSON.stringify(`${PROFILE}\\pc-seat`)};
    const claims = { grantType: 'action', actions: [{ tool: 'write_file', scope: 'jobs-prompt' }, { tool: 'edit_file', scope: 'spoke-protocol' }] };
    console.log(JSON.stringify({
      root: m.ACTION_GRANT_PC_ROOT,
      protocolPath: m.ACTION_GRANT_SPOKE_PROTOCOL_PATH,
      jobs: m.actionGrantCovers('write_file', { path: R + '\\\\jobs\\\\${UUID}.prompt.txt', content: 'x' }, claims),
      edit: m.actionGrantCovers('edit_file', { path: ${JSON.stringify(`${PROFILE}\\AppData\\Local\\Programs\\Helmian\\hands-mcp\\src\\shared\\protocol.mjs`)} }, claims),
      hash: m.guardActionHash(m.buildGuardAction('write_file', { path: R + '\\\\jobs\\\\${UUID}.prompt.txt', content: 'x' })),
    }));`;
  const clean = { PATH: process.env.PATH };
  return JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', script], { env: { ...clean, ...env }, encoding: 'utf8' }));
}

test('Windows profile defaults reproduce the old hardcoded shapes exactly', () => {
  const r = probe({ USERPROFILE: PROFILE, LOCALAPPDATA: `${PROFILE}\\AppData\\Local` });
  assert.equal(r.root, `C:\\Users\\${NAME}\\pc-seat`);
  assert.equal(r.protocolPath, `C:\\Users\\${NAME}\\AppData\\Local\\Programs\\Helmian\\hands-mcp\\src\\shared\\protocol.mjs`);
  assert.equal(r.jobs, true);
  assert.equal(r.edit, true);
});

test('USERPROFILE alone is enough; explicit overrides give the same answer', () => {
  const base = probe({ USERPROFILE: PROFILE, LOCALAPPDATA: `${PROFILE}\\AppData\\Local` });
  assert.deepEqual(probe({ USERPROFILE: PROFILE }), base);
  assert.deepEqual(probe({
    HANDS_ACTION_GRANT_PC_ROOT: `${PROFILE}\\pc-seat`,
    HANDS_PROTOCOL_PATH: `${PROFILE}\\AppData\\Local\\Programs\\Helmian\\hands-mcp\\src\\shared\\protocol.mjs`,
  }), base);
});

test('no environment: coverage fails closed, signed hashes unchanged', () => {
  const base = probe({ USERPROFILE: PROFILE });
  const bare = probe({});
  assert.equal(bare.root, '');
  assert.equal(bare.protocolPath, '');
  assert.equal(bare.jobs, false);
  assert.equal(bare.edit, false);
  assert.equal(bare.hash, base.hash);
});
