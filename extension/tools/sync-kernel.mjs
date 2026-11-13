#!/usr/bin/env node
// Copies Helmion's browser-safe core modules into the extension.
//
// WHY THIS EXISTS
// The extension needs the same 15 destructive-command patterns the Helmion CLI
// uses, and the same unsourced-claim detector. Hand-copying regular expressions
// into the extension would create a second list that drifts out of step with the
// first, and a safety tool whose two halves disagree is worse than one half on
// its own.
//
// So nothing is copied by hand. This script reads each source under src/core/
// and writes it out again, byte for byte, under extension/generated/. The
// extension imports the copies. test/kernel-sync.test.mjs re-runs this script in
// memory and fails if anything on disk differs from what it would produce now.
//
// The originals are never edited by this script and never edited by hand for the
// extension's sake. They are the one source of truth.
//
// Run it with:  node extension/tools/sync-kernel.mjs

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));

export const REPO_ROOT = path.resolve(HERE, '..', '..');

function source(...parts) {
  return path.join(REPO_ROOT, ...parts);
}

function generated(name) {
  return path.join(REPO_ROOT, 'extension', 'generated', name);
}

/**
 * Every file copied into the extension.
 *
 * `label` is the repo-relative path with forward slashes, and it is what the
 * generated header prints. It is deliberately NOT the absolute path: an absolute
 * path would make the generated file different on every machine, and the drift
 * test would then fail on any clone that is not at E:\Helmion.
 */
export const COPIES = Object.freeze([
  Object.freeze({
    name: 'kernel',
    label: 'src/core/governance.mjs',
    source: source('src', 'core', 'governance.mjs'),
    generated: generated('helmion-governance.generated.js'),
  }),
  Object.freeze({
    name: 'claims',
    label: 'src/core/unverified-claims.mjs',
    source: source('src', 'core', 'unverified-claims.mjs'),
    generated: generated('helmion-unverified-claims.generated.js'),
  }),
  Object.freeze({
    name: 'harm',
    label: 'src/core/harmful-content.mjs',
    source: source('src', 'core', 'harmful-content.mjs'),
    generated: generated('helmion-harmful-content.generated.js'),
  }),
  Object.freeze({
    name: 'injection',
    label: 'src/core/injection-risk.mjs',
    source: source('src', 'core', 'injection-risk.mjs'),
    generated: generated('helmion-injection.generated.js'),
  }),
]);

export function copyNamed(name) {
  const found = COPIES.find((entry) => entry.name === name);
  if (!found) throw new Error(`no such copy: ${name}`);
  return found;
}

// The kernel was the first copy and several call sites name it directly.
export const KERNEL = copyNamed('kernel');
export const KERNEL_SOURCE = KERNEL.source;
export const GENERATED_FILE = KERNEL.generated;

export const CLAIMS = copyNamed('claims');
export const CLAIMS_SOURCE = CLAIMS.source;
export const CLAIMS_GENERATED_FILE = CLAIMS.generated;

export const INJECTION = copyNamed('injection');
export const INJECTION_SOURCE = INJECTION.source;
export const INJECTION_GENERATED_FILE = INJECTION.generated;

/* ─── THE DERIVED CONTENT BUILD ────────────────────────────────────────────
 *
 * One copy gets a second, derived artifact. src/core/injection-risk.mjs is
 * the send-time scan for the content scripts, and content scripts are
 * classic scripts: they cannot load the ES module copy above (its `export`
 * statements are a syntax error there), and there is no bundler in this
 * repo. Hand-writing a twin detector inside a content file is the drift
 * this script exists to prevent.
 *
 * So the injection copy is ALSO written as a classic-script build of the
 * very same source: the `export` keywords stripped mechanically, the
 * public names attached as HelmionInjection (the attach shape every other
 * content script uses). Nobody hand-types a pattern; the single source of
 * truth stays src/core/injection-risk.mjs, and kernel-sync.test.mjs
 * re-derives this build in memory and byte-compares it, exactly as it does
 * the module copies. */
