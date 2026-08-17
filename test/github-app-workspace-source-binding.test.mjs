import assert from 'node:assert/strict';
import test from 'node:test';
import { createGitHubAppWorkspaceSourceBindingRepository, normalizeGitHubAppWorkspaceSourceBinding } from '../src/cloud/github-app-workspace-source-binding-repository.mjs';

const actor = Object.freeze({ tenantId: 'org-a', subject: 'admin', role: 'admin', sessionId: 'session-1', requestId: 'request-1' });
const input = Object.freeze({ workspaceProjectKey: 'tms-cloud', githubRepositoryNodeId: 'R_kgDOExample', githubRepositoryId: 12345, githubOwner: 'Helmion', githubRepositoryName: 'cloud', githubInstallationId: 98765, defaultBranch: 'main', baseCommitSha: 'a'.repeat(40), verificationReceiptId: 'verify-0001', vaultCredentialReference: 'vault://tenant/org-a/github-app/installation-98765', idempotencyKey: 'github-binding-0001' });
function fakePool() { const bindings = []; const client = { async query(sql, values = []) { const q = String(sql).replace(/\s+/g, ' ').trim().toLowerCase(); if (['begin', 'commit', 'rollback'].includes(q) || q.startsWith('select set_config')) return { rowCount: 0, rows: [] }; if (q.startsWith('select role from helmion.tenant_memberships')) return values[0] === 'org-a' && values[1] === 'admin' ? { rowCount: 1, rows: [{ role: 'admin' }] } : { rowCount: 0, rows: [] }; if (q.startsWith('select project_key from helmion.workspace_projects')) return values[0] === 'org-a' && values[1] === 'tms-cloud' ? { rowCount: 1, rows: [{ project_key: 'tms-cloud' }] } : { rowCount: 0, rows: [] }; if (q.startsWith('insert into helmion.github_app_workspace_source_bindings')) { const existing = bindings.find((item) => item.idempotency_key === values[12]); if (existing) return { rowCount: 0, rows: [] }; const row = { workspace_project_key: values[1], github_repository_node_id: values[2], github_repository_id: values[3], github_owner: values[4], github_repository_name: values[5], github_installation_id: values[6], default_branch: values[7], base_commit_sha: values[8], verification_receipt_id: values[9], vault_credential_reference: values[10], lifecycle: 'pending_verification', receipt_id: values[11], idempotency_key: values[12], created_at: 'now' }; bindings.push(row); return { rowCount: 1, rows: [row] }; } if (q.startsWith('select receipt_id, workspace_project_key')) { if (q.includes('idempotency_key=$2')) { const row = bindings.find((item) => item.idempotency_key === values[1]); return row ? { rowCount: 1, rows: [row] } : { rowCount: 0, rows: [] }; } return { rowCount: bindings.length, rows: bindings }; } throw new Error(`Unexpected query: ${q}`); }, release() {} }; return { connect: async () => client, bindings }; }

test('GitHub App binding normalizer rejects authority, raw URL/token, and malformed immutable repository identity', () => {
  assert.equal(normalizeGitHubAppWorkspaceSourceBinding(input).githubOwner, 'Helmion');
  assert.throws(() => normalizeGitHubAppWorkspaceSourceBinding({ ...input, tenantId: 'org-b' }), /unsupported fields/);
  assert.throws(() => normalizeGitHubAppWorkspaceSourceBinding({ ...input, cloneUrl: 'https://github.com/x/y.git' }), /unsupported fields/);
  assert.throws(() => normalizeGitHubAppWorkspaceSourceBinding({ ...input, accessToken: 'ghs_secret' }), /unsupported fields/);
  assert.throws(() => normalizeGitHubAppWorkspaceSourceBinding({ ...input, baseCommitSha: 'not-a-sha' }), /invalid/);
});

test('owner/admin stores and replays a tenant-scoped GitHub App source identity without verification or checkout', async () => {
  const pool = fakePool(); const repo = createGitHubAppWorkspaceSourceBindingRepository(pool); const first = await repo.append(actor, input); const replay = await repo.append(actor, input);
  assert.equal(first.durable, true); assert.equal(first.provider, 'github_app'); assert.equal(first.lifecycle, 'pending_verification'); assert.equal(first.sourceVerification, 'not_performed'); assert.equal(first.checkout, 'not_performed'); assert.equal(first.tokenExchange, 'not_performed'); assert.equal(first.execution, 'not_performed'); assert.equal(replay.replayed, true); assert.equal(pool.bindings.length, 1);
  const listed = await repo.list(actor); assert.equal(listed.bindings.length, 1); assert.equal(listed.bindings[0].githubRepository.id, 12345);
});

test('binding fails closed for members, a cross-tenant vault reference, and an unavailable project', async () => {
  const repo = createGitHubAppWorkspaceSourceBindingRepository(fakePool());
  await assert.rejects(() => repo.append({ ...actor, role: 'member' }, input), /owner or admin/);
  await assert.rejects(() => repo.append(actor, { ...input, vaultCredentialReference: 'vault://tenant/org-b/github-app/installation-98765' }), /does not belong/);
  await assert.rejects(() => repo.append({ ...actor, tenantId: 'org-b' }, input), /does not belong/);
  await assert.rejects(() => repo.append(actor, { ...input, workspaceProjectKey: 'unknown-project' }), /workspace project/);
});
