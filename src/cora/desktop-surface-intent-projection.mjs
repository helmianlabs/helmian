import { planCoraSurfaceIntent } from './surface-intent-planner.mjs';

// The desktop boundary deliberately consumes the typed Cora plan instead of
// speech or arbitrary UI instructions.  It only identifies an existing
// Helmian desktop page for a future host to show; it never calls NavigateTo,
// launches an application, or changes the selected page itself.
export const CORA_DESKTOP_SURFACE_PROJECTION_SCHEMA_VERSION = 1;
export const CORA_DESKTOP_SURFACE_PROJECTION_FORMAT = 'cora.desktop-surface-intent-projection.v1';

export const CORA_HELMIAN_DESKTOP_PAGE_CATALOG = Object.freeze({
  dashboard: Object.freeze({ page_id: 'Overview', label: 'Helmian overview' }),
  activity: Object.freeze({ page_id: 'Activity', label: 'Helmian activity' }),
  documents: Object.freeze({ page_id: 'Workspace', label: 'Helmian workspace' }),
  integrations: Object.freeze({ page_id: 'Integrations', label: 'Helmian integrations' }),
  settings: Object.freeze({ page_id: 'Settings', label: 'Helmian settings' }),
  help: Object.freeze({ page_id: 'Console', label: 'Helmian console' }),
  approvals: Object.freeze({ page_id: 'Approvals', label: 'Helmian approvals' }),
});

const PLAN_KEYS = Object.freeze([
  'actor_role',
  'authorized_tenant_ids',
  'intent',
  'mode',
  'request',
  'tenant_id',
]);

const FIXED_STATUS = Object.freeze({
  schemaVersion: CORA_DESKTOP_SURFACE_PROJECTION_SCHEMA_VERSION,
  format: CORA_DESKTOP_SURFACE_PROJECTION_FORMAT,
  mode: 'sample-data-only',
  enabled: false,
  wired: false,
  execution: 'not-wired',
  invocation: 'not_performed',
  authorization: 'not_evaluated',
});

function freeze(value) {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function exactKeys(value, expected) {
  if (!isObject(value)) return false;
  const actual = Reflect.ownKeys(value).filter((key) => typeof key === 'string').sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

function fail(code, status = 'clarification-required') {
  return freeze({
    ...FIXED_STATUS,
    valid: false,
    status,
    code,
    plan: null,
    desktop: null,
  });
}

/**
 * Project one already bounded Cora surface request toward a known Helmian
 * desktop page.  A desktop host may later display this preview and, after a
 * separate authorization and UI-invocation contract exists, choose to act.
 * This projection does not itself navigate or gain that authority.
 */
export function projectCoraSurfaceIntentToDesktop(input) {
  if (!isObject(input) || !exactKeys(input, PLAN_KEYS)) {
    return fail('CORA_DESKTOP_SURFACE_REQUEST_INVALID');
  }

  const plan = planCoraSurfaceIntent(input);
  if (plan.valid !== true) {
    return fail(plan.code ?? 'CORA_DESKTOP_SURFACE_PLAN_REJECTED', plan.status ?? 'rejected');
  }

  const surfaceId = plan.request.surface_id;
  const desktopPage = CORA_HELMIAN_DESKTOP_PAGE_CATALOG[surfaceId];
  const desktop = desktopPage
    ? Object.freeze({
      status: 'preview-ready',
      availability: 'desktop-page-known',
      page_id: desktopPage.page_id,
      label: desktopPage.label,
      navigation: 'not_performed',
    })
    : Object.freeze({
      status: 'awaiting-desktop-surface',
      availability: 'not-installed',
      page_id: null,
      label: null,
      navigation: 'not_performed',
    });

  return freeze({
    ...FIXED_STATUS,
    valid: true,
    status: desktop.status,
    plan,
    desktop,
  });
}
