import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  buildPairingLink, readPairingCodeFromHash, takePairingCodeFromLocation,
  ENROLL_FRAGMENT_KEY, PAIR_FRAGMENT_KEY,
} from '../src/herald/pairing-link.mjs';

test('builds enroll and pair links with the code only in the fragment', () => {
  const enroll = new URL(buildPairingLink('https://helmian.vercel.app/herald/', '1234-5678', ENROLL_FRAGMENT_KEY));
  assert.equal(enroll.hash, '#enroll=12345678');
  assert.equal(enroll.search, '');
  const pair = new URL(buildPairingLink('https://helmian.vercel.app/herald/?channel=herald_abcdefghijklmnopqrstu', '01234567'));
  assert.equal(pair.searchParams.get('channel'), 'herald_abcdefghijklmnopqrstu');
  assert.equal(pair.hash, `#${PAIR_FRAGMENT_KEY}=01234567`);
});

test('refuses unsafe links and malformed codes', () => {
  assert.throws(() => buildPairingLink('http://evil.example/herald/', '12345678'));
  assert.throws(() => buildPairingLink('https://u:p@helmian.vercel.app/', '12345678'));
  assert.throws(() => buildPairingLink('https://helmian.vercel.app/', '1234'));
  assert.throws(() => buildPairingLink('https://helmian.vercel.app/', '12345678', 'token'));
  assert.ok(buildPairingLink('http://127.0.0.1:7420/', '12345678'));
  assert.ok(buildPairingLink('http://192.168.1.20:7420/', '12345678'));
  assert.throws(() => buildPairingLink('http://8.8.8.8:7420/', '12345678'));
});

test('reads and scrubs the fragment exactly once', () => {
  assert.equal(readPairingCodeFromHash('#enroll=12345678', 'enroll'), '12345678');
  assert.equal(readPairingCodeFromHash('#enroll=12345678', 'pair'), null);
  assert.equal(readPairingCodeFromHash('#pair=12ab', 'pair'), null);
  const calls = [];
  const loc = { hash: '#pair=87654321', pathname: '/herald/', search: '?channel=x' };
  const hist = { state: null, replaceState: (...args) => calls.push(args) };
  assert.equal(takePairingCodeFromLocation(loc, hist), '87654321');
  assert.deepEqual(calls, [[null, '', '/herald/?channel=x']]);
  assert.equal(takePairingCodeFromLocation({ hash: '', pathname: '/', search: '' }, hist), null);
  assert.equal(calls.length, 1);
});

test('browser copy matches the source module', async () => {
  const src = await readFile(new URL('../src/herald/pairing-link.mjs', import.meta.url), 'utf8');
  const web = await readFile(new URL('../web/marketing/herald/pairing-link.js', import.meta.url), 'utf8');
  assert.equal(web.split('\n').slice(1).join('\n'), src);
});
