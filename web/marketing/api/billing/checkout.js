import { createCheckoutSession } from './stripe-contract.js';

function json(response, status, body) {
  response.statusCode = status;
  response.setHeader?.('content-type', 'application/json; charset=utf-8');
  response.setHeader?.('cache-control', 'no-store');
  response.end(JSON.stringify(body));
}

export default async function handler(request, response) {
  if (request.method !== 'POST') return json(response, 405, { code: 'method_not_allowed' });
  let body = request.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { return json(response, 400, { code: 'invalid_json' }); } }
  try {
    const proto = request.headers?.['x-forwarded-proto'] || 'https';
    const host = request.headers?.['x-forwarded-host'] || request.headers?.host;
    const result = await createCheckoutSession({ product: body?.product, env: process.env, origin: host ? `${proto}://${host}` : undefined });
    return json(response, 200, result);
  } catch (error) {
    return json(response, Number(error?.status) || 503, { code: error?.code || 'CHECKOUT_UNAVAILABLE' });
  }
}
