// hands.mjs — lets a phone message actually DO something, inside one folder.
//
// ─── READ THIS BEFORE CHANGING ANYTHING HERE ────────────────────────────────
//
// Until 2026-07-31 the relay was TEXT ONLY and said so everywhere: a message
// arriving from the phone became a line Helmion printed, and that was the whole
// of its authority. src/relay/protocol.mjs:7-9 states that letting the phone
// execute is "a separate, deliberate change". This file is that change, made
// deliberately, at Troy's explicit request, with the reasoning written down so
// whoever reads it next knows exactly what was traded away.
//
// WHAT CHANGED, IN ONE SENTENCE: a lane reachable from the open internet can now
// cause work on this machine.
//
// THE FOUR THINGS THAT MAKE THAT SURVIVABLE, none of which is optional:
//
//   1. ONE FOLDER. Every turn runs with the workspace pinned to a root the
//      operator names on the command line. The agent's own tool layer resolves
//      and confines paths to that root (src/agent/tools.mjs:200), so a message
//      cannot reach the rest of the disk by asking nicely.
//
//   2. THE EXISTING GUARD, UNTOUCHED. Turns go through the ordinary agent
//      runtime, which means every tool call still passes evaluateToolCall
//      (src/agent/tools.mjs:522) and the destructive patterns, the write lease
//      and the Tier-B rules all still apply. Nothing here weakens or bypasses
//      them, and nothing here should ever be written to.
//
//   3. OFF BY DEFAULT. No flag, no hands. `helmion relay` on its own still only
//      prints, exactly as before. This cannot switch itself on.
//
//   4. IT SAYS WHAT IT DID. Every executed message is echoed back to the phone
//      and printed on the desktop. Work that happens silently because someone
//      texted a machine is the failure mode worth fearing here.
//
// WHAT IT STILL WILL NOT DO: it does not run a shell string it was handed. The
// message is a REQUEST IN ENGLISH to an agent that then decides what to do and
// is itself governed. "Create hello.txt" is a sentence, not a command line. That
// distinction is why a text lane can be pointed at a runtime at all.

import { resolve } from 'node:path';
import { answerStatus as statusAnswer } from './status.mjs';

/**
 * Build the handler that turns an incoming phone line into real work.
 *
 * @param {object}   o
 * @param {string}   o.root      Folder every turn is confined to. Required.
 * @param {function} o.say       Send a line back to the phone.
 * @param {function} o.log       Write a line to the desktop console.
 */
export function createHands({ root, say, log }) {
  if (!root) throw new TypeError('hands need a folder to work in');
  const workspace = resolve(root);

  let busy = false;
  const queue = [];

  async function runOne(text) {
    const { runAgentTurn } = await import('../agent/loop.mjs');
    const { createToolRuntime } = await import('../agent/tools.mjs');
    // BOTH of these live in env.mjs. resolveProvider is NOT in providers.mjs
    // despite the name, and readEnv does not exist at all — it is
    // loadHelmionEnv. Guessing those cost a live round trip with Troy watching.
    const { loadHelmionEnv, resolveProvider } = await import('../agent/env.mjs');

    const env = loadHelmionEnv(workspace);
    const provider = resolveProvider(env.maestro, env, []);
    if (!provider?.key) {
      const msg = `no API key for ${provider?.label || 'the selected provider'} — nothing was run`;
      log(`  · ${msg}`);
      say(`Helmion: ${msg}`);
      return;
    }

    // 'ask' would hang forever: there is nobody at this keyboard to answer a
    // prompt, and a turn that silently waits looks identical to one that failed.
    // 'full' is honest about what this is, and the guard is what constrains it.
    const runtime = createToolRuntime(workspace, { permissionMode: 'full' });

    const messages = [{
      role: 'system',
      content:
        `You are Helmion, working inside ${workspace}. Requests arrive from Troy's `
        + `phone by voice, so they are short and spoken, not written specifications. `
        + `Do the work, then answer in one or two plain sentences saying what you `
        + `actually did. If a request is ambiguous, choose the smallest safe reading `
        + `and say which you chose.`,
    }];

    log(`  · working: ${text}`);
    const result = await runAgentTurn({
      provider,
      messages,
      userText: text,
      runtime,
    });

    const reply = (result?.text || '').trim() || 'done (no summary returned)';
    log(`  · ${reply}`);
    say(`Helmion: ${reply}`);
  }

  /** Run messages ONE AT A TIME. Two turns writing the same folder at once is
   *  the collision this project has spent a whole night cleaning up after. */
  async function drain() {
    if (busy) return;
    busy = true;
    try {
      while (queue.length) {
        const text = queue.shift();
        try {
          await runOne(text);
        } catch (err) {
          log(`  · failed: ${err.message}`);
          say(`Helmion: that failed — ${err.message}`);
        }
      }
    } finally {
      busy = false;
    }
  }

  return {
    workspace,
    /** Accept one line from the phone. Returns immediately; work happens behind. */
    handle(text) {
      const line = String(text || '').trim();
      if (!line) return;

      // A STATUS QUESTION IS ANSWERED FROM DISK, NOT FROM A MODEL. "What
      // warnings are up" has a real answer sitting in the ledger and the lease
      // file, and routing it through a language model would produce a fluent
      // sentence with no measurement behind it — which is the entire failure
      // this product exists to stop. It is also instant and costs nothing.
      const answered = statusAnswer(line, workspace);
      if (answered) {
        log(`  · status: ${answered}`);
        say(`Helmion: ${answered}`);
        return;
      }

      queue.push(line);
      if (busy) {
        log(`  · queued (${queue.length} waiting)`);
        say(`Helmion: queued, ${queue.length} ahead of it`);
      }
      drain();
    },
  };
}
