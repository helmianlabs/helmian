import assert from 'node:assert/strict';
import test from 'node:test';
import { createGitHubAppInstallationVerifier } from '../src/cloud/github-app-installation-verifier.mjs';

const token = 'ghs_should_never_escape_the_verifier';
const binding = Object.freeze({ provider: 'github_app', lifecycle: 'pending_verification', workspaceProjectKey: 'helmion-cloud', githubRepository: Object.freeze({ id: 123, nodeId: 'R_kgDOExample', owner: 'helmion', name: 'cloud' }), githubInstallationId: 456, defaultBranch: 'main', baseCommitSha: 'a'.repeat(40), vaultCredentialReference: 'vault://tenant/tenant-a/github-app/helmion-installation' });
function json(body, ok = true) { return Object.freeze({ ok, async json() { return body; } }); }
function verifier({ tokenSource = async () => ({ accessToken: token, githubInstallationId: 456 }), responses = [] } = {}) { const calls = []; return { calls, verifier: createGitHubAppInstallationVerifier({ installationTokenSource: tokenSource, fetchImpl: async (url, init) => { calls.push({ url, init }); const response = responses.shift(); if (response instanceof Error) throw response; return response; } }) }; }
function validResponses() { return [json({ id: 123, node_id: 'R_kgDOExample', owner: { login: 'helmion' }, name: 'cloud', default_branch: 'main' }), json({ commit: { sha: 'a'.repeat(40) } })]; }

test('GitHub App verifier uses injected short-lived installation token and verifies exact repository/branch/commit identity', async () => {
  const { verifier: subject, calls } = verifier({ responses: validResponses() });
  const result = await subject.verify({ tenantId: 'tenant-a', binding });
  assert.equal(result.status, 'verified'); assert.equal(result.code, 'IDENTITY_MATCHED'); assert.equal(result.sourceVerification, 'performed'); assert.equal(result.checkout, 'not_performed');
  assert.equal(calls.length, 2); assert.equal(calls[0].url, 'https://api.github.com/repos/helmion/cloud'); assert.equal(calls[1].url, 'https://api.github.com/repos/helmion/cloud/branches/main'); assert.deepEqual(calls[0].init.headers, { accept: 'application/vnd.github+json', authorization: `Bearer ${token}`, 'x-github-api-version': '2026-03-10' });
  assert.doesNotMatch(JSON.stringify(result), new RegExp(token, 'u'));
});

test('GitHub App verifier fails closed on repository, branch, or pinned commit mismatch', async () => {
  const repositoryMismatch = verifier({ responses: [json({ id: 124, node_id: 'R_kgDOExample', owner: { login: 'helmion' }, name: 'cloud', default_branch: 'main' })] });
  assert.equal((await repositoryMismatch.verifier.verify({ tenantId: 'tenant-a', binding })).code, 'REPOSITORY_IDENTITY_MISMATCH');
  const branchMismatch = verifier({ responses: [json({ id: 123, node_id: 'R_kgDOExample', owner: { login: 'helmion' }, name: 'cloud', default_branch: 'trunk' })] });
  assert.equal((await branchMismatch.verifier.verify({ tenantId: 'tenant-a', binding })).code, 'REPOSITORY_IDENTITY_MISMATCH');
  const commitMismatch = verifier({ responses: [json({ id: 123, node_id: 'R_kgDOExample', owner: { login: 'helmion' }, name: 'cloud', default_branch: 'main' }), json({ commit: { sha: 'b'.repeat(40) } })] });
  const result = await commitMismatch.verifier.verify({ tenantId: 'tenant-a', binding }); assert.equal(result.status, 'failed'); assert.equal(result.code, 'BASE_COMMIT_MISMATCH');
});

test('GitHub App verifier has pending no-leak outcomes when token issue or API transport fails', async () => {
  const unavailable = verifier({ tokenSource: async () => { throw new Error(`token ${token}`); } });
  const tokenResult = await unavailable.verifier.verify({ tenantId: 'tenant-a', binding }); assert.deepEqual(tokenResult.status, 'pending'); assert.equal(tokenResult.code, 'INSTALLATION_TOKEN_UNAVAILABLE'); assert.equal(unavailable.calls.length, 0); assert.doesNotMatch(JSON.stringify(tokenResult), new RegExp(token, 'u'));
  const failingApi = verifier({ responses: [new Error(`network ${token}`)] }); const apiResult = await failingApi.verifier.verify({ tenantId: 'tenant-a', binding }); assert.equal(apiResult.status, 'pending'); assert.equal(apiResult.code, 'GITHUB_API_UNAVAILABLE'); assert.doesNotMatch(JSON.stringify(apiResult), new RegExp(token, 'u'));
});

test('GitHub App verifier rejects a cross-tenant vault reference before token access or transport', async () => {
  const { verifier: subject, calls } = verifier();
  await assert.rejects(() => subject.verify({ tenantId: 'tenant-b', binding }), /GitHub App source binding is invalid/u); assert.equal(calls.length, 0);
});
