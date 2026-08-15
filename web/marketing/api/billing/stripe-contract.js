import { createHmac, timingSafeEqual } from 'node:crypto';

export const PRODUCT_KEYS = Object.freeze(['helmian_individual', 'helmian_guard', 'helmian_bundle']);
const PRODUCT_ENV = Object.freeze({
  helmian_individual: 'STRIPE_PRODUCT_HELMIAN_INDIVIDUAL',
  helmian_guard: 'STRIPE_PRODUCT_HELMIAN_GUARD',
  helmian_bundle: 'STRIPE_PRODUCT_HELMIAN_BUNDLE',
});

export function productIds(env = process.env) {
  return Object.freeze(Object.fromEntries(PRODUCT_KEYS
    .map((key) => [key, String(env[PRODUCT_ENV[key]] ?? '').trim()])
    .filter(([, id]) => id)));
}

function stripeSecret(env) {
  return env.STRIPE_SECRET_KEY ?? env.stripe_secret_key ?? env.STRIPE_RESTRICTED_KEY;
}

export function resolveProductKey(value, env = process.env) {
  const key = String(value ?? '').trim();
  if (!PRODUCT_KEYS.includes(key) || !productIds(env)[key]) throw Object.assign(new Error('product is not configured'), { code: 'PRODUCT_NOT_CONFIGURED', status: 503 });
  return key;
}

function stripeAuth(secret) {
  const value = String(secret ?? '').trim();
  if (!/^(?:sk|rk)_(?:test|live)_/u.test(value)) throw Object.assign(new Error('Stripe server secret is not configured'), { code: 'STRIPE_NOT_CONFIGURED', status: 503 });
  return `Basic ${Buffer.from(`${value}:`).toString('base64')}`;
}

async function stripeRequest(path, { secret, fetchImpl = fetch, method = 'GET', form } = {}) {
  const response = await fetchImpl(`https://api.stripe.com/v1/${path}`, {
    method,
    headers: { authorization: stripeAuth(secret), ...(form ? { 'content-type': 'application/x-www-form-urlencoded' } : {}) },
    body: form,
  });
  const body = await response.json();
  if (!response.ok) throw Object.assign(new Error(body?.error?.message || 'Stripe request failed'), { status: 502, code: 'STRIPE_REQUEST_FAILED' });
  return body;
}

export async function createCheckoutSession({ product, env = process.env, fetchImpl = fetch, origin }) {
  const key = resolveProductKey(product, env);
  const productId = productIds(env)[key];
  const secret = stripeSecret(env);
  const productBody = await stripeRequest(`products/${encodeURIComponent(productId)}`, { secret, fetchImpl });
  const priceId = typeof productBody.default_price === 'string' ? productBody.default_price : productBody.default_price?.id;
  if (!priceId) throw Object.assign(new Error('Stripe product has no default price'), { code: 'PRICE_NOT_CONFIGURED', status: 503 });
  const siteOrigin = new URL(String(origin || env.HELMION_SITE_ORIGIN || '')).origin;
  const returnPage = key === 'helmian_guard' ? '/guard.html' : '/index.html';
  const form = new URLSearchParams({ mode: 'payment', 'line_items[0][price]': priceId, 'line_items[0][quantity]': '1', success_url: `${siteOrigin}${returnPage}?checkout=success`, cancel_url: `${siteOrigin}${returnPage}?checkout=cancelled`, 'metadata[product]': key });
  const session = await stripeRequest('checkout/sessions', { secret, fetchImpl, method: 'POST', form });
  if (!session.url) throw Object.assign(new Error('Stripe did not return a checkout URL'), { code: 'CHECKOUT_URL_MISSING', status: 502 });
  return Object.freeze({ checkoutUrl: session.url, product: key, sessionId: session.id ?? null });
}

export function verifyStripeSignature(rawBody, signatureHeader, secret, now = Date.now()) {
  const values = Object.fromEntries(String(signatureHeader ?? '').split(',').map((part) => part.trim().split('=')));
  if (!values.t || !values.v1 || !secret) return false;
  const timestamp = Number(values.t);
  if (!Number.isFinite(timestamp) || Math.abs(now / 1000 - timestamp) > 300) return false;
  const expected = createHmac('sha256', secret).update(`${timestamp}.${rawBody}`, 'utf8').digest('hex');
  const actual = Buffer.from(values.v1, 'hex');
  const wanted = Buffer.from(expected, 'hex');
  return actual.length === wanted.length && timingSafeEqual(actual, wanted);
}

export function createEntitlementWebhookHandler({ secret = process.env.STRIPE_WEBHOOK_SECRET, entitlementStore, env = process.env } = {}) {
  return async function webhook(request, response) {
    if (request.method !== 'POST') { response.statusCode = 405; response.end(JSON.stringify({ code: 'method_not_allowed' })); return; }
    if (!entitlementStore?.hasEvent || !entitlementStore?.recordEvent || !entitlementStore?.grant) { response.statusCode = 503; response.end(JSON.stringify({ code: 'ENTITLEMENT_STORE_NOT_CONFIGURED' })); return; }
    const raw = typeof request.body === 'string' ? request.body : await new Promise((resolve, reject) => { let chunks = ''; request.on('data', (chunk) => { chunks += chunk; }); request.on('end', () => resolve(chunks)); request.on('error', reject); });
    if (!verifyStripeSignature(raw, request.headers?.['stripe-signature'], secret)) { response.statusCode = 400; response.end(JSON.stringify({ code: 'INVALID_STRIPE_SIGNATURE' })); return; }
    let event;
    try { event = JSON.parse(raw); } catch { response.statusCode = 400; response.end(JSON.stringify({ code: 'INVALID_STRIPE_EVENT' })); return; }
    if (event.type !== 'checkout.session.completed') { response.statusCode = 200; response.end(JSON.stringify({ received: true, ignored: true })); return; }
    const session = event.data?.object;
    if (session?.payment_status !== 'paid' || !session.id || !session.customer || !event.id || !PRODUCT_KEYS.includes(session.metadata?.product) || !productIds(env)[session.metadata?.product]) { response.statusCode = 400; response.end(JSON.stringify({ code: 'INVALID_PAID_SESSION' })); return; }
    if (await entitlementStore.hasEvent(event.id)) { response.statusCode = 200; response.end(JSON.stringify({ received: true, replayed: true })); return; }
    await entitlementStore.grant({ customerId: session.customer, product: session.metadata.product, sessionId: session.id });
    await entitlementStore.recordEvent(event.id);
    response.statusCode = 200; response.end(JSON.stringify({ received: true, replayed: false }));
  };
}
