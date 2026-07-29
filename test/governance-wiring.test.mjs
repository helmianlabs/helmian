import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createToolRuntime } from '../src/agent/tools.mjs';

/**
 * Proof that the governance kernel is actually WIRED to tool execution.
 *
 * Every block assertion here is paired with a side-effect assertion: it is not
 * enough that a refusal string came back, the thing the command would have
 * destroyed has to still be on disk. A test that only reads the return value
 * cannot tell "refused" from "ran, then said no".
 *
 * `src/core/governance-gate.mjs` is imported dynamically, never at the top of
 * this file, so that running this suite against the PRE-WIRING tools.mjs
 * exercises the behavioural tests for real instead of dying at module load.
 */

const isWindows = process.platform === 'win32';

/** A command that really deletes `dir` AND matches a built-in destructive pattern. */
function recursiveDeleteCommand(dir) {
  return isWindows ? `Remove-Item -Recurse -Force ${dir}` : `rm -rf ${dir}`;
}

/** A command that really creates `file` and matches nothing in the kernel. */
function createFileCommand(file) {
  return isWindows
    ? `Set-Content -Path ${file} -Value ok`
    : `printf ok > ${file}`;
}

function makeWorkspace() {
  return mkdtempSync(join(tmpdir(), 'helmion-gov-'));
}

function cleanup(dir) {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // A locked temp dir must never fail a passing test.
  }
}

/** Write a promoted-rules file in the workspace, in the shape bin/helmion.mjs reads. */
function writeRules(workspace, rules) {
  const dir = join(workspace, '.helmion');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'autonomy_rules.json'),
    typeof rules === 'string' ? rules : JSON.stringify({ promoted_rules: rules }, null, 2),
    'utf8',
  );
}

function isRefusal(result) {
  return /BLOCKED by Helmion governance/i.test(String(result));
}

// ---------------------------------------------------------------------------
// 1. THE CORE POSITIVE CONTROL
//    Against unwired tools.mjs this FAILS: the directory is gone.
// ---------------------------------------------------------------------------

test('a recursive delete through runtime.execute is refused and the target survives', async () => {
  const workspace = makeWorkspace();
  try {
    const doomed = join(workspace, 'doomed');
    mkdirSync(doomed, { recursive: true });
    const keep = join(doomed, 'keep.txt');
    writeFileSync(keep, 'this file must survive', 'utf8');

    const runtime = createToolRuntime(workspace, { permissionMode: 'full' });
    const result = await runtime.execute('run_command', {
      command: recursiveDeleteCommand('doomed'),
    });

    // Side effect FIRST — this is the assertion that actually proves refusal.
    assert.equal(
      existsSync(keep),
      true,
      'THE DESTRUCTIVE COMMAND RAN: keep.txt was deleted, so governance did not block it',
    );
    assert.equal(existsSync(doomed), true, 'the doomed directory was deleted');
    assert.equal(isRefusal(result), true, `expected a governance refusal, got: ${result}`);
    assert.match(String(result), /did NOT run/i);
  } finally {
    cleanup(workspace);
  }
});

test('the refusal names the destructive pattern that matched', async () => {
  const workspace = makeWorkspace();
  try {
    const runtime = createToolRuntime(workspace, { permissionMode: 'full' });
    const result = await runtime.execute('run_command', {
      command: 'git reset --hard HEAD~5',
    });
    assert.equal(isRefusal(result), true, `expected a refusal, got: ${result}`);
    assert.match(String(result), /git reset discard/i);
  } finally {
    cleanup(workspace);
  }
});

test('an indirect SQL DROP inside a node -e string is refused', async () => {
  const workspace = makeWorkspace();
  try {
    const runtime = createToolRuntime(workspace, { permissionMode: 'full' });
    const result = await runtime.execute('run_command', {
      command: 'node -e "db.query(\'DROP TABLE loads\')"',
    });
    assert.equal(isRefusal(result), true, `expected a refusal, got: ${result}`);
  } finally {
    cleanup(workspace);
  }
});

// ---------------------------------------------------------------------------
// 2. ORDINARY WORK IS UNTOUCHED
// ---------------------------------------------------------------------------

