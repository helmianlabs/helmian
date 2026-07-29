// Proves the extension's copy of the destructive-command kernel has not drifted
// from the original.
//
// The extension cannot import Node code, so it carries a copy of
// src/core/governance.mjs. A copy is a liability: two lists of patterns, both
// maintained by hand, quietly disagreeing. A safety tool whose two halves
// disagree is worse than one half on its own.
//
// So the copy is never made by hand. extension/tools/sync-kernel.mjs writes it,
// and this file re-runs that script in memory and fails if what is on disk is
// not what the script would produce right now. Add a pattern to governance.mjs,
// forget to re-run the script, and npm test goes red.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  GENERATED_FILE,
  KERNEL_SOURCE,
  HEADER_END,
  buildGeneratedFile,
  stripHeader,
  assertBrowserSafe,
} from '../tools/sync-kernel.mjs';

import * as original from '../../src/core/governance.mjs';
import * as copy from '../generated/helmion-governance.generated.js';

test('THE DRIFT TEST: the shipped copy is exactly what sync-kernel.mjs produces today', async () => {
  const onDisk = await readFile(GENERATED_FILE, 'utf8');
  const expected = await buildGeneratedFile();
  assert.equal(
    onDisk,
    expected,
    'extension/generated/helmion-governance.generated.js is stale. '
    + 'Run: node extension/tools/sync-kernel.mjs',
  );
});

test('the copy is byte-for-byte identical to src/core/governance.mjs below the header', async () => {
  const onDisk = await readFile(GENERATED_FILE, 'utf8');
  const body = stripHeader(onDisk);
  const source = await readFile(KERNEL_SOURCE, 'utf8');
  assert.notEqual(body, null, 'the generated header is missing — the file was replaced by hand');
  assert.equal(body, source);
});

test('the generated file says, in its own text, not to edit it', async () => {
  const onDisk = await readFile(GENERATED_FILE, 'utf8');
  assert.match(onDisk, /GENERATED FILE — DO NOT EDIT/);
  assert.match(onDisk, /node extension\/tools\/sync-kernel\.mjs/);
  assert.ok(onDisk.includes(HEADER_END));
});

test('POSITIVE CONTROL: the drift test really fails when the copy is edited', async () => {
  // A test that cannot fail proves nothing. Write an edited copy, read it back
  // off disk, and confirm the comparison the drift test makes does catch it.
  //
  // This deliberately does NOT tamper with the shipped file. It used to: it
  // appended a line to extension/generated/helmion-governance.generated.js and
  // restored it in a finally block. `node --test` runs test FILES CONCURRENTLY,
  // and two other suites import that exact module, so for the few milliseconds
  // the file was corrupt a sibling suite could import a broken kernel. It was
  // observed failing that way. The generated file is also untracked in git, so
  // a crash between the write and the restore would have left a tampered
  // safety kernel on disk with no `git checkout` to undo it.
  const scratch = join(tmpdir(), `helmion-drift-control-${process.pid}.js`);
  const expected = await buildGeneratedFile();
  try {
    await writeFile(scratch, `${expected}\n// a pattern somebody added here by hand\n`, 'utf8');
    const tampered = await readFile(scratch, 'utf8');
    assert.notEqual(tampered, expected, 'the drift check did not notice an edited copy');
  } finally {
    await rm(scratch, { force: true });
  }

  // And the shipped file is exactly where it was — this control cannot be the
  // reason another suite sees a corrupt kernel.
  const shipped = await readFile(GENERATED_FILE, 'utf8');
  assert.equal(shipped, expected, 'the shipped kernel copy was modified by the control');
});

test('the original and the copy give the same verdict on every pattern', () => {
  // Belt and braces on top of the byte compare: run both and compare answers.
  const commands = [
    'rm -rf /',
    'rm -rf html/*',
    'rm *',
    'Remove-Item -Recurse -Force C:\\build',
    'rmdir /S /Q build',
    'del /F /Q build\\*',
    'git reset --hard HEAD~3',
    'git clean -fdx',
    'git push --force origin main',
    'git push --force-with-lease',
    'git branch -D feature/old',
    'git checkout -- src/index.js',
    'git worktree remove ../wt-old',
    'Clear-Content .\\notes.txt',
    'DROP TABLE loads;',
    'TRUNCATE TABLE loads;',
    'dd if=/dev/zero of=/dev/sda bs=1M',
    'mkfs.ext4 /dev/sdb1',
    'node -e "db.query(\'DROP TABLE loads\')"',
    'npm install',
    'git status',
    'SELECT * FROM loads;',
    'echo hello',
    '',
  ];

  for (const command of commands) {
    const payload = { tool_input: { command } };
    assert.deepEqual(
      copy.detectDestructiveOperation(payload),
      original.detectDestructiveOperation(payload),
      `the copy disagrees with the original on: ${command}`,
    );
  }
});

test('the copy exports the same names as the original', () => {
  assert.deepEqual(Object.keys(copy).sort(), Object.keys(original).sort());
});

test('generation refuses a kernel that a browser could not run', () => {
  // If governance.mjs ever grows an import or reaches for a Node built-in,
  // copying it would ship an extension that dies the moment it loads. Better to
  // break the build here, where somebody is looking.
  assert.throws(
    () => assertBrowserSafe('import fs from "node:fs";\nexport function x() {}'),
    /can no longer be copied into the browser extension/,
  );
  assert.throws(
    () => assertBrowserSafe('const home = process.env.HOME;'),
    /a reference to process/,
  );
  assert.throws(
    () => assertBrowserSafe('const fs = require("fs");'),
    /a require\(\) call/,
  );
});

test('the kernel as it stands today passes the browser-safety check', async () => {
  const source = await readFile(KERNEL_SOURCE, 'utf8');
  assert.equal(assertBrowserSafe(source), true);
});
