import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const root = new URL('../', import.meta.url);
const read = (p) => readFile(new URL(p, root), 'utf8');

test('pairing UI lives under /app and old links redirect there', async () => {
  const vercel = JSON.parse(await read('vercel.json'));
  const r = (src) => vercel.redirects.find((x) => x.source === src);
  assert.equal(r('/herald/pair')?.destination, '/app/pair');
  assert.equal(r('/herald/pair.html')?.destination, '/app/pair');
  assert.equal(r('/app/pair'), undefined, '/app/pair must be a real page, not a redirect');
  const html = await read('app/pair.html');
  assert.match(html, /\/herald\/app\.js/);
  assert.match(html, /\/app\/manifest\.webmanifest/);
  const route = await read('herald/pair-route.js');
  assert.match(route, /location\.replace\('\/app\/pair'/);
  const session = await read('server/herald-session.js');
  assert.match(session, /\/app\/pair\?channel=/);
});
