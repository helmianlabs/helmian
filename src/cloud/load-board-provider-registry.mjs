import { searchLoadBoard } from '../core/local-orchestration.mjs';
import { normalizeActorRole, normalizeTenantId } from '../core/tenant-context.mjs';

const PROVIDERS = Object.freeze([
  Object.freeze({ provider_id: 'dat', label: 'DAT', status: 'awaiting_integration', auth: 'oauth_or_api', sample_adapter: 'load-board-mock' }),
  Object.freeze({ provider_id: 'truckstop', label: 'Truckstop', status: 'awaiting_integration', auth: 'oauth_or_api', sample_adapter: 'load-board-mock' }),
  Object.freeze({ provider_id: '123loadboard', label: '123Loadboard', status: 'awaiting_integration', auth: 'oauth_or_api', sample_adapter: 'load-board-mock' }),
]);
function freeze(value) { if (value && typeof value === 'object' && !Object.isFrozen(value)) { for (const child of Object.values(value)) freeze(child); Object.freeze(value); } return value; }
function scope(input) { if (!input || typeof input !== 'object' || Array.isArray(input)) throw new TypeError('scope is invalid'); return freeze({ tenant_id: normalizeTenantId(input.tenant_id), actor_role: normalizeActorRole(input.actor_role) }); }

export function listLoadBoardProviderReadiness(input) {
  try { const tenant = scope(input); return freeze({ valid: true, result: { format: 'helmion.load-board-provider-readiness.v1', ...tenant, providers: PROVIDERS, execution: 'not_enabled' } }); }
  catch { return freeze({ valid: false, code: 'LOAD_BOARD_PROVIDER_READINESS_INVALID' }); }
}

export function searchNormalizedSampleLoads(input) {
  try {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new TypeError('input is invalid');
    const selected = String(input.provider_id ?? 'dat').trim().toLowerCase();
    if (!PROVIDERS.some((provider) => provider.provider_id === selected)) throw new TypeError('provider is invalid');
    const result = searchLoadBoard({ tenant_id: input.tenant_id, actor_role: input.actor_role, criteria: input.criteria, limit: input.limit, provider_id: 'load-board-mock' });
    if (!result.valid) throw new TypeError('search is invalid');
    return freeze({ valid: true, result: { ...result.result, selected_provider: selected, provider_status: 'awaiting_integration', source: 'deterministic_sample' } });
  } catch { return freeze({ valid: false, code: 'NORMALIZED_LOAD_BOARD_SEARCH_INVALID' }); }
}
