#!/usr/bin/env node
// The promote lever, operator CLI (src/promote/executor.mjs is the engine).
//
//   node bin/promote.mjs verify  --manifest promote-manifest.json [--state dir]
//   node bin/promote.mjs request --manifest promote-manifest.json [--state dir] [--wait-ms 3000]
//   node bin/promote.mjs await   [--state dir] [--wait-ms 840000]
//   node bin/promote.mjs execute [--state dir] [--github-bin /opt/hatch/bin/github]
//   node bin/promote.mjs report  [--state dir] --status failed --error "why"
//
// Guard connection comes from the environment, same names as the hands
// server (GUARD_URL, GUARD_DEVICE_TOKEN, GUARD_PUBLIC_KEY_X, GUARD_DEVICE_ID).
// Values are never printed. The manifest is JSON:
//   { repo, baseBranch, mode, branch, commitMessage,
//     files: [{ path, content } | { path, contentFile }] }
// contentFile resolves relative to the manifest file. Exit codes:
// 0 done/allowed, 2 still pending, 3 denied/refused, 1 error.

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { createGuardClient } from '../src/guard-client.mjs';
import { buildGuardAction, guardActionHash, promoteManifestHash, PROMOTE_SITE } from '../src/shared/protocol.mjs';
import { createConnectorGithub, createPromoteExecutor, PromoteRefusal } from '../src/promote/executor.mjs';

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) out[a.slice(2)] = argv[++i];
    else out._.push(a);
  }
  return out;
}

const flags = parseArgs(process.argv.slice(2));
const command = flags._[0];
const stateDir = resolve(flags.state || process.env.PROMOTE_STATE_DIR || './promote-state');
mkdirSync(stateDir, { recursive: true });
const stateFile = join(stateDir, 'run.json');
const audit = {
  append(entry) {
    appendFileSync(join(stateDir, 'promote-audit.jsonl'), `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`);
  },
};

function loadManifest(path) {
  const raw = JSON.parse(readFileSync(path, 'utf8'));
  const base = dirname(resolve(path));
  const files = (raw.files || []).map((f) => {
    if (typeof f.content === 'string') return f;
    if (typeof f.contentFile === 'string') return { path: f.path, content: readFileSync(join(base, f.contentFile), 'utf8'), ...(f.sha256 ? { sha256: f.sha256 } : {}) };
    throw new Error(`manifest file ${f.path}: needs content or contentFile`);
  });
  return { ...raw, files };
}

function guardFromEnv() {
  const guard = createGuardClient({
    url: process.env.GUARD_URL,
    deviceToken: process.env.GUARD_DEVICE_TOKEN,
    publicKeyX: process.env.GUARD_PUBLIC_KEY_X,
    deviceId: process.env.GUARD_DEVICE_ID || 'hands-mcp',
  });
  if (!guard.live) throw new Error('Executive Guard is not configured in the environment (GUARD_URL / GUARD_DEVICE_TOKEN / GUARD_PUBLIC_KEY_X); failing closed.');
  return guard;
}

function makeExecutor(guard) {
  return createPromoteExecutor({
    guard,
    github: createConnectorGithub({ bin: flags['github-bin'] || process.env.GITHUB_BIN || '/opt/hatch/bin/github' }),
    audit,
    publicKeyX: process.env.GUARD_PUBLIC_KEY_X,
    deviceId: process.env.GUARD_DEVICE_ID || 'hands-mcp',
    site: PROMOTE_SITE,
  });
}

function saveState(state) { writeFileSync(stateFile, JSON.stringify(state, null, 2), { mode: 0o600 }); }
function loadState() {
  if (!existsSync(stateFile)) throw new Error(`no run state in ${stateDir}; run "request" first`);
  return JSON.parse(readFileSync(stateFile, 'utf8'));
}
const summary = (args) => ({
  site: PROMOTE_SITE,
  repo: args.repo,
  mode: args.mode,
  branch: args.branch ?? null,
  manifestHash: promoteManifestHash(args),
  files: args.files.map((f) => ({ path: f.path, sha256: f.sha256 })),
});

