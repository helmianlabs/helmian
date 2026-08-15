export const LOCAL_VIEW_PREFERENCES_KEY = 'helmian.cloud.local-view-preferences.v1';

const DENSITIES = new Set(['comfortable', 'compact']);

export function normalizeLocalViewPreferences(value = {}) {
  const density = DENSITIES.has(value?.density) ? value.density : 'comfortable';
  return Object.freeze({ density });
}

export function readLocalViewPreferences(storage) {
  try {
    return normalizeLocalViewPreferences(JSON.parse(storage?.getItem(LOCAL_VIEW_PREFERENCES_KEY) ?? '{}'));
  } catch {
    return normalizeLocalViewPreferences();
  }
}

export function saveLocalViewPreferences(storage, input = {}) {
  const preferences = normalizeLocalViewPreferences(input);
  try { storage?.setItem(LOCAL_VIEW_PREFERENCES_KEY, JSON.stringify(preferences)); } catch { /* Browser storage is optional. */ }
  return preferences;
}
