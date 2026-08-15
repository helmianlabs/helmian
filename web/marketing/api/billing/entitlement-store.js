const PRODUCT_COLUMNS = Object.freeze({ helmian_individual: 'individual', helmian_guard: 'guard', helmian_bundle: 'bundle' });

export function createEntitlementStore({ query } = {}) {
  if (typeof query !== 'function') return null;
  return {
    async hasEvent(eventId) { const result = await query('SELECT 1 FROM helmion.billing_events WHERE event_id = $1', [eventId]); return result.rowCount > 0; },
    async recordEvent(eventId) { await query('INSERT INTO helmion.billing_events (event_id) VALUES ($1) ON CONFLICT (event_id) DO NOTHING', [eventId]); },
    async grant({ customerId, product, sessionId }) { if (!PRODUCT_COLUMNS[product]) throw new Error('unsupported entitlement product'); await query('INSERT INTO helmion.billing_entitlements (customer_id, product_key, session_id) VALUES ($1, $2, $3) ON CONFLICT (customer_id, product_key) DO UPDATE SET session_id = EXCLUDED.session_id, updated_at = now()', [customerId, product, sessionId]); },
    async hasEntitlement(customerId, product) { const result = await query('SELECT 1 FROM helmion.billing_entitlements WHERE customer_id = $1 AND product_key = $2', [customerId, product]); return result.rowCount > 0; },
  };
}

export function createArtifactResolver(env = process.env) {
  const urls = Object.freeze({ helmian_individual: env.HELMION_ARTIFACT_HELMIAN_INDIVIDUAL_URL, helmian_guard: env.HELMION_ARTIFACT_HELMIAN_GUARD_URL, helmian_bundle: env.HELMION_ARTIFACT_HELMIAN_BUNDLE_URL });
  return async ({ product }) => { const value = String(urls[product] ?? '').trim(); if (!value) return null; const url = new URL(value); if (url.protocol !== 'https:') return null; return { url: url.toString() }; };
}