async function main() {
  if (command === 'verify') {
    const executor = makeExecutor({ authorize: async () => { throw new Error('offline'); }, awaitApproval: async () => { throw new Error('offline'); }, reportOutcome: async () => ({ recorded: false }) });
    const args = executor.prepare(loadManifest(flags.manifest));
    const action = buildGuardAction('promote_build', args);
    console.log(JSON.stringify({ ok: true, ...summary(args), actionHash: guardActionHash(action), action }, null, 2));
    return 0;
  }

  if (command === 'request') {
    const guard = guardFromEnv();
    const executor = makeExecutor(guard);
    const { args, decision } = await executor.request(loadManifest(flags.manifest), { waitMs: Number(flags['wait-ms'] || 3000) });
    const state = {
      args, nonce: decision.nonce, approvalId: decision.approvalId ?? decision.claims?.approvalId ?? null,
      status: decision.outcome, envelope: decision.envelope ?? null, claims: decision.claims ?? null,
      reason: decision.reason ?? null,
    };
    saveState(state);
    console.log(JSON.stringify({ ok: true, outcome: decision.outcome, approvalId: state.approvalId, ...summary(args) }, null, 2));
    return decision.outcome === 'allow' ? 0 : decision.outcome === 'pending' ? 2 : 3;
  }

  if (command === 'await') {
    const guard = guardFromEnv();
    const executor = makeExecutor(guard);
    const state = loadState();
    if (state.status === 'allow') { console.log(JSON.stringify({ ok: true, outcome: 'allow', approvalId: state.approvalId }, null, 2)); return 0; }
    const decision = await executor.awaitDecision({
      approvalId: state.approvalId, args: state.args, nonce: state.nonce, waitMs: Number(flags['wait-ms'] || 840000),
    });
    state.status = decision.outcome;
    state.reason = decision.reason ?? null;
    if (decision.outcome === 'allow') { state.envelope = decision.envelope; state.claims = decision.claims; }
    if (decision.outcome === 'deny' && decision.unusedDecisionId) {
      await guard.reportOutcome({ decisionId: decision.unusedDecisionId, nonce: state.nonce, status: 'refused', finishedAt: new Date().toISOString(), error: decision.reason }).catch(() => {});
    }
    saveState(state);
    console.log(JSON.stringify({ ok: true, outcome: decision.outcome, approvalId: state.approvalId, reason: state.reason }, null, 2));
    return decision.outcome === 'allow' ? 0 : decision.outcome === 'pending' ? 2 : 3;
  }

  if (command === 'execute') {
    const state = loadState();
    if (state.status !== 'allow' || !state.envelope) throw new Error('no approved decision in state; nothing to execute');
    const guard = guardFromEnv();
    const executor = makeExecutor(guard);
    const r = await executor.execute({ args: state.args, envelope: state.envelope, nonce: state.nonce });
    state.status = 'executed';
    state.commit = r.commit.sha;
    state.pr = r.pr ? r.pr.url : null;
    saveState(state);
    console.log(JSON.stringify({ ok: true, commit: r.commit.sha, pr: state.pr, ref: r.ref, decidedBy: r.claims.decidedBy, approvalId: r.claims.approvalId }, null, 2));
    return 0;
  }

  if (command === 'report') {
    const state = loadState();
    const guard = guardFromEnv();
    const status = flags.status;
    if (!['succeeded', 'failed', 'refused'].includes(status)) throw new Error('--status must be succeeded, failed or refused');
    const r = await guard.reportOutcome({
      decisionId: state.claims?.decisionId, nonce: state.nonce, status,
      ...(status === 'refused' ? {} : { startedAt: new Date().toISOString() }),
      finishedAt: new Date().toISOString(), ...(flags.error ? { error: flags.error } : {}),
    });
    console.log(JSON.stringify({ ok: r.recorded, ...r }, null, 2));
    return r.recorded ? 0 : 1;
  }

  console.error('usage: promote.mjs verify|request|await|execute|report [--state dir] [--manifest file]');
  return 1;
}

main().then((code) => { process.exitCode = code; }).catch((error) => {
  console.error(error instanceof PromoteRefusal ? `REFUSED: ${error.message}` : `ERROR: ${error.message}`);
  process.exitCode = error instanceof PromoteRefusal ? 3 : 1;
});