test('ordinary reads, writes, listings and commands still run normally', async () => {
  const workspace = makeWorkspace();
  try {
    writeFileSync(join(workspace, 'readme.txt'), 'hello helmion', 'utf8');
    const runtime = createToolRuntime(workspace, { permissionMode: 'full' });

    const read = await runtime.execute('read_file', { path: 'readme.txt' });
    assert.equal(read, 'hello helmion');

    const listed = await runtime.execute('list_dir', { path: '.' });
    assert.match(listed, /readme\.txt/);

    const searched = await runtime.execute('search_text', { query: 'helmion' });
    assert.match(searched, /readme\.txt:1/);

    const written = await runtime.execute('write_file', {
      path: 'notes/plan.md',
      content: '# plan\nship it\n',
    });
    assert.match(written, /^Wrote \d+ bytes/);
    assert.equal(existsSync(join(workspace, 'notes', 'plan.md')), true, 'the write did not land');

    const echoed = await runtime.execute('run_command', { command: 'node --version' });
    assert.match(echoed, /v\d+\./, 'a normal build-style command must still run');
    assert.match(echoed, /exit_code=0/);

    const created = await runtime.execute('run_command', {
      command: createFileCommand('made.txt'),
    });
    assert.equal(isRefusal(created), false, 'an ordinary command was wrongly refused');
    assert.equal(existsSync(join(workspace, 'made.txt')), true, 'an ordinary command did not run');
  } finally {
    cleanup(workspace);
  }
});

test('a command that merely discusses rm -rf in a quoted string is not refused', async () => {
  const workspace = makeWorkspace();
  try {
    const runtime = createToolRuntime(workspace, { permissionMode: 'full' });
    const result = await runtime.execute('run_command', {
      command: 'node -e "console.log(\'we no longer use rm -rf here\')"',
    });
    assert.equal(isRefusal(result), false, `false positive on prose: ${result}`);
    assert.match(result, /we no longer use/);
  } finally {
    cleanup(workspace);
  }
});

// ---------------------------------------------------------------------------
// 3. PROMOTED RULES (the second half of the kernel)
// ---------------------------------------------------------------------------

test('a promoted block rule refuses run_command and the side effect is absent', async () => {
  const workspace = makeWorkspace();
  try {
    writeRules(workspace, [{ pattern: 'made\\.txt', severity: 'block', project_slug: null }]);
    const runtime = createToolRuntime(workspace, { permissionMode: 'full' });

    const result = await runtime.execute('run_command', {
      command: createFileCommand('made.txt'),
    });

    assert.equal(
      existsSync(join(workspace, 'made.txt')),
      false,
      'THE COMMAND RAN: a promoted block rule did not stop it',
    );
    assert.equal(isRefusal(result), true, `expected a refusal, got: ${result}`);
    assert.match(String(result), /promoted block rule/i);
  } finally {
    cleanup(workspace);
  }
});

test('a promoted FLAG rule does not block — only severity block blocks', async () => {
  const workspace = makeWorkspace();
  try {
    writeRules(workspace, [{ pattern: 'made\\.txt', severity: 'flag', project_slug: null }]);
    const runtime = createToolRuntime(workspace, { permissionMode: 'full' });

    const result = await runtime.execute('run_command', {
      command: createFileCommand('made.txt'),
    });
    assert.equal(isRefusal(result), false, `a flag rule wrongly blocked: ${result}`);
    assert.equal(existsSync(join(workspace, 'made.txt')), true, 'a flag rule stopped ordinary work');
  } finally {
    cleanup(workspace);
  }
});

test('a rule scoped to another project_slug does not block this workspace', async () => {
  const workspace = makeWorkspace();
  try {
    writeRules(workspace, [
      { pattern: 'made\\.txt', severity: 'block', project_slug: 'some-other-project' },
    ]);
    const runtime = createToolRuntime(workspace, {
      permissionMode: 'full',
      projectSlug: 'this-project',
    });
    const result = await runtime.execute('run_command', {
      command: createFileCommand('made.txt'),
    });
    assert.equal(isRefusal(result), false, `a foreign-project rule wrongly blocked: ${result}`);
    assert.equal(existsSync(join(workspace, 'made.txt')), true);
  } finally {
    cleanup(workspace);
  }
});

