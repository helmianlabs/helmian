import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { connectFailureMessage } from '../app/envoy-workspace.js';

// Connect paint bite (2026-11-11): a refused connect start must
// paint the server's answer in the panel, not read as silence.
// The proven case: a Gamma Connect click answered 502 after
// 10.17s with plain words in the body ({ error, code } — the
// connector library write route's refusal shape, thrown by the
// shell's api() with the parsed body on the error's .body), and
// the panel showed nothing for the full 30 seconds watched:
// startPanelConnect's only failure feedback was ws.ctx.toast,
// whose node (#toast) lives inside the console view's section —
// hidden whenever the workspace panel is on screen. The refusal
// now ALSO records on ws.connectErrors and paints under the
// entry's own row as an ew-note (the key form's error idiom).

const GAMMA_REFUSAL = 'the resource metadata at https://mcp.gamma.app/.well-known/oauth-protected-resource names https://mcp.gamma.app, not this connector';

test('a refused connect start speaks the server\'s own words', () => {
  // The write route's refusal body, as api() surfaces it: thrown
  // error carrying the parsed body on .body.
  const thrown = Object.assign(new Error('resource-mismatch'), {
    status: 502,
    body: { valid: false, error: GAMMA_REFUSAL, code: 'resource-mismatch' },
  });
  assert.equal(connectFailureMessage(thrown, 'Gamma'), GAMMA_REFUSAL);
});

test('a refusal without words in the body falls back to the panel\'s generic line', () => {
  assert.equal(connectFailureMessage(new Error('HTTP 502'), 'Gamma'), 'Could not start Gamma. Try again.');
  assert.equal(connectFailureMessage({ body: {} }, 'Gamma'), 'Could not start Gamma. Try again.');
  assert.equal(connectFailureMessage({ body: { error: '' } }, 'Gamma'), 'Could not start Gamma. Try again.');
  assert.equal(connectFailureMessage(null, 'Gamma'), 'Could not start Gamma. Try again.');
  assert.equal(connectFailureMessage(undefined, 'Slack'), 'Could not start Slack. Try again.');
});

test('wiring: the refusal is recorded per entry, painted as a note under its row, and cleared on the next answer', async () => {
  const js = await readFile(new URL('../app/envoy-workspace.js', import.meta.url), 'utf8');
  // The handler records the words against the entry's own key
  // and repaints the picker — the toast still fires alongside.
  assert.ok(js.includes('ws.connectErrors[connectKey] = message'), 'startPanelConnect records the refusal on ws.connectErrors');
  assert.ok(js.includes('ws.ctx.toast(message);'), 'the toast still fires with the same words');
  assert.ok(js.includes('if (connectKey) delete ws.connectErrors[connectKey];'), 'any answer that comes back clears the painted refusal');
  // The row renderer paints the recorded words under the row in
  // the panel's note style, grouped with the row like the key
  // form's expansion.
  assert.ok(js.includes("h('p', { class: 'ew-note' }, connectError)"), 'the row paints the refusal as an ew-note under the Connect row');
  // The state the renderer reads exists on the workspace state.
  assert.ok(js.includes('connectErrors: {},'), 'ws state carries the connectErrors map');
});
