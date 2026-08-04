// The quotes were the bypass.
//
// commandSkeleton() replaces every quoted string with <STR> before the
// destructive patterns run. For prose that is exactly right — it is what keeps a
// log line that merely mentions `rm -rf` from firing, and that false positive is
// the one that gets a safety tool switched off.
//
// But when the quoted string is not prose, it is the payload. Measured
// 2026-08-03 against the kernel as it then stood, every one of these returned
// blocked:false while the identical unquoted command was blocked:
//
//     bash -c "rm -rf /data"                skeleton: `bash -c  <STR> `
//     sh -c 'rm -rf ~'                      skeleton: `sh -c  <STR> `
//     ssh host "rm -rf /var/www"            skeleton: `ssh host  <STR> `
//     docker run img sh -c "rm -rf /app"    skeleton: `docker run img sh -c  <STR> `
//
// Each of those pastes and runs verbatim. The fix re-runs the pattern list
// against the quoted contents, but only when the command carries a sink that
// would actually execute them — the same shape SQL_EXECUTION_CONTEXT already
// used for `node -e "...DDL..."`.
//
// The must-NOT-block half of this file is not decoration. Re-inspecting quoted
// text is exactly the change that could flood the tool with false positives, so
// every case below pins a real command or a real sentence that has to stay
// clean. If a future tightening breaks one of those, it breaks here first.

import test from 'node:test';
import assert from 'node:assert/strict';

import { detectDestructiveOperation } from '../src/core/governance.mjs';

const verdict = (command) => detectDestructiveOperation({ tool_input: { command } });

const EVASIONS = [
  ['bash -c with a double-quoted payload', 'bash -c "rm -rf /data"'],
  ['sh -c with a single-quoted payload', "sh -c 'rm -rf ~'"],
  ['ssh running a bare remote command', 'ssh host "rm -rf /var/www"'],
  ['a nested sh -c inside docker run', 'docker run img sh -c "rm -rf /app"'],
  ['kubectl exec into a pod', 'kubectl exec pod -- sh -c "rm -rf /app"'],
  ['cmd /c with a quoted del', 'cmd /c "del /f /q C:\\data"'],
  ['sudo -c', 'sudo -c "rm -rf /"'],
];

for (const [name, command] of EVASIONS) {
  test(`a destructive command hidden in a quoted payload is caught: ${name}`, () => {
    const result = verdict(command);
    assert.equal(result.blocked, true, `${command} was not blocked`);
    assert.ok(
      result.hits.some((hit) => /quoted shell payload/.test(hit)),
      `${command} was blocked, but not for the reason under test: ${result.hits.join(', ')}`,
    );
  });
}

test('POSITIVE CONTROL: the same command unquoted is still blocked', () => {
  // If this ever fails, the tests above are passing for the wrong reason.
  assert.equal(verdict('rm -rf /data').blocked, true);
});

const MUST_STAY_CLEAN = [
  ['prose about a dangerous command', 'echo "this doc explains rm -rf and why it is dangerous"'],
  ['prose that names a sink AND a command', 'echo "ssh to the box and rm -rf it yourself"'],
  ['a quoted search term', 'grep -r "rm -rf" docs/'],
  ['a harmless remote command', 'ssh host "uptime"'],
  ['a harmless -c payload', 'bash -c "npm test"'],
  ['an ordinary build', 'npm run build'],
  ['an ordinary status check', 'git status'],
];

for (const [name, command] of MUST_STAY_CLEAN) {
  test(`re-inspecting quotes does not create a false positive: ${name}`, () => {
    const result = verdict(command);
    assert.equal(
      result.blocked,
      false,
      `${command} was blocked and should not have been: ${result.hits.join(', ')}`,
    );
  });
}

test('the sink is matched on the skeleton, so quoted prose cannot arm it', () => {
  // The distinction this file turns on. `echo "ssh ... rm -rf ..."` mentions a
  // sink and a destructive command, but both live INSIDE the quotes, so the
  // skeleton is just `echo <STR>` and nothing is re-inspected. Testing the sink
  // against the raw command instead would flag every sentence about ssh.
  assert.equal(verdict('echo "ssh to the box and rm -rf it yourself"').blocked, false);
  assert.equal(verdict('ssh host "rm -rf /var/www"').blocked, true);
});

test('the git patterns do not backtrack quadratically', () => {
  // These carried two unbounded [^;&|]* spans around a literal until 2026-08-03.
  // Measured then: 18 KB → 35 ms, 36 KB → 135 ms, 72 KB → 530 ms, 144 KB →
  // 2,099 ms. A clean 4x per doubling, which against the extension's line cap is
  // about a minute and a half of frozen service worker for a single line — and
  // content/guard.js resubmits a block that timed out, so the stall never
  // clears. The spans are bounded now; the same input costs single-digit ms.
  //
  // The threshold is deliberately loose. This test exists to catch a return to
  // QUADRATIC growth, not to police millisecond jitter on a busy machine.
  const input = `git ${'clean '.repeat(24000)}X`;
  const started = process.hrtime.bigint();
  detectDestructiveOperation({ tool_input: { command: input } });
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
  assert.ok(
    elapsedMs < 500,
    `a ${input.length}-character line took ${elapsedMs.toFixed(1)}ms — the quadratic backtracking is back`,
  );
});
