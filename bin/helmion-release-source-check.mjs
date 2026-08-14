#!/usr/bin/env node
import { resolve } from 'node:path';
import { validateReleaseSourceTree } from '../src/cloud/release-source-integrity.mjs';

const result = await validateReleaseSourceTree({ root: resolve(process.argv[2] ?? process.cwd()) });
process.stdout.write(`${result.valid ? '[PASS]' : '[FAIL]'} local release source integrity\n`);
if (!result.valid) {
  process.stdout.write(`Missing migrations: ${result.missingMigrations.join(', ') || 'none'}\n`);
  process.stdout.write(`Migrations contiguous: ${result.migrationsContiguous}\n`);
  process.stdout.write(`Missing source files: ${result.missingFiles.join(', ') || 'none'}\n`);
  process.exitCode = 1;
}