export const INJECTION_CONTENT = Object.freeze({
  name: 'injection-content',
  label: 'src/core/injection-risk.mjs',
  source: source('src', 'core', 'injection-risk.mjs'),
  generated: generated('helmion-injection.content.js'),
  global: 'HelmionInjection',
  attach: Object.freeze([
    Object.freeze({ as: 'scan', from: 'scanInjection' }),
    Object.freeze({ as: 'describe', from: 'describeInjectionFindings' }),
    Object.freeze({ as: 'SIGNAL', from: 'INJECTION_OVERRIDE_SIGNAL' }),
  ]),
});

export const CONTENT_BUILDS = Object.freeze([INJECTION_CONTENT]);

export const INJECTION_CONTENT_GENERATED_FILE = INJECTION_CONTENT.generated;

// The header is fixed text on purpose. Nothing in it changes between runs — no
// timestamp, no hash, no version, no machine-specific path — so regenerating an
// unchanged source produces a byte-identical file and the drift test stays
// honest.
//
// The header's LINE ENDING is taken from the body rather than hardcoded. It was
// hardcoded to '\n' until 2026-08-03, and that silently broke the drift gate on
// every Windows clone: git's core.autocrlf checks the sources out as CRLF, so the
// body was CRLF while the header this script produced was LF. Regenerating never
// reproduced the file on disk, and 7 of the suite's tests — the drift tests AND
// their positive controls — failed on a clean clone for a reason that had nothing
// to do with tampering. A tamper-detection gate that is red by default detects
// nothing, because nobody can tell a real edit from the usual noise.
function lineEndingOf(text) {
  return /\r\n/.test(text) ? '\r\n' : '\n';
}

export function headerFor(copy, eol = '\n') {
  return [
    '// GENERATED FILE — DO NOT EDIT.',
    '//',
    `// Byte-for-byte copy of ${copy.label}.`,
    '// Produced by extension/tools/sync-kernel.mjs. Edit the original, then run:',
    '//     node extension/tools/sync-kernel.mjs',
    '//',
    '// extension/test/kernel-sync.test.mjs fails if this file and the original',
    '// ever differ, so the two can never drift apart quietly.',
    '',
  ].join(eol);
}

export const HEADER = headerFor(KERNEL);

export const HEADER_END_TEXT = '// ==== END OF GENERATED HEADER — verbatim copy starts on the next line ====';

export const HEADER_END = `${HEADER_END_TEXT}\n`;