// ---------------------------------------------------------------------------
// 4. write_file IS GOVERNED TOO
//    An agent overwriting a human's file is the 2026-07-28 BASE_RULES.md loss.
// ---------------------------------------------------------------------------

test('a promoted block rule on a path refuses write_file and the file is untouched', async () => {
  const workspace = makeWorkspace();
  try {
    const victim = join(workspace, 'BASE_RULES.md');
    writeFileSync(victim, 'ORIGINAL RULES — must survive', 'utf8');
    writeRules(workspace, [{ pattern: 'BASE_RULES\\.md', severity: 'block', project_slug: null }]);

    const runtime = createToolRuntime(workspace, { permissionMode: 'full' });
    const result = await runtime.execute('write_file', {
      path: 'BASE_RULES.md',
      content: 'clobbered by an agent',
    });

    assert.equal(
      readOrEmpty(victim),
      'ORIGINAL RULES — must survive',
      'THE WRITE LANDED: governance did not gate write_file',
    );
    assert.equal(isRefusal(result), true, `expected a refusal, got: ${result}`);
  } finally {
    cleanup(workspace);
  }
});

test('write_file content is scanned, not just the path', async () => {
  const workspace = makeWorkspace();
  try {
    writeRules(workspace, [{ pattern: 'AWS_SECRET_HARDCODE', severity: 'block', project_slug: null }]);
    const runtime = createToolRuntime(workspace, { permissionMode: 'full' });
    const result = await runtime.execute('write_file', {
      path: 'config.js',
      content: 'export const k = "AWS_SECRET_HARDCODE";',
    });
    assert.equal(existsSync(join(workspace, 'config.js')), false, 'the governed write landed');
    assert.equal(isRefusal(result), true, `expected a refusal, got: ${result}`);
  } finally {
    cleanup(workspace);
  }
});

test('with no promoted rules, an ordinary write_file is never blocked', async () => {
  const workspace = makeWorkspace();
  try {
    const runtime = createToolRuntime(workspace, { permissionMode: 'full' });
    const result = await runtime.execute('write_file', {
      path: 'src/app.js',
      content: 'export const app = 1;\n',
    });
    assert.equal(isRefusal(result), false, `ordinary write wrongly refused: ${result}`);
    assert.equal(existsSync(join(workspace, 'src', 'app.js')), true);
  } finally {
    cleanup(workspace);
  }
});

// ---------------------------------------------------------------------------
// 5. FAIL CLOSED
// ---------------------------------------------------------------------------

test('a malformed promoted-rules file refuses ordinary work rather than running it', async () => {
  const workspace = makeWorkspace();
  try {
    writeRules(workspace, '{ this is not valid json ');
    const runtime = createToolRuntime(workspace, { permissionMode: 'full' });

    const result = await runtime.execute('run_command', {
      command: createFileCommand('made.txt'),
    });

    assert.equal(
      existsSync(join(workspace, 'made.txt')),
      false,
      'FAIL OPEN: a broken rules file let the command run',
    );
    assert.equal(isRefusal(result), true, `expected a refusal, got: ${result}`);
    assert.match(String(result), /fails closed/i);
  } finally {
    cleanup(workspace);
  }
});

test('an unreadable rules path (a directory) refuses rather than running', async () => {
  const workspace = makeWorkspace();
  try {
    // .helmion/autonomy_rules.json exists — as a DIRECTORY. readFileSync throws EISDIR.
    mkdirSync(join(workspace, '.helmion', 'autonomy_rules.json'), { recursive: true });
    const runtime = createToolRuntime(workspace, { permissionMode: 'full' });

    const result = await runtime.execute('run_command', {
      command: createFileCommand('made.txt'),
    });
    assert.equal(existsSync(join(workspace, 'made.txt')), false, 'FAIL OPEN on an unreadable rules file');
    assert.equal(isRefusal(result), true, `expected a refusal, got: ${result}`);
  } finally {
    cleanup(workspace);
  }
});

