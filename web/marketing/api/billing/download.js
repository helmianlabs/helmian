import { resolveProductKey } from './stripe-contract.js';

function json(response, status, body) {
  response.statusCode = status;
  response.setHeader?.('content-type', 'application/json; charset=utf-8');
  response.setHeader?.('cache-control', 'no-store');
  response.end(JSON.stringify(body));
}

export function createDownloadHandler({ entitlementStore, resolveCustomer, resolveArtifact, env = process.env } = {}) {
  return async function handler(request, response) {
    if (request.method !== 'GET') return json(response, 405, { code: 'method_not_allowed' });
    if (!entitlementStore?.hasEntitlement || typeof resolveCustomer !== 'function' || typeof resolveArtifact !== 'function') return json(response, 503, { code: 'DOWNLOAD_NOT_CONFIGURED' });
    const customerId = await resolveCustomer(request);
    if (!customerId) return json(response, 401, { code: 'AUTH_REQUIRED' });
    const product = new URL(request.url || '/', 'https://helmion.invalid').searchParams.get('product');
    let key;
    try { key = resolveProductKey(product, env); } catch (error) { return json(response, Number(error?.status) || 503, { code: error?.code || 'PRODUCT_NOT_CONFIGURED' }); }
    if (!await entitlementStore.hasEntitlement(customerId, key)) return json(response, 403, { code: 'ENTITLEMENT_REQUIRED' });
    const artifact = await resolveArtifact({ customerId, product: key });
    if (!artifact?.url) return json(response, 503, { code: 'ARTIFACT_NOT_READY' });
    response.statusCode = 302;
    response.setHeader?.('cache-control', 'no-store');
    response.setHeader?.('location', artifact.url);
    response.end();
  };
}

export default function handler(request, response) { return createDownloadHandler()(request, response); }
