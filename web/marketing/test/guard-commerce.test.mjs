import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import checkoutHandler from '../api/billing/checkout.js';
import { createDownloadHandler, } from '../api/billing/download.js';
import { createCheckoutSession, createEntitlementWebhookHandler, verifyStripeSignature } from '../api/billing/stripe-contract.js';
import { createHmac } from 'node:crypto';

const page = await readFile(new URL('../guard.html', import.meta.url), 'utf8');
const config = await readFile(new URL('../site-config.js', import.meta.url), 'utf8');

function response() {
  return { statusCode: 0, headers: {}, body: '', setHeader(name, value) { this.headers[name] = value; }, end(value) { this.body = value; } };
}

test('Guard page exposes reviewed package slots and honest checkout handoff', () => {
  assert.match(page, /data-download-key="chromium"/u);
  assert.match(page, /data-download-key="firefox"/u);
  assert.match(page, /data-guard-checkout/u);
  assert.match(page, /no store submission yet/iu);
  assert.match(config, /helmian_individual/u);
  assert.match(config, /helmian_guard/u);
});

test('checkout remains inert without Stripe configuration', async () => {
  const get = response();
  checkoutHandler({ method: 'GET' }, get);
  assert.equal(get.statusCode, 405);
  const post = response();
  await checkoutHandler({ method: 'POST', body: { product: 'helmian_guard' } }, post);
  assert.equal(post.statusCode, 503);
  assert.equal(JSON.parse(post.body).code, 'PRODUCT_NOT_CONFIGURED');
  assert.equal(post.headers['cache-control'], 'no-store');
});

test('Stripe product default price maps to one-time checkout without exposing secret', async () => {
  const calls = [];
  const fetchImpl = async (url, options) => { calls.push({ url, options }); return { ok: true, async json() { return url.includes('/products/') ? { default_price: 'price_guard' } : { id: 'cs_1', url: 'https://checkout.stripe.test/cs_1' }; } }; };
  const result = await createCheckoutSession({ product: 'helmian_guard', env: { STRIPE_PRODUCT_HELMIAN_GUARD: 'prod_guard', STRIPE_SECRET_KEY: 'sk_test_x' }, fetchImpl, origin: 'https://helmian.example' });
  assert.equal(result.checkoutUrl, 'https://checkout.stripe.test/cs_1');
  assert.equal(calls.length, 2);
  assert.match(calls[0].options.headers.authorization, /^Basic /u);
  assert.doesNotMatch(JSON.stringify(result), /sk_test/u);
});

test('signed checkout webhook is idempotent and grants only paid customer sessions', async () => {
  const events = new Set(); const grants = [];
  const store = { hasEvent: async (id) => events.has(id), recordEvent: async (id) => events.add(id), grant: async (value) => grants.push(value) };
  const handler = createEntitlementWebhookHandler({ secret: 'whsec_test', entitlementStore: store, env: { STRIPE_PRODUCT_HELMIAN_GUARD: 'prod_guard' } });
  const event = JSON.stringify({ id: 'evt_1', type: 'checkout.session.completed', data: { object: { id: 'cs_1', customer: 'cus_1', payment_status: 'paid', metadata: { product: 'helmian_guard' } } } });
  const timestamp = Math.floor(Date.now() / 1000); const sig = createHmac('sha256', 'whsec_test').update(`${timestamp}.${event}`).digest('hex');
  const request = { method: 'POST', body: event, headers: { 'stripe-signature': `t=${timestamp},v1=${sig}` } };
  const first = response(); await handler(request, first); const replay = response(); await handler(request, replay);
  assert.equal(first.statusCode, 200); assert.equal(JSON.parse(replay.body).replayed, true); assert.equal(grants.length, 1); assert.equal(verifyStripeSignature(event, `t=${timestamp},v1=${sig}`, 'whsec_test'), true);
});

test('download gate requires entitlement and never exposes artifact publicly', async () => {
  const handler = createDownloadHandler({ env: { STRIPE_PRODUCT_HELMIAN_GUARD: 'prod_guard' }, resolveCustomer: async () => 'cus_1', entitlementStore: { hasEntitlement: async () => false }, resolveArtifact: async () => ({ url: 'https://private.invalid/file' }) });
  const denied = response(); await handler({ method: 'GET', url: '/api/billing/download?product=helmian_guard' }, denied); assert.equal(denied.statusCode, 403);
  const allowed = createDownloadHandler({ env: { STRIPE_PRODUCT_HELMIAN_GUARD: 'prod_guard' }, resolveCustomer: async () => 'cus_1', entitlementStore: { hasEntitlement: async () => true }, resolveArtifact: async () => ({ url: 'https://private.invalid/file' }) });
  const redirected = response(); await allowed({ method: 'GET', url: '/api/billing/download?product=helmian_guard' }, redirected); assert.equal(redirected.statusCode, 302); assert.equal(redirected.headers.location, 'https://private.invalid/file'); assert.equal(redirected.headers['cache-control'], 'no-store');
});