test('a rules file that is not a list of rules refuses rather than running', async () => {
  const workspace = makeWorkspace();
  try {
    writeRules(workspace, '{ "promoted_rules": "block everything" }');
    const runtime = createToolRuntime(workspace, { permissionMode: 'full' });
    const result = await runtime.execute('run_command', {
      command: createFileCommand('made.txt'),
    });
    assert.equal(existsSync(join(workspace, 'made.txt')), false, 'FAIL OPEN on a malformed rule list');
    assert.equal(isRefusal(result), true, `expected a refusal, got: ${result}`);
  } finally {
    cleanup(workspace);
  }
});

test('a rule with an invalid regular expression refuses rather than silently doing nothing', async () => {
  const workspace = makeWorkspace();
  try {
    // evaluateRules downgrades an unparseable pattern to a FLAG. A rule an
    // operator wrote to BLOCK must never become a no-op because of a typo.
    writeRules(workspace, [{ pattern: 'made(', severity: 'block', project_slug: null }]);
    const runtime = createToolRuntime(workspace, { permissionMode: 'full' });

    const result = await runtime.execute('run_command', {
      command: createFileCommand('made.txt'),
    });
    assert.equal(
      existsSync(join(workspace, 'made.txt')),
      false,
      'FAIL OPEN: an unparseable block rule became a no-op and the command ran',
    );
    assert.equal(isRefusal(result), true, `expected a refusal, got: ${result}`);
    assert.match(String(result), /invalid regular expression/i);
  } finally {
    cleanup(workspace);
  }
});

test('a kernel that throws while evaluating refuses rather than executing', async () => {
  const workspace = makeWorkspace();
  try {
    const runtime = createToolRuntime(workspace, { permissionMode: 'full' });

    // collectStrings() recurses without a cycle guard, so a self-referencing
    // argument object makes the kernel throw RangeError. structuredClone in
    // cloneArgs preserves the cycle, so this reaches the kernel intact.
    const args = { command: createFileCommand('pwned.txt') };
    args.self = args;

    const result = await runtime.execute('run_command', args);

    assert.equal(
      existsSync(join(workspace, 'pwned.txt')),
      false,
      'FAIL OPEN: a thrown kernel let the command execute',
    );
    assert.equal(isRefusal(result), true, `expected a refusal, got: ${result}`);
    assert.match(String(result), /fails closed/i);
  } finally {
    cleanup(workspace);
  }
});

// ---------------------------------------------------------------------------
// 6. GOVERNANCE BEATS APPROVAL
// ---------------------------------------------------------------------------

test('a human "allow" cannot override a governance block, and is never even asked', async () => {
  const workspace = makeWorkspace();
  try {
    const doomed = join(workspace, 'doomed');
    mkdirSync(doomed, { recursive: true });
    writeFileSync(join(doomed, 'keep.txt'), 'must survive', 'utf8');

    const asked = [];
    const runtime = createToolRuntime(workspace, {
      permissionMode: 'ask',
      // The most permissive approver possible: says yes to everything, forever.
      approver: async (req) => {
        asked.push(req.tool);
        return 'allow-session';
      },
    });

    const result = await runtime.execute('run_command', {
      command: recursiveDeleteCommand('doomed'),
    });

    assert.equal(
      existsSync(join(doomed, 'keep.txt')),
      true,
      'A HUMAN ALLOW OVERRODE A HARD BLOCK: the delete ran',
    );
    assert.equal(isRefusal(result), true, `expected a refusal, got: ${result}`);
    assert.deepEqual(asked, [], 'governance must decide BEFORE a human is asked, not after');
    assert.match(String(result), /no human approval can override/i);
  } finally {
    cleanup(workspace);
  }
});

