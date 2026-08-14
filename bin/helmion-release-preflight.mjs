#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { validateReleaseManifest } from '../src/cloud/release-canary-contract.mjs';

const [manifestPath, expectedPath] = process.argv.slice(2);
if (!manifestPath || !expectedPath) {
  process.stderr.write('Usage: node bin/helmion-release-preflight.mjs <manifest.json> <expected.json>\n');
  process.exitCode = 2;
} else {
  try {
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    const expected = JSON.parse(await readFile(expectedPath, 'utf8'));
    const result = validateReleaseManifest(manifest, expected);
    process.stdout.write(`${result.checklist}\n${result.errors.length ? `Errors: ${result.errors.join('; ')}\n` : 'Release manifest is internally consistent; live canary remains unperformed.\n'}`);
    process.exitCode = result.valid ? 0 : 1;
  } catch (error) {
    process.stderr.write(`Release preflight could not read non-secret manifest inputs: ${error.message}\n`);
    process.exitCode = 1;
  }
}
