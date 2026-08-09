import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { evaluateToolCall } from '../src/core/governance-gate.mjs';

const REPO_ROOT = resolve(fileURLToPath(new URL('../', import.meta.url)));

/**
 * Two things the Pilot's "/ commands" button depends on, neither of which had a
 * test before 2026-07-30.
 *
 * 1. THE LISTING MUST DESCRIBE THE USER'S WORKSPACE. The desktop spawns this
 *    bridge with its working directory and WORKSPACE_PATH both set to the
 *    Helmion repo root (AgentBridge.cs EnsureStartedAsync), and the `commands`
 *    branch used to re-scan whatever root the process started in. So the button
 *    listed Helmion's own commands while the user was working somewhere else,
 *    and every command in their actual project was missing from a list whose
 *    tooltip said "the slash commands available in this workspace".
 *
 * 2. A SLASH LINE MUST ACTUALLY EXPAND ON THE WAY INTO A TURN. The expansion at
 *    the top of the `turn` branch is the entire dispatcher for slash commands —
 *    nothing else runs a command file — and no test drove a "/" line through it.
 *    Four existing tests send `cmd: 'turn'`; all four send ordinary prose.
 */

function startBridge({ cwd, env = {} }) {
  const child = spawn(
    process.execPath,
    [join(REPO_ROOT, 'bin', 'helmion.mjs'), 'agent-bridge'],
    { cwd, env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'] },
  );

  const events = [];
  const waiters = [];
  let buffer = '';

  child.stdout.on('data', (chunk) => {
    buffer += chunk.toString();
    let index = buffer.indexOf('\n');
    while (index >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (line) {
        let ev = null;
        try { ev = JSON.parse(line); } catch { /* ignore noise */ }
        if (ev) {
          events.push(ev);
          for (const w of [...waiters]) {
            if (w.match(ev)) {
              waiters.splice(waiters.indexOf(w), 1);
              w.resolve(ev);
            }
          }
        }
      }
      index = buffer.indexOf('\n');
    }
  });

  return {
    events,
    send(obj) { child.stdin.write(`${JSON.stringify(obj)}\n`); },
    waitFor(match, ms = 25_000) {
      const hit = events.find(match);
      if (hit) return Promise.resolve(hit);
      return new Promise((resolvePromise, reject) => {
        const timer = setTimeout(
          () => reject(new Error(`timed out; saw: ${events.map((e) => e.event).join(', ')}`)),
          ms,
        );
        waiters.push({ match, resolve: (ev) => { clearTimeout(timer); resolvePromise(ev); } });
      });
    },
    async stop() {
      child.stdin.end();
      await new Promise((r) => { child.on('close', r); setTimeout(r, 3000); });
      if (!child.killed) child.kill();
    },
  };
}

/** A project command file, exactly as `helmion` discovers them. */
function writeProjectCommand(workspace, name, body) {
  const dir = join(workspace, '.helmion', 'commands');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${name}.md`), body, 'utf8');
}

describe('agent-bridge lists commands for the workspace it was asked about', () => {
  test('a workspace on the request is scanned instead of the folder the process started in', {
    timeout: 60_000,
  }, async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'helmion-cmdws-'));
    writeProjectCommand(
      workspace,
      'audit-probe',
      '---\ndescription: Probe used by the workspace listing test\n---\nProbe body.\n',
    );

    // Spawn the way the DESKTOP spawns it: cwd and WORKSPACE_PATH both pinned to
    // the Helmion repo root, nowhere near the user's project.
    const bridge = startBridge({
      cwd: REPO_ROOT,
      env: { WORKSPACE_PATH: REPO_ROOT, HELMION_WORKSPACE_PATH: REPO_ROOT },
    });

    try {
      // Baseline: with no workspace named, the answer is about the repo root.
      // This is the OLD behaviour and it is still correct for a caller that did
      // not say which folder it meant.
      bridge.send({ cmd: 'commands' });
      const bare = await bridge.waitFor((e) => e.event === 'commands');
      assert.notEqual(
        bare.workspace,
        workspace,
        'without a workspace the listing is not about the user project',
      );
      assert.ok(
        !(bare.commands ?? []).some((c) => c.name === 'audit-probe'),
        'the user project command is absent from the repo-root listing',
      );

      // THE ONE THAT WAS FAILING. Name the workspace and the listing must be
      // about THAT folder.
      //
      // Waits for the SECOND `commands` event by count, never for one whose
      // workspace already differs: the latter cannot distinguish "the bridge
      // ignored my workspace" from "the answer has not arrived yet", so a
      // regression would fail as a 25-second timeout naming nothing instead of
      // as an assertion naming the folder it got.
      const before = bridge.events.filter((e) => e.event === 'commands').length;
      bridge.send({ cmd: 'commands', workspace });
      await bridge.waitFor(
        (e) => e.event === 'commands'
          && bridge.events.filter((x) => x.event === 'commands').length > before,
      );
      const scoped = bridge.events.filter((e) => e.event === 'commands').at(-1);

      assert.equal(
        scoped.workspace,
        workspace,
        'the listing names the workspace it was asked about',
      );
      assert.ok(
        (scoped.commands ?? []).some((c) => c.name === 'audit-probe'),
        'a command file in the requested workspace appears in the listing',
      );
    } finally {
      await bridge.stop();
      rmSync(workspace, { recursive: true, force: true });
    }
  });
});

describe('agent-bridge expands a slash command on the way into a turn', () => {
  test('a "/name args" line reaches the model as the command body, not as typed', {
    timeout: 60_000,
  }, async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'helmion-cmdexpand-'));

    // $ARGUMENTS is the whole argument string as typed, so the prompt the model
    // receives proves BOTH that the file was found and that arguments were
    // substituted into it.
    writeProjectCommand(
      workspace,
      'shipit',
      '---\ndescription: Ship it\n---\nRelease the build to $ARGUMENTS and report back.\n',
    );

    const seen = [];
    const server = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        const parsed = JSON.parse(body || '{}');
        seen.push(parsed.messages ?? []);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          id: 'chatcmpl-expand',
          object: 'chat.completion',
          model: parsed.model || 'stub',
          choices: [{
            index: 0,
            message: { role: 'assistant', content: 'ack' },
            finish_reason: 'stop',
          }],
        }));
      });
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const { port } = server.address();

    writeFileSync(
      join(workspace, '.env'),
      `HELMION_CUSTOM_PROVIDERS=${JSON.stringify([{
        name: 'expand-endpoint',
        baseUrl: `http://127.0.0.1:${port}/v1`,
        apiKey: 'expand-key',
        model: 'stub-model',
      }])}\n`,
      'utf8',
    );

    const bridge = startBridge({ cwd: workspace });

    try {
      bridge.send({
        cmd: 'configure',
        workspace,
        provider: 'expand-endpoint',
        permission: 'read-only',
      });
      await bridge.waitFor((e) => e.event === 'ready');

      bridge.send({ cmd: 'turn', workspace, text: '/shipit staging' });
      await bridge.waitFor((e) => e.event === 'done');

      // The bridge announces that the turn began as a command.
      const announced = bridge.events.find((e) => e.event === 'command');
      assert.ok(announced, 'the bridge says the turn began as a slash command');
      assert.equal(announced.name, 'shipit');

      assert.equal(seen.length, 1, 'the turn reached the provider');
      const sent = JSON.stringify(seen[0]);
      assert.ok(
        sent.includes('Release the build to staging and report back.'),
        `the model received the expanded command body; got: ${sent}`,
      );
      assert.ok(
        !sent.includes('/shipit staging'),
        'the raw slash line is not what was sent',
      );
    } finally {
      await bridge.stop();
      server.close();
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  test('the first turn after a workspace switch refreshes scope and command files', {
    timeout: 60_000,
  }, async () => {
    const workspaceA = mkdtempSync(join(tmpdir(), 'helmion-switch-a-'));
    const workspaceB = mkdtempSync(join(tmpdir(), 'helmion-switch-b-'));
    writeProjectCommand(workspaceA, 'scope', 'SCOPE-COMMAND-FROM-A\n');
    writeProjectCommand(workspaceB, 'scope', 'SCOPE-COMMAND-FROM-B\n');

    const seen = [];
    const server = createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => {
        const parsed = JSON.parse(body || '{}');
        seen.push(parsed.messages ?? []);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          id: 'chatcmpl-workspace-switch',
          object: 'chat.completion',
          model: parsed.model || 'stub',
          choices: [{
            index: 0,
            message: { role: 'assistant', content: 'ack' },
            finish_reason: 'stop',
          }],
        }));
      });
    });
    await new Promise((resolvePromise) => server.listen(0, '127.0.0.1', resolvePromise));
    const { port } = server.address();

    const bridge = startBridge({ cwd: REPO_ROOT });
    const customProviders = [{
      name: 'workspace-switch-endpoint',
      baseUrl: `http://127.0.0.1:${port}/v1`,
      apiKey: 'workspace-switch-key',
      model: 'stub-model',
    }];

    try {
      bridge.send({
        cmd: 'configure',
        workspace: workspaceA,
        provider: 'workspace-switch-endpoint',
        permission: 'read-only',
        customProviders,
      });
      await bridge.waitFor((event) => event.event === 'ready' && event.workspace === workspaceA);

      bridge.send({ cmd: 'turn', workspace: workspaceA, text: '/scope' });
      await bridge.waitFor((event) => event.event === 'done');

      const doneBeforeSwitch = bridge.events.filter((event) => event.event === 'done').length;
      bridge.send({ cmd: 'turn', workspace: workspaceB, text: '/scope' });
      const confirmed = await bridge.waitFor(
        (event) => event.event === 'ready' && event.workspace === workspaceB,
      );
      await bridge.waitFor(
        () => bridge.events.filter((event) => event.event === 'done').length > doneBeforeSwitch,
      );

      assert.equal(confirmed.workspace, workspaceB,
        'the bridge confirms the new workspace before the provider turn');
      assert.equal(seen.length, 2, 'both scoped turns reached the provider');
      assert.match(JSON.stringify(seen[0]), /SCOPE-COMMAND-FROM-A/);
      assert.match(JSON.stringify(seen[1]), /SCOPE-COMMAND-FROM-B/,
        'the first turn in B expands B command files');
      assert.doesNotMatch(JSON.stringify(seen[1]), /SCOPE-COMMAND-FROM-A/,
        'neither A command content nor A conversation history leaks into B');
    } finally {
      await bridge.stop();
      server.close();
      rmSync(workspaceA, { recursive: true, force: true });
      rmSync(workspaceB, { recursive: true, force: true });
    }
  });
});

