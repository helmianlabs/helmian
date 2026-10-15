import { createCheckoutSession, resolveProductKey } from './stripe-contract.js';

// Downloads are free. Unless HELMIAN_PAID_CHECKOUT=true, the checkout route sends people to
// free account creation (Herald sign-up) instead of Stripe payment: /get-started prompts sign-up, then delivers the download. The Stripe customer is
// created after sign-up by createFreeStripeCustomer, so no card or payment is ever requested.
export function paidCheckoutEnabled(env = process.env) { return env.HELMIAN_PAID_CHECKOUT === 'true'; }

export function freeSignupUrl(product, env = process.env) {
  let key = 'helmian_individual';
  try { key = resolveProductKey(product, env); } catch { /* product ids are optional for free signup */ if (['helmian_individual', 'helmian_guard', 'helmian_bundle'].includes(product)) key = product; }
  return `/get-started?product=${encodeURIComponent(key)}`;
}

export async function createFreeStripeCustomer({ email, clerkUserId, product, env = process.env, fetchImpl = fetch }) {
  if (!env.STRIPE_SECRET_KEY) return { created: false, code: 'STRIPE_NOT_CONFIGURED' };
  const form = new URLSearchParams({ email: String(email || ''), 'metadata[clerk_user_id]': String(clerkUserId || ''), 'metadata[free_product]': String(product || 'helmian_individual'), 'metadata[source]': 'helmian_free_download' });
  const response = await fetchImpl('https://api.stripe.com/v1/customers', { method: 'POST', headers: { authorization: `Bearer ${env.STRIPE_SECRET_KEY}`, 'content-type': 'application/x-www-form-urlencoded' }, body: form });
  if (!response.ok) return { created: false, code: 'STRIPE_CUSTOMER_FAILED' };
  const body = await response.json();
  return { created: true, customerId: body.id };
}

function json(response, status, body) {
  response.statusCode = status;
  response.setHeader?.('content-type', 'application/json; charset=utf-8');
  response.setHeader?.('cache-control', 'no-store');
  response.end(JSON.stringify(body));
}

export default async function handler(request, response) {
  if (!paidCheckoutEnabled()) {
    const product = request.method === 'GET' ? new URL(request.url || '/', 'https://helmion.invalid').searchParams.get('product') : (typeof request.body === 'string' ? (() => { try { return JSON.parse(request.body).product; } catch { return undefined; } })() : request.body?.product);
    const signupUrl = freeSignupUrl(product);
    if (request.method === 'GET') { response.statusCode = 303; response.setHeader?.('cache-control', 'no-store'); response.setHeader?.('location', signupUrl); response.end(); return; }
    if (request.method === 'POST') return json(response, 200, { free: true, checkoutUrl: signupUrl });
  }
  if (request.method === 'GET') {
    try {
      const url = new URL(request.url || '/', 'https://helmion.invalid');
      const proto = request.headers?.['x-forwarded-proto'] || 'https';
      const host = request.headers?.['x-forwarded-host'] || request.headers?.host;
      const result = await createCheckoutSession({ product: url.searchParams.get('product'), env: process.env, origin: host ? `${proto}://${host}` : undefined });
      response.statusCode = 303;
      response.setHeader?.('cache-control', 'no-store');
      response.setHeader?.('location', result.checkoutUrl);
      response.end();
      return;
    } catch (error) {
      return json(response, Number(error?.status) || 503, { code: error?.code || 'CHECKOUT_UNAVAILABLE' });
    }
  }
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
