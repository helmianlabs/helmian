import { createHash } from 'node:crypto';
import { mkdir, realpath, writeFile, readFile, lstat, rm } from 'node:fs/promises';
import { dirname, relative, resolve, sep } from 'node:path';
import { CORA_APP_BUILD_WORKER_PLAN_FORMAT } from './app-build-worker-plan.mjs';

const PATH = /^generated-apps\/[a-z0-9][a-z0-9-]{0,191}\/(definition\.json|contract\.test\.mjs)$/u;
const digest = (text) => createHash('sha256').update(text).digest('hex');
const TYPES = new Set(['heading', 'paragraph', 'field', 'button', 'table']);
const FIELDS = new Set(['text', 'email', 'date', 'select']);
function inside(root, target) { const rel = relative(root, target); return rel && !rel.startsWith(`..${sep}`) && rel !== '..' && !resolve(target).startsWith(`${root}${sep}`) ? false : !rel.startsWith(`..${sep}`) && rel !== '..'; }
async function safeTarget(root, path) { if (!PATH.test(path)) throw new Error('plan artifact path is unsupported'); const target = resolve(root, path); if (!inside(root, target)) throw new Error('plan artifact escapes trusted workspace'); let cursor = dirname(target); while (cursor !== root) { try { if ((await lstat(cursor)).isSymbolicLink()) throw new Error('workspace path contains a symlink'); } catch (error) { if (error.code !== 'ENOENT') throw error; } cursor = dirname(cursor); } return target; }
async function absent(target) { try { await lstat(target); throw new Error('planned artifact already exists'); } catch (error) { if (error.code === 'ENOENT') return; throw error; } }
function exact(value, keys) { return value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === keys.length && Object.keys(value).every((key) => keys.includes(key)); }
function validateDefinition(text) { let definition; try { definition = JSON.parse(text); } catch { throw new Error('definition artifact is invalid JSON'); } if (!exact(definition, ['title', 'description', 'route', 'components']) || typeof definition.title !== 'string' || typeof definition.description !== 'string' || !Array.isArray(definition.components) || definition.components.length < 1 || definition.components.length > 32 || !/^\/[a-z0-9][a-z0-9-]{0,47}(?:\/[a-z0-9][a-z0-9-]{0,47}){0,3}$/u.test(definition.route)) throw new Error('definition artifact schema is invalid'); for (const item of definition.components) { if (!item || !TYPES.has(item.type)) throw new Error('definition component is invalid'); if (item.type === 'field' && (!exact(item, ['type', 'label', 'fieldType', 'required']) || !FIELDS.has(item.fieldType) || typeof item.required !== 'boolean')) throw new Error('definition field is invalid'); if (item.type === 'button' && (!exact(item, ['type', 'label', 'action']) || item.action !== 'save_draft')) throw new Error('definition button is invalid'); if (item.type === 'table' && (!exact(item, ['type', 'label', 'columns']) || !Array.isArray(item.columns) || item.columns.length < 1 || item.columns.length > 12)) throw new Error('definition table is invalid'); if (['heading', 'paragraph'].includes(item.type) && (!exact(item, ['type', 'text']) || typeof item.text !== 'string')) throw new Error('definition text component is invalid'); } return definition; }
function contract(route) { return `import definition from './definition.json' with { type: 'json' };\nif (definition.route !== '${route}' || !Array.isArray(definition.components)) throw new Error('generated app contract invalid');\n`; }

export async function executeApprovedAppBuildPlan({ workspaceRoot, plan } = {}) {
  if (!workspaceRoot || !plan || plan.format !== CORA_APP_BUILD_WORKER_PLAN_FORMAT || plan.execution !== 'not_performed' || !Array.isArray(plan.changes) || plan.changes.length !== 2 || !Array.isArray(plan.artifacts) || plan.artifacts.length !== 2) throw new Error('approved app build plan is invalid');
  const root = await realpath(workspaceRoot); const pairs = plan.changes.map((change) => ({ change, artifact: plan.artifacts.find((item) => item.path === change.path) }));
  if (pairs.some(({ change, artifact }) => !artifact || change.kind !== 'create' || typeof artifact.text !== 'string' || digest(artifact.text) !== change.contentDigest)) throw new Error('plan artifact digest is invalid');
  const definitionArtifact = pairs.find(({ change }) => change.path.endsWith('/definition.json'))?.artifact;
  const contractArtifact = pairs.find(({ change }) => change.path.endsWith('/contract.test.mjs'))?.artifact;
  if (!definitionArtifact || !contractArtifact || pairs.some(({ change }) => !PATH.test(change.path))) throw new Error('plan artifact path is unsupported');
  const definition = validateDefinition(definitionArtifact?.text);
  if (!contractArtifact || contractArtifact.text !== contract(definition.route)) throw new Error('contract artifact is not the deterministic safe contract');
  const targets = await Promise.all(pairs.map(({ change }) => safeTarget(root, change.path)));
  await Promise.all(targets.map(absent));
  const written = []; const created = [];
  try {
    for (let index = 0; index < pairs.length; index += 1) { const { change, artifact } = pairs[index]; const target = targets[index]; await mkdir(dirname(target), { recursive: true }); await writeFile(target, artifact.text, { encoding: 'utf8', flag: 'wx' }); created.push(target); written.push({ path: change.path, sha256: digest(await readFile(target, 'utf8')) }); }
  } catch (error) { await Promise.all(created.map((target) => rm(target, { force: true }))); throw error; }
  const persistedDefinition = JSON.parse(await readFile(resolve(root, pairs[0].change.path), 'utf8'));
  const valid = persistedDefinition.route === definition.route && Array.isArray(persistedDefinition.components) && persistedDefinition.components.length > 0;
  if (!valid) throw new Error('generated artifact contract failed');
  const folder = dirname(pairs[0].change.path);
  return Object.freeze({ format: 'cora.app-build-local-execution-receipt.v1', valid: true, written: Object.freeze(written), verification: { status: 'passed', contract: 'generated-artifact-contract' }, rollback: Object.freeze({ action: 'remove_generated_app_directory', path: folder }), providerInvocation: 'not_performed', publication: 'not_performed', deployment: 'not_performed' });
}
