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
  COPIES,
  KERNEL,
  CLAIMS,
  GENERATED_FILE,
  KERNEL_SOURCE,
  CLAIMS_GENERATED_FILE,
  CLAIMS_SOURCE,
  HEADER_END,
  buildGeneratedFile,
  stripHeader,
  assertBrowserSafe,
} from '../tools/sync-kernel.mjs';

import * as original from '../../src/core/governance.mjs';
import * as copy from '../generated/helmion-governance.generated.js';
import * as claimsOriginal from '../../src/core/unverified-claims.mjs';
import * as claimsCopy from '../generated/helmion-unverified-claims.generated.js';

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

/* ─── THE SECOND COPY ───────────────────────────────────────────────────────
 *
 * src/core/unverified-claims.mjs is copied the same way and for the same
 * reason. It says so in its own header — "BROWSER-SAFE ON PURPOSE. No imports
 * at all, so this can be copied into the extension the same way
 * src/core/governance.mjs is" — and every guarantee the kernel copy carries has
 * to carry over, or the second copy becomes the one that drifts. */

test('THE DRIFT TEST, claim detector: the shipped copy is what sync-kernel.mjs produces today', async () => {
  const onDisk = await readFile(CLAIMS_GENERATED_FILE, 'utf8');
  const expected = await buildGeneratedFile(CLAIMS);
  assert.equal(
    onDisk,
    expected,
    'extension/generated/helmion-unverified-claims.generated.js is stale. '
    + 'Run: node extension/tools/sync-kernel.mjs',
  );
});

test('the claim detector copy is byte-for-byte identical to the original below the header', async () => {
  const onDisk = await readFile(CLAIMS_GENERATED_FILE, 'utf8');
  const body = stripHeader(onDisk);
  const source = await readFile(CLAIMS_SOURCE, 'utf8');
  assert.notEqual(body, null, 'the generated header is missing — the file was replaced by hand');
  assert.equal(body, source);
});

test('the claim detector copy exports the same names as the original', () => {
  assert.deepEqual(Object.keys(claimsCopy).sort(), Object.keys(claimsOriginal).sort());
});

test('the original and the copy give the same verdict on every kind of claim', () => {
  const passages = [
    'The setting is probably under Preferences > Advanced.',
    'The retry limit is probably set in config.json.',
    'The endpoint is probably /api/loads.',
    'Timeouts are usually 30 seconds by default.',
    'I believe HELMION_WORKSPACE is the variable.',
    'Run npm run check, I think.',
    'Node 22 shipped it, as far as I know.',
    'I think that design is cleaner.',
    'I am not sure — let me check.',
    'The retry limit is set in config.json.',
    '',
  ];

  for (const passage of passages) {
    assert.deepEqual(
      claimsCopy.detectUnverifiedClaims(passage),
      claimsOriginal.detectUnverifiedClaims(passage),
      `the copy disagrees with the original on: ${passage}`,
    );
  }
});

test('the claim detector as it stands today passes the browser-safety check', async () => {
  const source = await readFile(CLAIMS_SOURCE, 'utf8');
  assert.equal(assertBrowserSafe(source), true);
});

test('POSITIVE CONTROL: the claim detector drift test really fails when the copy is edited', async () => {
  const scratch = join(tmpdir(), `helmion-claims-drift-control-${process.pid}.js`);
  const expected = await buildGeneratedFile(CLAIMS);
  try {
    await writeFile(scratch, `${expected}\nCONFIDENCE_MARKERS.push('somebody added this by hand');\n`, 'utf8');
    const tampered = await readFile(scratch, 'utf8');
    assert.notEqual(tampered, expected, 'the drift check did not notice an edited copy');
  } finally {
    await rm(scratch, { force: true });
  }

  const shipped = await readFile(CLAIMS_GENERATED_FILE, 'utf8');
  assert.equal(shipped, expected, 'the shipped claim detector copy was modified by the control');
});

test('every copy the script knows about lands in its own file, from its own source', () => {
  // A second entry pointed at the first entry's output would silently overwrite
  // it, and whichever ran last would win.
  assert.ok(COPIES.length >= 2);
  assert.equal(new Set(COPIES.map((entry) => entry.generated)).size, COPIES.length);
  assert.equal(new Set(COPIES.map((entry) => entry.source)).size, COPIES.length);
  assert.equal(KERNEL.generated, GENERATED_FILE);
  assert.equal(CLAIMS.generated, CLAIMS_GENERATED_FILE);
});

test('no generated header carries an absolute path, so a clone anywhere still passes', async () => {
  // The header used to name E:\Helmion. Building it from the real absolute path
  // would have made every clone at a different path fail the drift test on
  // checkout; a repo-relative label is the same text on every machine.
  for (const entry of COPIES) {
    const built = await buildGeneratedFile(entry);
    const header = built.slice(0, built.indexOf(HEADER_END));
    assert.ok(!/[A-Za-z]:\\/.test(header), `${entry.name} header carries a Windows absolute path`);
    assert.ok(header.includes(entry.label), `${entry.name} header does not name its source`);
  }
});
