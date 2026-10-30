import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { lintSeparation } from '../lint-separation.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function readTree(dir, base = dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'test') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) readTree(full, base, out);
    else out.push({ path: path.relative(base, full), content: fs.readFileSync(full, 'utf8') });
  }
  return out;
}

test('separation: cora-sandbox config and sources contain no DairyForge references', () => {
  const violations = lintSeparation(readTree(ROOT));
  assert.deepEqual(violations, []);
});

test('separation: lint goes red when an injected reference is present', () => {
  const injected = [{ path: 'config.json', content: '{ "host": "api.' + ['dair', 'yforge'].join('') + '.example" }' }];
  const violations = lintSeparation(injected);
  assert.equal(violations.length, 1);
  assert.equal(violations[0].path, 'config.json');
  assert.equal(violations[0].line, 1);
});
