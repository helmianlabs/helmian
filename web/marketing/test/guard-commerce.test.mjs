import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import checkoutHandler from '../api/billing/checkout.js';

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
  assert.match(config, /checkout_not_configured/u);
});

test('checkout placeholder never starts payment or creates entitlement', () => {
  const get = response();
  checkoutHandler({ method: 'GET' }, get);
  assert.equal(get.statusCode, 405);
  const post = response();
  checkoutHandler({ method: 'POST' }, post);
  assert.equal(post.statusCode, 503);
  assert.deepEqual(JSON.parse(post.body), { code: 'checkout_not_configured', product: 'helmion-guard', paymentStarted: false, entitlementCreated: false });
  assert.equal(post.headers['cache-control'], 'no-store');
});
