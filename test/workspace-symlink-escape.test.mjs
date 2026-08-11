// The workspace boundary, tested against a real link on a real disk.
//
// resolveInWorkspace blocked `..` and absolute paths outside the root, and both
// of those checks were real. But they were LEXICAL — node's resolve() does no
// link resolution — so a symlink or junction sitting INSIDE the workspace and
// pointing anywhere on disk kept a textual path under the root, satisfied both
// checks, and was then followed by readFileSync and writeFileSync.
//
// That is not a theoretical arrangement. On Windows the agent can create the
// junction itself with `mklink /J` through run_command, and then read or
// overwrite files outside the workspace using ordinary read_file and write_file
// — which in read-tools mode are not gated by an approval at all.
//
// These tests create a genuine link rather than mocking one, because a mocked
// link proves nothing about whether resolve() follows it.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, symlinkSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createToolRuntime } from '../src/agent/tools.mjs';

function makeWorkspace() {
  const dir = mkdtempSync(join(tmpdir(), 'helmion-link-'));
  mkdirSync(join(dir, 'workspace'), { recursive: true });
  mkdirSync(join(dir, 'outside'), { recursive: true });
  return dir;
}

// Creating a directory symlink needs either developer mode or elevation on
// Windows. If it is not permitted, the test says so out loud and skips rather
// than passing silently — a skipped boundary test that looks green is its own
// small lie.
function tryLink(target, linkPath) {
  try {
    symlinkSync(target, linkPath, 'junction');
    return true;
  } catch {
    try {
      symlinkSync(target, linkPath, 'dir');
      return true;
    } catch {
      return false;
    }
  }
}

test('a symlink inside the workspace cannot be used to READ outside it', async (t) => {
  const base = makeWorkspace();
  try {
    const workspace = join(base, 'workspace');
    const outside = join(base, 'outside');
    writeFileSync(join(outside, 'boundary-proof.txt'), 'OUTSIDE_BOUNDARY_SENTINEL');

    if (!tryLink(outside, join(workspace, 'escape'))) {
      t.skip('this platform/account cannot create a directory link');
      return;
    }

    const runtime = createToolRuntime(workspace, { permissionMode: 'full' });

    let result;
    try {
      result = await runtime.execute('read_file', { path: 'escape/boundary-proof.txt' });
    } catch (error) {
      result = error.message;
    }

    assert.doesNotMatch(
      String(result),
      /OUTSIDE_BOUNDARY_SENTINEL/,
      'the agent read a file outside the workspace through a symlink',
    );
    assert.match(String(result), /symlink|escape|outside|verified/i);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('a symlink inside the workspace cannot be used to WRITE outside it', async (t) => {
  const base = makeWorkspace();
  try {
    const workspace = join(base, 'workspace');
    const outside = join(base, 'outside');
    const victim = join(outside, 'victim.txt');
    writeFileSync(victim, 'original');

    if (!tryLink(outside, join(workspace, 'escape'))) {
      t.skip('this platform/account cannot create a directory link');
      return;
    }

    const runtime = createToolRuntime(workspace, { permissionMode: 'full' });

    try {
      await runtime.execute('write_file', { path: 'escape/victim.txt', content: 'overwritten' });
    } catch {
      // A throw is a perfectly good outcome. What matters is the file on disk.
    }

    assert.equal(
      readFileSync(victim, 'utf8'),
      'original',
      'the agent overwrote a file outside the workspace through a symlink',
    );
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('POSITIVE CONTROL: ordinary reads and writes inside the workspace still work', async () => {
  // The fix refuses paths it cannot verify. This proves it did not simply
  // refuse everything, which would "pass" both tests above for the wrong reason.
  const base = makeWorkspace();
  try {
    const workspace = join(base, 'workspace');
    writeFileSync(join(workspace, 'hello.txt'), 'readable');

    const runtime = createToolRuntime(workspace, { permissionMode: 'full' });

    const read = await runtime.execute('read_file', { path: 'hello.txt' });
    assert.match(String(read), /readable/, 'an ordinary read inside the workspace was refused');

    // A file that does not exist yet — the case realpathSync alone cannot handle,
    // which is why the check walks up to the nearest existing ancestor.
    await runtime.execute('write_file', { path: 'nested/new-file.txt', content: 'written' });
    assert.equal(existsSync(join(workspace, 'nested', 'new-file.txt')), true, 'a new nested file could not be created');
    assert.equal(readFileSync(join(workspace, 'nested', 'new-file.txt'), 'utf8'), 'written');
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

// NOTE ON WHAT IS NOT TESTED HERE.
//
// This file originally also asserted that `run_command` could not hold a
// standing session grant — a session grant is keyed on the tool NAME alone, so
// approving `git status` once turns ask mode into full mode for every command
// that follows. That change was made, and then reverted, during the same audit:
// test/governance-wiring.test.mjs pins `grantedTools === ['run_command']` as
// INTENDED behaviour, so the feature is deliberate and narrowing it changes what
// a button in the UI does. That is a product decision, not an audit fix.
//
// The security property that matters is separately proven and does hold: the
// governance kernel runs before the approval tier, so a held grant cannot
// launder a destructive command. See the "GOVERNANCE BEATS APPROVAL" section of
// test/governance-wiring.test.mjs.