// A browser cannot run Node code. If a copied source ever grows an import or
// reaches for a Node built-in, copying it would ship an extension that breaks
// the moment it loads. Better to fail here, loudly, at build time.
const BROWSER_HOSTILE = [
  [/^\s*import\s/m, 'an import statement'],
  [/\sfrom\s+['"]/m, 'an import ... from clause'],
  [/\brequire\s*\(/, 'a require() call'],
  [/\bprocess\s*\./, 'a reference to process'],
  [/['"]node:/, 'a node: built-in specifier'],
  [/\b__dirname\b|\b__filename\b/, 'a CommonJS path global'],
];

export function assertBrowserSafe(sourceText, label = KERNEL.label) {
  const problems = BROWSER_HOSTILE
    .filter(([pattern]) => pattern.test(sourceText))
    .map(([, description]) => description);
  if (problems.length > 0) {
    throw new Error(
      `${label} can no longer be copied into the browser extension: it contains ${problems.join(', ')}. `
      + 'A content script and a service worker cannot run Node code. Either keep the module dependency-free, '
      + 'or split the pure pattern-matching half into its own file and copy that instead.',
    );
  }
  return true;
}

export async function readCopySource(copy = KERNEL) {
  return readFile(copy.source, 'utf8');
}

// Kept because kernel-sync.test.mjs and anything else written before the second
// copy existed call it with no argument.
export async function readKernelSource() {
  return readCopySource(KERNEL);
}

export async function buildGeneratedFile(copy = KERNEL) {
  const text = await readCopySource(copy);
  assertBrowserSafe(text, copy.label);
  const eol = lineEndingOf(text);
  return `${headerFor(copy, eol)}${HEADER_END_TEXT}${eol}${text}`;
}

// Returns the verbatim copy with the generated header removed, or null when the
// header is missing (which means somebody replaced the file by hand). The end
// marker is matched WITHOUT its line break so a CRLF checkout is stripped the
// same as an LF one — matching on `====\n` skipped straight past a `====\r\n`
// file and returned null, which read as "somebody replaced this by hand".
export function stripHeader(text) {
  const body = String(text);
  const index = body.indexOf(HEADER_END_TEXT);
  if (index === -1) return null;
  return body.slice(index + HEADER_END_TEXT.length).replace(/^\r?\n/, '');
}

export function contentHeaderFor(build, eol = '\n') {
  return [
    '// GENERATED FILE — DO NOT EDIT.',
    '//',
    `// Classic-script build of ${build.label} for the content scripts,`,
    '// which cannot load ES modules. Produced by',
    '// extension/tools/sync-kernel.mjs from the same single source as the',
    '// byte-for-byte module copy: the `export` keywords are stripped',
    `// mechanically and the public names are attached as ${build.global}.`,
    '// Edit the original, then run:',
    '//     node extension/tools/sync-kernel.mjs',
    '//',
    '// extension/test/kernel-sync.test.mjs fails if this file and the original',
    '// ever differ, so the two can never drift apart quietly.',
    '',
  ].join(eol);
}

// The whole transformation, and it is deliberately tiny: an `export`
// keyword in front of a declaration is removed, nothing else is touched.
// Any other export form (a bare `export { ... }` list, a default export
// the strip cannot see) is refused by buildContentFile below rather than
// silently producing a file that is not the source.
export function stripExports(text) {
  return String(text)
    .replace(/^export default /gm, '')
    .replace(/^export (?=(?:async function|function|const|let|var|class) )/gm, '');
}

export function contentAttachFor(build, eol = '\n') {
  return [
    '',
    '// The module source above is verbatim apart from the stripped `export`',
    '// keywords. What follows is the rest of the transformation: the public',
    '// names, attached the way every other content script attaches.',
    `(function attach${build.global}(root) {`,
    "  'use strict';",
    '',
    `  root.${build.global} = {`,
    ...build.attach.map(({ as, from }) => `    ${as}: ${from},`),
    '  };',
    "}(typeof globalThis !== 'undefined' ? globalThis : this));",
    '',
  ].join(eol);
}

export async function buildContentFile(build = INJECTION_CONTENT) {
  const text = await readFile(build.source, 'utf8');
  assertBrowserSafe(text, build.label);
  const eol = lineEndingOf(text);
  const body = stripExports(text);
  if (/(?:^|\n)export[\s{*]/.test(body)) {
    throw new Error(
      `${build.label} uses an export form the content build cannot strip mechanically. `
      + 'Keep its exports as declarations (export function / export const), '
      + 'or extend stripExports in extension/tools/sync-kernel.mjs deliberately.',
    );
  }
  const bodyText = body.endsWith('\n') ? body : body + eol;
  return `${contentHeaderFor(build, eol)}${HEADER_END_TEXT}${eol}${bodyText}${contentAttachFor(build, eol)}`;
}

export async function syncContentOne(build) {
  const contents = await buildContentFile(build);
  await mkdir(path.dirname(build.generated), { recursive: true });
  await writeFile(build.generated, contents, 'utf8');
  return { file: build.generated, bytes: Buffer.byteLength(contents, 'utf8') };
}

export async function syncOne(copy) {
  const contents = await buildGeneratedFile(copy);
  await mkdir(path.dirname(copy.generated), { recursive: true });
  await writeFile(copy.generated, contents, 'utf8');
  return { file: copy.generated, bytes: Buffer.byteLength(contents, 'utf8') };
}

export async function syncKernel() {
  const written = [];
  for (const copy of COPIES) {
    written.push(await syncOne(copy));
  }
  for (const build of CONTENT_BUILDS) {
    written.push(await syncContentOne(build));
  }
  return written;
}

const invokedDirectly = process.argv[1]
  && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (invokedDirectly) {
  syncKernel()
    .then((written) => {
      for (const { file, bytes } of written) {
        process.stdout.write(`wrote ${file} (${bytes} bytes)\n`);
      }
    })
    .catch((error) => {
      process.stderr.write(`${error.message}\n`);
      process.exitCode = 1;
    });
}