describe('the governance gate reads the rules of the workspace it is given', () => {
  /**
   * A REBUTTAL PIN, not a fix.
   *
   * It was reported that because the desktop stamps WORKSPACE_PATH to the
   * Helmion repo root (AgentBridge.cs EnsureStartedAsync), every agent session
   * is governed by Helmion's own .helmion/autonomy_rules.json rather than the
   * project's. Traced against code, that is not what happens on the path that
   * matters: AgentBridge.TurnAsync sends `workspace` with every turn
   * (AgentBridge.cs:150-152); the bridge adopts it and forces a reset when it
   * differs (bridge.mjs turn branch); reconfigure() calls resetSessionState,
   * which rebuilds the tool runtime at that root (loop.mjs resetSessionState ->
   * createToolRuntime); tools.mjs passes that root to evaluateToolCall as
   * `workspace`; and the gate resolves the rules file from THAT argument
   * (governance-gate.mjs resolveRulesPath/loadPromotedRules).
   *
   * The last link is the one worth pinning, because it is the one a plausible
   * "fix" would break: if anyone changes the gate to read rules from
   * process.cwd() or from the startup env instead of its `workspace` argument,
   * a project's own rules stop governing it and this fails.
   */
  test('a rule in one workspace governs it and does not leak to another', () => {
    const governed = mkdtempSync(join(tmpdir(), 'helmion-gov-on-'));
    const ungoverned = mkdtempSync(join(tmpdir(), 'helmion-gov-off-'));

    try {
      mkdirSync(join(governed, '.helmion'), { recursive: true });
      writeFileSync(
        join(governed, '.helmion', 'autonomy_rules.json'),
        JSON.stringify({
          promoted_rules: [{
            pattern: 'quarantined-secrets',
            severity: 'block',
            reason: 'this project forbids touching the quarantine',
          }],
        }),
        'utf8',
      );

      // read_file deliberately: it is not in LEASE_REQUIRED_TOOLS, so the write
      // lease cannot be what refuses the call and the rule is the only variable.
      const call = { tool: 'read_file', args: { path: 'quarantined-secrets.txt' } };

      const inGoverned = evaluateToolCall({ ...call, workspace: governed });
      assert.equal(
        inGoverned.allowed,
        false,
        'the project\'s own rule blocks the call inside that project',
      );

      const inUngoverned = evaluateToolCall({ ...call, workspace: ungoverned });
      assert.equal(
        inUngoverned.allowed,
        true,
        'the same call is untouched in a workspace that never promoted that rule',
      );
    } finally {
      rmSync(governed, { recursive: true, force: true });
      rmSync(ungoverned, { recursive: true, force: true });
    }
  });
});
