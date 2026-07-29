// The cases that decide whether this tool is worth having.
//
// A safety warning that fires on ordinary writing gets switched off in a week.
// The whole design rests on one measured fact: run Helmion's destructive-command
// kernel over a whole chat reply and the sentence
//
//     "You should never run rm -rf on a production server without a backup."
//
// comes back blocked. That is advice against the command, not the command.
//
// So the code blocks are pulled out first and only they are checked. These tests
// hold both halves of that in place: the sentence must stay quiet, and a real
// destructive command in a real code block must still be caught.

import test from 'node:test';
import assert from 'node:assert/strict';

import { scanCodeBlock } from '../background/scan.js';
import { detectDestructiveOperation } from '../generated/helmion-governance.generated.js';
import { loadContentScript } from '../test-support/load-content-script.mjs';

const { HelmionExtract } = await loadContentScript('content/extract.js');

// The real path, end to end: a reply as markdown -> fenced blocks -> line scan.
function checkReply(markdown) {
  const blocks = HelmionExtract.extractFencedBlocks(markdown);
  const findings = [];
  for (const block of blocks) {
    const result = scanCodeBlock(block.code);
    findings.push(...result.findings);
  }
  return {
    blocked: findings.length > 0,
    findings,
    lines: findings.map((finding) => finding.text),
    hits: [...new Set(findings.flatMap((finding) => finding.hits))],
  };
}

const PROSE_WARNING = 'You should never run rm -rf on a production server without a backup.';

test('THE CASE THAT DRIVES THE DESIGN: a sentence warning against rm -rf does not fire', () => {
  const reply = [
    'A word of caution before you start.',
    '',
    PROSE_WARNING,
    '',
    'Take a snapshot first and you will be fine.',
  ].join('\n');

  const result = checkReply(reply);
  assert.equal(result.blocked, false, `prose fired a warning: ${JSON.stringify(result.findings)}`);
});

test('POSITIVE CONTROL: that same sentence DOES fire if the kernel is fed the whole reply', () => {
  // This is the measurement the extraction step exists to defeat. If this
  // assertion ever fails, the kernel changed and no longer false-fires on prose
  // — that is good news, not a broken test, but do not delete the extraction
  // step on the strength of it. Re-measure first.
  const verdict = detectDestructiveOperation({ tool_input: { command: PROSE_WARNING } });
  assert.equal(
    verdict.blocked,
    true,
    'the kernel no longer false-fires on this sentence; re-measure before changing anything',
  );
});

test('a real rm -rf inside a fenced block is caught and the exact line is named', () => {
  const reply = [
    'Clear the old build output first:',
    '',
    '```bash',
    'cd /var/www',
    'rm -rf html/*',
    'npm run build',
    '```',
    '',
    'Then redeploy.',
  ].join('\n');

  const result = checkReply(reply);
  assert.equal(result.blocked, true);
  assert.deepEqual(result.lines, ['rm -rf html/*']);
  assert.ok(result.hits.includes('recursive/forced rm'), `hits were ${result.hits.join(', ')}`);
});

test('rm -rf / inside a fenced block is caught', () => {
  const reply = ['```sh', 'rm -rf /', '```'].join('\n');
  const result = checkReply(reply);
  assert.equal(result.blocked, true);
  assert.deepEqual(result.lines, ['rm -rf /']);
});

test('DROP TABLE inside a fenced block is caught — the motivating incident shape', () => {
  const reply = [
    'To reset the environment, run this against the database:',
    '',
    '```sql',
    'DROP TABLE loads;',
    'DROP TABLE drivers;',
    'CREATE TABLE loads (id serial primary key);',
    '```',
  ].join('\n');

  const result = checkReply(reply);
  assert.equal(result.blocked, true);
  assert.deepEqual(result.lines, ['DROP TABLE loads;', 'DROP TABLE drivers;']);
  assert.ok(result.hits.includes('direct SQL DDL'));
});

