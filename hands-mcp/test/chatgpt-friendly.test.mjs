import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config.mjs';
import { WRITE_FILE_ANNOTATIONS } from '../src/server.mjs';
import { TOOLS } from '../src/shared/protocol.mjs';

const BASE = { PUBLIC_URL: 'http://127.0.0.1:1', AUTH_PASSPHRASE: 'x'.repeat(24), STATE_DIR: '/tmp' };

test('hold-open default returns before ChatGPT call timeouts (40 s), env still overrides', () => {
  assert.equal(loadConfig(BASE).holdOpenWaitMs, 40000);
  assert.equal(loadConfig({ ...BASE, HANDS_HOLD_OPEN_WAIT_MS: '840000' }).holdOpenWaitMs, 840000);
});

test('write_file is described and annotated as a local save, not an open-world action', () => {
  assert.equal(WRITE_FILE_ANNOTATIONS.openWorldHint, false);
  assert.equal(WRITE_FILE_ANNOTATIONS.readOnlyHint, false);
  assert.match(TOOLS.write_file.description, /Save a plain-text file/);
  assert.equal(TOOLS.write_file.mutating, true);
});
