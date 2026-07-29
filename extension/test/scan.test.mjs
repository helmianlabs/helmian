// The scanning layer on its own.
//
// Two measured facts about the kernel are pinned here, because both are easy to
// get wrong and neither fails loudly on its own.

import test from 'node:test';
import assert from 'node:assert/strict';

import { scanLine, scanCodeBlock, scanBlocks, MAX_LINE_LENGTH } from '../background/scan.js';
import { detectDestructiveOperation } from '../generated/helmion-governance.generated.js';

test('FACT 1: the kernel reads tool_input.command and nothing else', () => {
  // Hand it scraped page text under any other key and it returns blocked:false
  // — no error, no warning, just a silent pass. Getting this mapping wrong
  // would produce an extension that appears to work and checks nothing.
  const command = 'rm -rf /';
  assert.equal(detectDestructiveOperation({ tool_input: { text: command } }).blocked, false);
  assert.equal(detectDestructiveOperation({ tool_input: { code: command } }).blocked, false);
  assert.equal(detectDestructiveOperation({ tool_input: { command } }).blocked, true);
});

test('FACT 2: scanning is per line, so the offending line can be named', () => {
  const result = scanCodeBlock([
    'cd /var/www',
    'rm -rf html/*',
    'npm run build',
  ].join('\n'));

  assert.equal(result.blocked, true);
  assert.equal(result.findings.length, 1);
  assert.equal(result.findings[0].lineNumber, 2);
  assert.equal(result.findings[0].text, 'rm -rf html/*');
});

test('several dangerous lines in one block are all reported', () => {
  const result = scanCodeBlock('DROP TABLE loads;\nDROP TABLE drivers;');
  assert.equal(result.findings.length, 2);
  assert.deepEqual(result.findings.map((f) => f.lineNumber), [1, 2]);
});

test('a clean block reports blocked:false with no findings', () => {
  const result = scanCodeBlock('npm install\nnpm run dev');
  assert.equal(result.blocked, false);
  assert.deepEqual(result.findings, []);
  assert.deepEqual(result.hits, []);
});

test('blank and whitespace-only lines are skipped', () => {
  assert.equal(scanLine('').blocked, false);
  assert.equal(scanLine('   ').blocked, false);
  assert.equal(scanLine('\t').blocked, false);
});

test('a line too long to be a command is skipped and says so', () => {
  const monster = `x${'a'.repeat(MAX_LINE_LENGTH)}`;
  const verdict = scanLine(monster);
  assert.equal(verdict.blocked, false);
  assert.match(verdict.skipped, /over the \d+ limit/);
});

// The cap used to be 4000 characters, and a destructive command padded past it
// was never looked at. Nothing reported that; the block came back clean. These
// two tests are the regression: one proves the command is caught at a length
// that used to bypass the scanner entirely, the other proves that when a line
// genuinely is skipped, the skip survives all the way out of scanCodeBlock
// instead of being dropped on the floor.
test('A PADDED COMMAND IS STILL CAUGHT: 4000+ characters no longer buys a bypass', () => {
  const padded = `rm -rf / ${'#'.repeat(50000)}`;
  assert.equal(scanLine(padded).blocked, true);
  const block = scanCodeBlock(`echo hello\n${padded}`);
  assert.equal(block.blocked, true);
  assert.equal(block.findings[0].lineNumber, 2);
});

test('A SKIPPED LINE IS REPORTED, NOT SWALLOWED: scanCodeBlock carries it out', () => {
  const monster = 'a'.repeat(MAX_LINE_LENGTH + 1);
  const block = scanCodeBlock(`echo hello\n${monster}\necho goodbye`);
  assert.equal(block.blocked, false);
  assert.equal(block.unchecked.length, 1);
  assert.equal(block.unchecked[0].lineNumber, 2);
  assert.match(block.unchecked[0].reason, /over the \d+ limit/);
});

test('a block where everything was checked reports an empty unchecked list', () => {
  const block = scanCodeBlock('echo hello\nnpm install');
  assert.deepEqual(block.unchecked, []);
});

test('scanBlocks carries unchecked through to the caller', () => {
  const monster = 'a'.repeat(MAX_LINE_LENGTH + 1);
  const [result] = scanBlocks([{ id: 'only', text: monster }]);
  assert.equal(result.id, 'only');
  assert.equal(result.unchecked.length, 1);
});

test('indentation does not hide a command', () => {
  assert.equal(scanLine('    rm -rf /var/log').blocked, true);
  assert.equal(scanLine('\t\tgit push --force').blocked, true);
});

test('scanBlocks keeps each block id attached to its verdict', () => {
  const results = scanBlocks([
    { id: 'a', text: 'npm install' },
    { id: 'b', text: 'rm -rf /' },
    { id: 'c', text: 'git status' },
  ]);

  assert.deepEqual(results.map((r) => r.id), ['a', 'b', 'c']);
  assert.deepEqual(results.map((r) => r.blocked), [false, true, false]);
  assert.equal(results[1].findings[0].text, 'rm -rf /');
});

test('scanBlocks tolerates a block with no text rather than throwing', () => {
  const results = scanBlocks([{ id: 'a' }, { id: 'b', text: null }]);
  assert.deepEqual(results.map((r) => r.blocked), [false, false]);
});

test('scanBlocks refuses anything that is not a list', () => {
  assert.throws(() => scanBlocks(null), /expects an array/);
  assert.throws(() => scanBlocks('rm -rf /'), /expects an array/);
});

test('the self-test probes guard.js uses give the answers it expects', () => {
  // guard.js runs these two through the whole chain on every page load. If the
  // first stops being flagged the detection is dead; if the second starts being
  // flagged the tool is stuck warning about everything. Both must hold.
  assert.equal(scanCodeBlock('rm -rf /helmion-selftest-probe').blocked, true);
  assert.equal(scanCodeBlock('echo helmion-selftest-probe').blocked, false);
});
