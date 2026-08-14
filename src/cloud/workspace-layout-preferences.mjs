export const WORKSPACE_LAYOUT_FORMAT = 'helmion.workspace-layout-preferences.v1';
export const WORKSPACE_SHELVES = Object.freeze(['chat', 'cora', 'prepare', 'artifact', 'governance']);
const SHELF_SET = new Set(WORKSPACE_SHELVES);
const ROLES = new Set(['owner', 'admin', 'member', 'auditor']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export function roleDefaultLayout(role) {
  const normalizedRole = String(role ?? '').trim().toLowerCase();
  if (!ROLES.has(normalizedRole)) throw new Error('workspace role is invalid');
  return Object.freeze({ visibleShelves: [...WORKSPACE_SHELVES], panelOrder: [...WORKSPACE_SHELVES], density: 'comfortable', defaultEnvoyChannelId: null });
}

function list(value, field) {
  if (!Array.isArray(value) || value.length !== WORKSPACE_SHELVES.length || new Set(value).size !== value.length || value.some((item) => !SHELF_SET.has(item))) throw new Error(`${field} must be a complete allowed shelf list`);
  return [...value];
}

function optionalList(value, field) { return value == null ? null : list(value, field); }
function optionalChannel(value) { if (value == null || value === '') return null; const result = String(value).trim(); if (!UUID.test(result)) throw new Error('defaultEnvoyChannelId is invalid'); return result; }

export function normalizeWorkspaceLayout(input = {}, { partial = false } = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('workspace layout must be an object');
  const allowed = new Set(['visibleShelves', 'panelOrder', 'density', 'defaultEnvoyChannelId']);
  if (Object.keys(input).some((key) => !allowed.has(key))) throw new Error('workspace layout contains unsupported fields');
  const result = {};
  if (!partial || Object.hasOwn(input, 'visibleShelves')) result.visibleShelves = list(input.visibleShelves, 'visibleShelves');
  if (!partial || Object.hasOwn(input, 'panelOrder')) result.panelOrder = list(input.panelOrder, 'panelOrder');
  if (!partial || Object.hasOwn(input, 'density')) { const density = String(input.density ?? '').trim().toLowerCase(); if (!['comfortable', 'compact'].includes(density)) throw new Error('density is invalid'); result.density = density; }
  if (!partial || Object.hasOwn(input, 'defaultEnvoyChannelId')) result.defaultEnvoyChannelId = optionalChannel(input.defaultEnvoyChannelId);
  return Object.freeze(result);
}

export function effectiveWorkspaceLayout({ role, roleDefault = null, personal = null } = {}) {
  const fallback = roleDefault ? normalizeWorkspaceLayout(roleDefault) : roleDefaultLayout(role);
  const override = personal ? normalizeWorkspaceLayout(personal, { partial: true }) : {};
  return Object.freeze({ format: WORKSPACE_LAYOUT_FORMAT, valid: true, role: String(role).toLowerCase(), source: Object.keys(override).length ? 'role_default_plus_user_override' : 'role_default', visibleShelves: override.visibleShelves ?? fallback.visibleShelves, panelOrder: override.panelOrder ?? fallback.panelOrder, density: override.density ?? fallback.density, defaultEnvoyChannelId: override.defaultEnvoyChannelId ?? fallback.defaultEnvoyChannelId });
}