test('a session grant already held does not launder a governance block', async () => {
  const workspace = makeWorkspace();
  try {
    const doomed = join(workspace, 'doomed');
    mkdirSync(doomed, { recursive: true });
    writeFileSync(join(doomed, 'keep.txt'), 'must survive', 'utf8');

    const runtime = createToolRuntime(workspace, {
      permissionMode: 'ask',
      approver: async () => 'allow-session',
    });

    // Earn a real session grant on run_command with an ordinary command first.
    const ok = await runtime.execute('run_command', { command: createFileCommand('made.txt') });
    assert.equal(isRefusal(ok), false, `setup command was refused: ${ok}`);
    assert.deepEqual([...runtime.grantedTools], ['run_command'], 'session grant was not established');

    // Now the same tool, holding a live grant, tries something destructive.
    const result = await runtime.execute('run_command', {
      command: recursiveDeleteCommand('doomed'),
    });
    assert.equal(existsSync(join(doomed, 'keep.txt')), true, 'a session grant bypassed governance');
    assert.equal(isRefusal(result), true, `expected a refusal, got: ${result}`);
  } finally {
    cleanup(workspace);
  }
});

test('ask mode still denies an ordinary call when the human says no', async () => {
  const workspace = makeWorkspace();
  try {
    const runtime = createToolRuntime(workspace, {
      permissionMode: 'ask',
      approver: async () => 'deny',
    });
    const result = await runtime.execute('write_file', { path: 'nope.txt', content: 'x' });
    assert.equal(existsSync(join(workspace, 'nope.txt')), false);
    assert.match(String(result), /DENIED/, 'the ask tier must still be the one that answers here');
    assert.equal(isRefusal(result), false, 'an ordinary denial must not masquerade as a hard block');
  } finally {
    cleanup(workspace);
  }
});

// ---------------------------------------------------------------------------
// 7. THE SHARED LOADER — same path contract as bin/helmion.mjs guard
// ---------------------------------------------------------------------------

test('the rules loader reuses the HELMION_RULES_PATH override', async () => {
  const { loadPromotedRules, resolveRulesPath } = await import('../src/core/governance-gate.mjs');
  const workspace = makeWorkspace();
  const previous = process.env.HELMION_RULES_PATH;
  try {
    const external = join(workspace, 'elsewhere.json');
    writeFileSync(external, JSON.stringify({ promoted_rules: [{ pattern: 'x', severity: 'block' }] }), 'utf8');
    process.env.HELMION_RULES_PATH = external;

    assert.equal(resolveRulesPath(workspace), external);
    assert.deepEqual(loadPromotedRules(workspace), [{ pattern: 'x', severity: 'block' }]);
  } finally {
    if (previous === undefined) delete process.env.HELMION_RULES_PATH;
    else process.env.HELMION_RULES_PATH = previous;
    cleanup(workspace);
  }
});

test('the loader accepts all three shapes bin/helmion.mjs accepts', async () => {
  const { loadPromotedRules } = await import('../src/core/governance-gate.mjs');
  const workspace = makeWorkspace();
  try {
    const rule = { pattern: 'x', severity: 'block' };

    writeRules(workspace, '[{"pattern":"x","severity":"block"}]');
    assert.deepEqual(loadPromotedRules(workspace), [rule], 'a bare array must load');

    writeRules(workspace, JSON.stringify({ promoted_rules: [rule] }));
    assert.deepEqual(loadPromotedRules(workspace), [rule], 'promoted_rules must load');

    writeRules(workspace, JSON.stringify({ rules: [rule] }));
    assert.deepEqual(loadPromotedRules(workspace), [rule], 'rules must load');
  } finally {
    cleanup(workspace);
  }
});

test('a workspace with no rules file yields no promoted rules, and built-ins still apply', async () => {
  const { loadPromotedRules } = await import('../src/core/governance-gate.mjs');
  const workspace = makeWorkspace();
  try {
    assert.deepEqual(loadPromotedRules(workspace), []);

    // An absent rules file is a defined state (bin/helmion.mjs:405 returns []),
    // NOT a load failure — the built-in destructive kernel still governs.
    const runtime = createToolRuntime(workspace, { permissionMode: 'full' });
    const ordinary = await runtime.execute('run_command', { command: 'node --version' });
    assert.equal(isRefusal(ordinary), false, 'no rules file must not block ordinary work');

    const destructive = await runtime.execute('run_command', {
      command: recursiveDeleteCommand('anything'),
    });
    assert.equal(isRefusal(destructive), true, 'built-in patterns must apply with no rules file');
  } finally {
    cleanup(workspace);
  }
});

function readOrEmpty(path) {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return '';
  }
}
