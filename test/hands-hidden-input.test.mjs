import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFile } from 'node:fs/promises';
import { readHidden } from '../src/hands/hidden-input.mjs';

function fakeTty({ isTTY = true } = {}) {
  const input = new EventEmitter();
  input.isTTY = isTTY; input.isRaw = false; input.rawCalls = [];
  if (isTTY) input.setRawMode = (on) => { input.rawCalls.push(on); input.isRaw = on; };
  input.setEncoding = () => {}; input.resume = () => {}; input.pause = () => {};
  let written = '';
  const output = { write: (s) => { written += s; return true; } };
  return { input, output, written: () => written };
}

test('a TTY passphrase is never echoed: raw mode on, only * shown, raw mode restored', async () => {
  const t = fakeTty();
  const p = readHidden('Hands passphrase: ', t);
  t.input.emit('data', 'corr');
  t.input.emit('data', Buffer.from('ect horse\r'));
  assert.equal(await p, 'correct horse');
  assert.deepEqual(t.input.rawCalls, [true, false]);
  assert.equal(t.written(), `Hands passphrase: ${'*'.repeat(13)}\n`);
  assert.doesNotMatch(t.written(), /correct|horse/);
});

test('backspace edits the secret and the mask; Windows DEL and \\b both work', async () => {
  const t = fakeTty();
  const p = readHidden('> ', t);
  t.input.emit('data', 'abx\u007fc');
  t.input.emit('data', 'z\bd\n');
  assert.equal(await p, 'abcd');
  assert.doesNotMatch(t.written(), /[abcdxz]/);
});

test('Ctrl+C cancels and still restores the console', async () => {
  const t = fakeTty();
  const p = readHidden('> ', t);
  t.input.emit('data', 'sec\u0003');
  await assert.rejects(p, { code: 'ABORT_ERR' });
  assert.deepEqual(t.input.rawCalls, [true, false]);
});

test('piped (non-TTY) input reads one line and echoes nothing', async () => {
  const t = fakeTty({ isTTY: false });
  const p = readHidden('> ', t);
  t.input.emit('data', 'piped-secret\nrest');
  assert.equal(await p, 'piped-secret');
  assert.equal(t.written(), '> \n');
});

test('hands-spoke pair uses readHidden, not the readline output override', async () => {
  const src = await readFile(new URL('../bin/hands-spoke.mjs', import.meta.url), 'utf8');
  assert.match(src, /readHidden\('Hands passphrase: '\)/);
  assert.doesNotMatch(src, /_writeToOutput/);
});
