import { createHash } from 'node:crypto';

export const CORA_APP_BUILD_WORKER_PLAN_FORMAT = 'cora.app-build-worker-plan.v1';
const SAFE_ROUTE = /^\/[a-z0-9][a-z0-9-]{0,47}(?:\/[a-z0-9][a-z0-9-]{0,47}){0,3}$/u;
const COMPONENTS = new Set(['heading', 'paragraph', 'field', 'button', 'table']);
const FIELD_TYPES = new Set(['text', 'email', 'date', 'select']);
const APPROVERS = new Set(['owner', 'admin']);

function text(value, name, max) { const result = String(value ?? '').trim(); if (!result || result.length > max || /[\u0000-\u001f\u007f]/u.test(result)) throw new Error(`${name} is invalid`); return result; }
function exact(object, keys, label) { if (!object || typeof object !== 'object' || Array.isArray(object) || Object.keys(object).some((key) => !keys.includes(key))) throw new Error(`${label} contains unsupported fields`); }
function digest(value) { return createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex'); }
function boundedComponents(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 32) throw new Error('revision components are not a bounded declarative UI');
  return Object.freeze(value.map((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item) || !COMPONENTS.has(item.type)) throw new Error('revision components are not a bounded declarative UI');
    if (item.type === 'field') { exact(item, ['type', 'label', 'fieldType', 'required'], 'field component'); if (!FIELD_TYPES.has(item.fieldType) || typeof item.required !== 'boolean') throw new Error('field component is invalid'); return Object.freeze({ type: 'field', label: text(item.label, 'field label', 120), fieldType: item.fieldType, required: item.required }); }
    if (item.type === 'button') { exact(item, ['type', 'label', 'action'], 'button component'); if (item.action !== 'save_draft') throw new Error('button component is invalid'); return Object.freeze({ type: 'button', label: text(item.label, 'button label', 120), action: 'save_draft' }); }
    if (item.type === 'table') { exact(item, ['type', 'label', 'columns'], 'table component'); if (!Array.isArray(item.columns) || item.columns.length < 1 || item.columns.length > 12) throw new Error('table component is invalid'); return Object.freeze({ type: 'table', label: text(item.label, 'table label', 120), columns: Object.freeze(item.columns.map((column) => text(column, 'table column', 80))) }); }
    exact(item, ['type', 'text'], `${item.type} component`); return Object.freeze({ type: item.type, text: text(item.text, 'component text', 500) });
  }));
}

export function createApprovedAppBuildWorkerPlan(input = {}) {
  exact(input, ['tenantId', 'revision', 'approval', 'workspaceProject'], 'app build worker input');
  exact(input.revision, ['receiptId', 'appBuildReceiptId', 'route', 'title', 'description', 'components'], 'app build revision');
  exact(input.approval, ['revisionReceiptId', 'decision', 'actorRole', 'receiptId'], 'app build approval');
  exact(input.workspaceProject, ['projectKey', 'sourceKind', 'defaultBranch'], 'workspace project');
  const tenantId = text(input.tenantId, 'tenant id', 128).toLowerCase();
  const revisionReceiptId = text(input.revision.receiptId, 'revision receipt', 256);
  if (input.approval.revisionReceiptId !== revisionReceiptId || input.approval.decision !== 'approve' || !APPROVERS.has(String(input.approval.actorRole).toLowerCase())) throw new Error('an owner/admin approval for this revision is required');
  const route = text(input.revision.route, 'app route', 200).toLowerCase();
  if (!SAFE_ROUTE.test(route)) throw new Error('app route is unsupported');
  const components = boundedComponents(input.revision.components);
  const projectKey = text(input.workspaceProject.projectKey, 'workspace project key', 120);
  const sourceKind = text(input.workspaceProject.sourceKind, 'workspace source kind', 64);
  const defaultBranch = text(input.workspaceProject.defaultBranch, 'workspace default branch', 200);
  const slug = route.slice(1).replaceAll('/', '-');
  const definition = Object.freeze({ title: text(input.revision.title, 'app title', 240), description: text(input.revision.description, 'app description', 1200), route, components });
  const definitionText = `${JSON.stringify(definition, null, 2)}\n`;
  const contractText = `import definition from './definition.json' with { type: 'json' };\nif (definition.route !== '${route}' || !Array.isArray(definition.components)) throw new Error('generated app contract invalid');\n`;
  const changes = Object.freeze([
    Object.freeze({ kind: 'create', path: `generated-apps/${slug}/definition.json`, contentDigest: digest(definitionText) }),
    Object.freeze({ kind: 'create', path: `generated-apps/${slug}/contract.test.mjs`, contentDigest: digest(contractText) }),
  ]);
  return Object.freeze({ format: CORA_APP_BUILD_WORKER_PLAN_FORMAT, valid: true, tenantId, revisionReceiptId, approvalReceiptId: text(input.approval.receiptId, 'approval receipt', 256), workspaceProject: Object.freeze({ projectKey, sourceKind, defaultBranch }), changes, artifacts: Object.freeze([{ path: changes[0].path, text: definitionText }, { path: changes[1].path, text: contractText }]), verification: Object.freeze({ required: Object.freeze(['schema-validation', 'tenant-scope-test', 'route-contract-test']), status: 'not_run' }), deployment: Object.freeze({ status: 'not_requested', revert: `remove generated-apps/${slug} before any commit` }), execution: 'not_performed', providerInvocation: 'not_performed', filesystemMutation: 'not_performed', publication: 'not_performed' });
}