test('git push --force buried in a long reply is caught', () => {
  const reply = [
    'You have a few options here. The simplest is to rewrite the branch.',
    '',
    'First rebase onto main:',
    '',
    '```bash',
    'git fetch origin',
    'git rebase origin/main',
    '```',
    '',
    'Then publish the rewritten history:',
    '',
    '```bash',
    'git push --force origin main',
    '```',
    '',
    'Anyone else on the branch will need to reset.',
  ].join('\n');

  const result = checkReply(reply);
  assert.equal(result.blocked, true);
  assert.deepEqual(result.lines, ['git push --force origin main']);
  assert.ok(result.hits.includes('git force push'));
});

test('a dangerous command inside inline backticks does not fire — inline code is prose', () => {
  const reply = [
    'The command you are looking for is `rm -rf /` but do not actually run it.',
    '',
    'If you need to clear a table the statement is `DROP TABLE loads;` — again, do not.',
    '',
    'And never `git push --force` to a shared branch.',
  ].join('\n');

  const result = checkReply(reply);
  assert.equal(
    result.blocked,
    false,
    `inline code fired a warning: ${JSON.stringify(result.findings)}`,
  );
});

test('prose about DROP TABLE next to a harmless SELECT block stays quiet', () => {
  const reply = [
    'Do not use DROP TABLE here — you will lose the history. Read the rows instead:',
    '',
    '```sql',
    'SELECT id, status FROM loads WHERE status = \'OPEN\';',
    '```',
  ].join('\n');

  assert.equal(checkReply(reply).blocked, false);
});

test('ordinary install instructions stay quiet', () => {
  const reply = [
    'Install the dependencies and start the dev server:',
    '',
    '```bash',
    'npm install',
    'npm run dev',
    '```',
  ].join('\n');

  assert.equal(checkReply(reply).blocked, false);
});

test('a block that is still streaming, with no closing fence yet, is checked anyway', () => {
  // What the DOM holds mid-reply. Waiting for the closing fence would mean the
  // warning arrives after he has already read the command.
  const partial = ['Here you go:', '', '```bash', 'rm -rf /var/lib/postgresql'].join('\n');
  const result = checkReply(partial);
  assert.equal(result.blocked, true);
  assert.deepEqual(result.lines, ['rm -rf /var/lib/postgresql']);
});

test('a tilde-fenced block is checked the same as a backtick-fenced one', () => {
  const reply = ['~~~bash', 'git clean -fdx', '~~~'].join('\n');
  const result = checkReply(reply);
  assert.equal(result.blocked, true);
  assert.ok(result.hits.includes('git clean'));
});

test('every destructive pattern the kernel carries is reachable through a code block', () => {
  // Not a duplicate of governance.test.mjs. That proves the patterns match.
  // This proves nothing in the extraction path swallows them on the way.
  const cases = [
    ['rm -rf /tmp/x', 'recursive/forced rm'],
    ['rm *', 'rm of a glob'],
    ['Remove-Item -Recurse -Force C:\\build', 'Remove-Item -Recurse/-Force'],
    ['rmdir /S /Q build', 'rmdir /S'],
    ['del /F /Q build\\*', 'cmd del /F, /Q, or /S'],
    ['git reset --hard HEAD~3', 'git reset discard'],
    ['git clean -fdx', 'git clean'],
    ['git push --force origin main', 'git force push'],
    ['git branch -D feature/old', 'git branch force delete'],
    ['git checkout -- src/index.js', 'git checkout/restore discard'],
    ['git worktree remove ../wt-old', 'git worktree remove'],
    ['Clear-Content .\\notes.txt', 'Clear-Content'],
    ['TRUNCATE TABLE loads;', 'direct SQL DDL'],
    ['dd if=/dev/zero of=/dev/sda bs=1M', 'dd device write'],
    ['mkfs.ext4 /dev/sdb1', 'filesystem format'],
  ];

  for (const [command, expectedHit] of cases) {
    const result = checkReply(['```bash', command, '```'].join('\n'));
    assert.equal(result.blocked, true, `not caught through a code block: ${command}`);
    assert.ok(
      result.hits.includes(expectedHit),
      `${command} matched ${result.hits.join(', ')} instead of ${expectedHit}`,
    );
  }
});
