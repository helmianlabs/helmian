#!/usr/bin/env node
// Copies the Helmion destructive-command kernel into the extension.
//
// WHY THIS EXISTS
// The extension needs the same 15 destructive-command patterns the Helmion CLI
// uses. Hand-copying the regular expressions into the extension would create a
// second list that drifts out of step with the first, and a safety tool whose
// two halves disagree is worse than one half on its own.
//
// So nothing is copied by hand. This script reads src/core/governance.mjs and
// writes it out again, byte for byte, under extension/generated/. The extension
// imports the copy. test/kernel-sync.test.mjs re-runs this script in memory and
// fails if the copy on disk differs from what it would produce now.
//
// src/core/governance.mjs is never edited by this script and never edited by
// hand for the extension's sake. It is the one source of truth.
//
// Run it with:  node extension/tools/sync-kernel.mjs

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));

export const REPO_ROOT = path.resolve(HERE, '..', '..');
export const KERNEL_SOURCE = path.join(REPO_ROOT, 'src', 'core', 'governance.mjs');
export const GENERATED_FILE = path.join(
  REPO_ROOT,
  'extension',
  'generated',
  'helmion-governance.generated.js',
);

// The header is fixed text on purpose. Nothing in it changes between runs — no
// timestamp, no hash, no version — so regenerating an unchanged kernel produces
// a byte-identical file and the drift test stays honest.
export const HEADER = [
  '// GENERATED FILE — DO NOT EDIT.',
  '//',
  '// Byte-for-byte copy of E:\\Helmion\\src\\core\\governance.mjs.',
  '// Produced by extension/tools/sync-kernel.mjs. Edit the original, then run:',
  '//     node extension/tools/sync-kernel.mjs',
  '//',
  '// extension/test/kernel-sync.test.mjs fails if this file and the original',
  '// ever differ, so the two can never drift apart quietly.',
  '',
].join('\n');

export const HEADER_END = '// ==== END OF GENERATED HEADER — verbatim copy starts on the next line ====\n';

// A browser cannot run Node code. If the kernel ever grows an import or reaches
// for a Node built-in, copying it would ship an extension that breaks the moment
// it loads. Better to fail here, loudly, at build time.
const BROWSER_HOSTILE = [
  [/^\s*import\s/m, 'an import statement'],
  [/\sfrom\s+['"]/m, 'an import ... from clause'],
  [/\brequire\s*\(/, 'a require() call'],
  [/\bprocess\s*\./, 'a reference to process'],
  [/['"]node:/, 'a node: built-in specifier'],
  [/\b__dirname\b|\b__filename\b/, 'a CommonJS path global'],
];

export function assertBrowserSafe(source) {
  const problems = BROWSER_HOSTILE
    .filter(([pattern]) => pattern.test(source))
    .map(([, label]) => label);
  if (problems.length > 0) {
    throw new Error(
      `src/core/governance.mjs can no longer be copied into the browser extension: it contains ${problems.join(', ')}. `
      + 'A content script and a service worker cannot run Node code. Either keep the kernel dependency-free, '
      + 'or split the pure pattern-matching half into its own file and copy that instead.',
    );
  }
  return true;
}

export async function readKernelSource() {
  return readFile(KERNEL_SOURCE, 'utf8');
}

export async function buildGeneratedFile() {
  const source = await readKernelSource();
  assertBrowserSafe(source);
  return `${HEADER}${HEADER_END}${source}`;
}

// Returns the verbatim copy with the generated header removed, or null when the
// header is missing (which means somebody replaced the file by hand).
export function stripHeader(text) {
  const index = String(text).indexOf(HEADER_END);
  if (index === -1) return null;
  return String(text).slice(index + HEADER_END.length);
}

export async function syncKernel() {
  const contents = await buildGeneratedFile();
  await mkdir(path.dirname(GENERATED_FILE), { recursive: true });
  await writeFile(GENERATED_FILE, contents, 'utf8');
  return { file: GENERATED_FILE, bytes: Buffer.byteLength(contents, 'utf8') };
}

const invokedDirectly = process.argv[1]
  && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (invokedDirectly) {
  syncKernel()
    .then(({ file, bytes }) => {
      process.stdout.write(`wrote ${file} (${bytes} bytes)\n`);
    })
    .catch((error) => {
      process.stderr.write(`${error.message}\n`);
      process.exitCode = 1;
    });
}
