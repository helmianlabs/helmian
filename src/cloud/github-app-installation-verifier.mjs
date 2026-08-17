const API_ORIGIN = 'https://api.github.com';
const API_VERSION = '2026-03-10';
const OWNER = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/u;
const REPOSITORY = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/u;
const SHA = /^[0-9a-f]{40,64}$/u;

function text(value, name, max) { const output = String(value ?? '').trim(); if (!output || output.length > max || /[\u0000-\u001f\u007f]/u.test(output)) throw new Error(`${name} is invalid`); return output; }
function positiveId(value, name) { const output = Number(value); if (!Number.isSafeInteger(output) || output < 1) throw new Error(`${name} is invalid`); return output; }
function sanitized(status, code, binding) { return Object.freeze({ format: 'helmion.github-app-installation-verification.v1', status, code, provider: 'github_app', workspaceProjectKey: binding.workspaceProjectKey, githubRepository: Object.freeze({ id: binding.githubRepository.id, nodeId: binding.githubRepository.nodeId, owner: binding.githubRepository.owner, name: binding.githubRepository.name }), githubInstallationId: binding.githubInstallationId, defaultBranch: binding.defaultBranch, baseCommitSha: binding.baseCommitSha, sourceVerification: status === 'verified' ? 'performed' : 'not_performed', tokenExchange: 'not_performed', checkout: 'not_performed', execution: 'not_performed', publication: 'not_performed', deployment: 'not_performed' }); }

function normalizeInput(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some((key) => !['tenantId', 'binding'].includes(key))) throw new Error('GitHub App verification contains unsupported fields');
  const tenantId = text(input.tenantId, 'tenant ID', 160);
  const binding = input.binding;
  if (!binding || typeof binding !== 'object' || Array.isArray(binding) || binding.provider !== 'github_app' || binding.lifecycle !== 'pending_verification') throw new Error('pending GitHub App source binding is required');
  const repository = binding.githubRepository;
  if (!repository || typeof repository !== 'object' || Array.isArray(repository)) throw new Error('GitHub repository identity is required');
  const owner = text(repository.owner, 'GitHub owner', 39); const name = text(repository.name, 'GitHub repository name', 100); const nodeId = text(repository.nodeId, 'GitHub repository node ID', 256); const baseCommitSha = text(binding.baseCommitSha, 'GitHub base commit SHA', 64).toLowerCase(); const vaultCredentialReference = text(binding.vaultCredentialReference, 'vault credential reference', 240);
  if (!OWNER.test(owner) || !REPOSITORY.test(name) || !SHA.test(baseCommitSha) || !vaultCredentialReference.startsWith(`vault://tenant/${tenantId}/github-app/`)) throw new Error('GitHub App source binding is invalid');
  return Object.freeze({ tenantId, binding: Object.freeze({ workspaceProjectKey: text(binding.workspaceProjectKey, 'workspace project key', 96), githubRepository: Object.freeze({ id: positiveId(repository.id, 'GitHub repository ID'), nodeId, owner, name }), githubInstallationId: positiveId(binding.githubInstallationId, 'GitHub installation ID'), defaultBranch: text(binding.defaultBranch, 'default branch', 160), baseCommitSha, vaultCredentialReference }) });
}

async function responseJson(response) { if (!response?.ok) throw new Error('GitHub API request failed'); const body = await response.json(); if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('GitHub API response is invalid'); return body; }
function headers(token) { return Object.freeze({ accept: 'application/vnd.github+json', authorization: `Bearer ${token}`, 'x-github-api-version': API_VERSION }); }

export function createGitHubAppInstallationVerifier({ installationTokenSource, fetchImpl } = {}) {
  if (typeof installationTokenSource !== 'function') throw new Error('GitHub App installation token source is required');
  if (typeof fetchImpl !== 'function') throw new Error('GitHub API transport is required');
  return Object.freeze({
    async verify(input) {
      const { tenantId, binding } = normalizeInput(input);
      let token;
      try {
        const issued = await installationTokenSource(Object.freeze({ tenantId, vaultCredentialReference: binding.vaultCredentialReference, githubInstallationId: binding.githubInstallationId, githubRepositoryId: binding.githubRepository.id }));
        if (!issued || typeof issued !== 'object' || positiveId(issued.githubInstallationId, 'issued GitHub installation ID') !== binding.githubInstallationId) throw new Error('GitHub App installation token is invalid');
        token = text(issued.accessToken, 'GitHub App installation token', 8192);
      } catch { return sanitized('pending', 'INSTALLATION_TOKEN_UNAVAILABLE', binding); }
      try {
        const owner = encodeURIComponent(binding.githubRepository.owner); const name = encodeURIComponent(binding.githubRepository.name); const repository = await responseJson(await fetchImpl(`${API_ORIGIN}/repos/${owner}/${name}`, { method: 'GET', headers: headers(token) }));
        if (positiveId(repository.id, 'returned GitHub repository ID') !== binding.githubRepository.id || text(repository.node_id, 'returned GitHub repository node ID', 256) !== binding.githubRepository.nodeId || text(repository.owner?.login, 'returned GitHub repository owner', 39) !== binding.githubRepository.owner || text(repository.name, 'returned GitHub repository name', 100) !== binding.githubRepository.name || text(repository.default_branch, 'returned GitHub default branch', 160) !== binding.defaultBranch) return sanitized('failed', 'REPOSITORY_IDENTITY_MISMATCH', binding);
        const branch = await responseJson(await fetchImpl(`${API_ORIGIN}/repos/${owner}/${name}/branches/${encodeURIComponent(binding.defaultBranch)}`, { method: 'GET', headers: headers(token) }));
        if (text(branch.commit?.sha, 'returned GitHub branch commit SHA', 64).toLowerCase() !== binding.baseCommitSha) return sanitized('failed', 'BASE_COMMIT_MISMATCH', binding);
        return sanitized('verified', 'IDENTITY_MATCHED', binding);
      } catch { return sanitized('pending', 'GITHUB_API_UNAVAILABLE', binding); }
    },
  });
}
