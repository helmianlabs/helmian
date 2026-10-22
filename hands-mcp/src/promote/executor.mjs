// The promote executor: the only code path that turns a Guard approval into
// a push to a live repo. Fail closed at every step, in this order:
//
//   prepare  — validate the manifest (per-file SHA-256 verified against the
//              content) and pin it to the registered target for the site.
//   request  — ask Executive Guard (via the hands guard-client, unmodified)
//              for a decision on the manifest's action. The action's
//              contentHash IS the manifest hash, so the human approves these
//              exact bytes. No approval path runs the push.
//   await    — poll Guard for the human's decision (same client).
//   execute  — given the signed decision envelope: re-validate the manifest
//              from scratch (any drift since approval => hashes differ =>
//              refusal), re-verify the Ed25519 decision against the manifest
//              (audience, expiry, action hash, device, human approval), check
//              decidedBy holds admin/owner for the target, then push through
//              the injected GitHub ship path, verify every file landed
//              byte-identical on the target ref, and report the outcome back
//              to Guard (decision.outcome in its audit trail).
//
// Direct-to-main ships only when the APPROVED manifest itself says
// mode 'direct-main' — the approval binds the mode, so "the approval says
// so" is literal, not a runtime flag anyone can flip afterwards.

import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import {
  buildGuardAction, guardActionHash, promoteManifestHash, sha256Hex, validateArgs, verifyApproval,
} from '../shared/protocol.mjs';
import { decisionIdOf } from '../guard-client.mjs';
import { approverCoversTarget, targetForSite } from './targets.mjs';

export class PromoteRefusal extends Error {}

/** Git blob SHA-1 of a UTF-8 string, the id GitHub reports for a file's content. */
export function gitBlobSha(content) {
  const body = Buffer.from(String(content), 'utf8');
  return createHash('sha1').update(Buffer.concat([Buffer.from(`blob ${body.length}\0`, 'utf8'), body])).digest('hex');
}

export function createPromoteExecutor({ guard, github, audit = { append() {} }, publicKeyX, deviceId = 'hands-mcp', site } = {}) {
  const target = targetForSite(site);
  if (!target) throw new Error(`no promote target registered for site ${site}`);
  if (!guard) throw new Error('promote executor needs a Guard client');
  if (!github) throw new Error('promote executor needs a GitHub ship path');

  function prepare(rawArgs) {
    const args = validateArgs('promote_build', rawArgs);
    if (args.repo !== target.repo) {
      throw new PromoteRefusal(`repo ${args.repo} is not the registered target for ${site} (${target.repo})`);
    }
    if (args.baseBranch !== target.baseBranch) {
      throw new PromoteRefusal(`baseBranch ${args.baseBranch} is not the registered base for ${site} (${target.baseBranch})`);
    }
    return args;
  }

  const manifestOf = (args) => ({
    manifestHash: promoteManifestHash(args),
    actionHash: guardActionHash(buildGuardAction('promote_build', args)),
    files: args.files.map((f) => ({ path: f.path, sha256: f.sha256 })),
  });

  async function request(rawArgs, { waitMs } = {}) {
    const args = prepare(rawArgs);
    audit.append({ event: 'promote.requested', site, repo: args.repo, mode: args.mode, branch: args.branch ?? null, ...manifestOf(args) });
    const decision = await guard.authorize({ tool: 'promote_build', args, ...(waitMs ? { waitMs } : {}) });
    if (decision.outcome === 'pending') audit.append({ event: 'promote.pending', site, approvalId: decision.approvalId });
    return { args, decision };
  }

  async function awaitDecision({ approvalId, args, nonce, waitMs } = {}) {
    return guard.awaitApproval({ approvalId, tool: 'promote_build', args, nonce, ...(waitMs ? { waitMs } : {}) });
  }

  async function execute({ args: rawArgs, envelope, nonce } = {}) {
    const startedAt = new Date().toISOString();
    let args;
    try {
      args = prepare(rawArgs);
    } catch (error) {
      audit.append({ event: 'promote.refused', site, error: error.message });
      throw error;
    }
    const refuse = async (error, decisionId) => {
      audit.append({ event: 'promote.refused', site, ...manifestOf(args), error });
      if (decisionId) {
        await guard.reportOutcome({ decisionId, nonce, status: 'refused', finishedAt: new Date().toISOString(), error }).catch(() => {});
      }
      throw new PromoteRefusal(error);
    };

    // Re-verify the signed decision against THIS manifest at the point of
    // push — not merely "an approval exists". Binds signature, audience,
    // expiry, action hash (=> manifest hash), nonce, device, human approver.
    const v = verifyApproval({ publicKeyX, envelope, tool: 'promote_build', args, nonce, deviceId });
    if (!v.ok) return refuse(`the signed decision does not cover this manifest: ${v.error}`, decisionIdOf(envelope));
    const claims = v.claims;

    if (!approverCoversTarget(site, claims.decidedBy)) {
      return refuse(`approver "${claims.decidedBy}" does not hold admin/owner for ${site}`, claims.decisionId);
    }

    const ref = args.mode === 'branch-pr' ? args.branch : args.baseBranch;
    let commit;
    let pr = null;
    try {
      if (args.mode === 'branch-pr') await github.createBranch(args.repo, args.branch, args.baseBranch);
      commit = await github.pushFiles(args.repo, ref, args.commitMessage, args.files);
      for (const f of args.files) {
        const remoteSha = await github.getFileBlobSha(args.repo, f.path, ref);
        if (remoteSha !== gitBlobSha(f.content)) throw new Error(`verification failed: ${f.path} on ${ref} is not the approved content`);
      }
      if (args.mode === 'branch-pr') {
        pr = await github.createPullRequest(args.repo, args.branch, args.baseBranch, args.commitMessage,
          [
            'Opened by the Cora promote lever after a human Guard approval.',
            '',
            `- Guard site: ${site}`,
            `- Approval: ${claims.approvalId} (decided by ${claims.decidedBy})`,
            `- Manifest hash: ${promoteManifestHash(args)}`,
            `- Files: ${args.files.map((f) => `${f.path} (${f.sha256.slice(0, 12)}…)`).join(', ')}`,
          ].join('\n'));
      }
    } catch (error) {
      audit.append({ event: 'promote.failed', site, ...manifestOf(args), approvalId: claims.approvalId, error: error.message });
      await guard.reportOutcome({
        decisionId: claims.decisionId, nonce, status: 'failed', startedAt, finishedAt: new Date().toISOString(), error: error.message,
      }).catch(() => {});
      throw new PromoteRefusal(`push failed: ${error.message}`);
    }

    const resultHash = sha256Hex(commit.sha);
    await guard.reportOutcome({
      decisionId: claims.decisionId, nonce, status: 'succeeded', startedAt, finishedAt: new Date().toISOString(), resultHash,
    }).catch(() => {});
    const done = {
      event: 'promote.succeeded', site, ...manifestOf(args), approvalId: claims.approvalId,
      decidedBy: claims.decidedBy, decisionId: claims.decisionId, commit: commit.sha,
      pr: pr ? pr.url : null, mode: args.mode, ref,
    };
    audit.append(done);
    return { commit, pr, claims, ref };
  }

  return { prepare, request, awaitDecision, execute, target };
}

