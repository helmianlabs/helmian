import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import handler, { freeSignupUrl, createFreeStripeCustomer } from '../server/billing/checkout.js';

const res = () => ({ headers: {}, statusCode: 0, body: '', setHeader(k, v) { this.headers[k] = v; }, end(b = '') { this.body = b; } });

test('download cards are free, no $10 price', () => {
  const page = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  assert.doesNotMatch(page, /\$10/u);
  assert.match(page, /Download for Windows \(\.exe\) · Free/u);
});

test('checkout route redirects to free sign-up instead of payment', async () => {
  delete process.env.HELMIAN_PAID_CHECKOUT;
  const r = res();
  await handler({ method: 'GET', url: '/api/billing/checkout?product=helmian_guard' }, r);
  assert.equal(r.statusCode, 303);
  assert.equal(r.headers.location, '/herald?signup=1&product=helmian_guard&next=download');
  assert.equal(freeSignupUrl('bogus'), '/herald?signup=1&product=helmian_individual&next=download');
});

test('free Stripe customer creation posts to customers, never charges', async () => {
  const calls = [];
  const out = await createFreeStripeCustomer({ email: 'a@b.c', clerkUserId: 'u1', product: 'helmian_individual', env: { STRIPE_SECRET_KEY: 'sk_test_x' }, fetchImpl: async (url, o) => { calls.push({ url, o }); return { ok: true, json: async () => ({ id: 'cus_1' }) }; } });
  assert.deepEqual(out, { created: true, customerId: 'cus_1' });
  assert.equal(calls[0].url, 'https://api.stripe.com/v1/customers');
  assert.equal((await createFreeStripeCustomer({ env: {} })).created, false);
});