// ─── The ship path: GitHub connector CLI ─────────────────────────────────────
// This environment has no git credentials; the connector (OAuth + Muse
// GitHub App) is the ship path, exactly as prior forge-tms work shipped.
// Contents here are assembled payloads (a manifest), so call-tool push_files
// is the documented route for them (connector references/snapshot-push.md).

function runCli(bin, argv) {
  return new Promise((resolve, reject) => {
    execFile(bin, argv, { maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) return reject(new Error(`${bin} ${argv[0]} failed: ${String(stderr || error.message).slice(0, 400)}`));
      resolve(String(stdout));
    });
  });
}

export function createConnectorGithub({ bin = '/opt/hatch/bin/github' } = {}) {
  async function call(name, args, { read = false } = {}) {
    const out = await runCli(bin, [read ? 'call-read-tool' : 'call-tool', '--name', name, '--arguments-json', JSON.stringify(args)]);
    let parsed;
    try { parsed = JSON.parse(out); } catch { throw new Error(`connector ${name}: unparseable response`); }
    if (!parsed.ok) throw new Error(`connector ${name}: ${JSON.stringify(parsed).slice(0, 400)}`);
    const text = parsed.result?.content?.[0]?.text;
    try { return JSON.parse(text); } catch { return text; }
  }

  return {
    async createBranch(repo, branch, fromBranch) {
      const [owner, name] = repo.split('/');
      return call('create_branch', { owner, repo: name, branch, from_branch: fromBranch });
    },
    async pushFiles(repo, branch, message, files) {
      const [owner, name] = repo.split('/');
      const r = await call('push_files', {
        owner, repo: name, branch, message,
        files: files.map((f) => ({ path: f.path, content: f.content })),
      });
      const sha = r?.commit?.sha || r?.sha;
      if (!sha) throw new Error('connector push_files: no commit sha in response');
      return { sha };
    },
    async getFileBlobSha(repo, path, ref) {
      const [owner, name] = repo.split('/');
      const out = await runCli(bin, ['call-read-tool', '--name', 'get_file_contents', '--arguments-json', JSON.stringify({ owner, repo: name, path, ref })]);
      const m = /SHA: ([0-9a-f]{40})/.exec(out);
      if (!m) throw new Error(`connector get_file_contents: no blob sha reported for ${path}`);
      return m[1];
    },
    async createPullRequest(repo, head, base, title, body) {
      const [owner, name] = repo.split('/');
      const r = await call('create_pull_request', { owner, repo: name, head, base, title, body });
      return { url: r?.html_url || null, number: r?.number ?? null };
    },
  };
}
