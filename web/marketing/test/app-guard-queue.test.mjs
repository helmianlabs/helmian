import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { guardQueueReadModel, GUARD_QUEUE_NO_ANSWER } from '../app/app-model.mjs';

// The rehearsal defect: the Approvals surface showed
// "Guard is unreachable (Unexpected token '<'… not valid JSON)" while the
// Executive Guard was healthy. The route's answer had been a non-JSON body
// (an HTML error page in front of the function), the view parsed it with an
// unguarded res.json(), and the catch rendered the raw parser error under
// words blaming the Guard. These tests pin the replacement: every answer
// is classified first, and each state renders its own honest words.

const HTML_PAGE = '<!DOCTYPE html><html><head><title>500</title></head><body>An error occurred</body></html>';

test('a healthy JSON answer is ok and carries the body through', () => {
  const read = guardQueueReadModel(200, JSON.stringify({ approvals: [{ approvalId: 'a1' }] }));
  assert.equal(read.state, 'ok');
  assert.equal(read.body.approvals[0].approvalId, 'a1');
});

test('the Guard real response shape parses through the route body unchanged', () => {
  // Field-for-field what the deployed Executive Guard emits for a pending
  // approval (see the real-shape fixture in test/guard-pc-approvals), as
  // the route republishes it: the view must reach state ok with the list.
  const routeBody = { approvals: [{ approvalId: '02641f0c-7295-4257-a8d5-017874af5e8e', status: 'pending', summary: 'hands make_dir', tool: 'make_dir', deviceId: 'hands-mcp' }] };
  const read = guardQueueReadModel(200, JSON.stringify(routeBody));
  assert.equal(read.state, 'ok');
  assert.equal(read.body.approvals.length, 1);
  assert.equal(read.body.approvals[0].tool, 'make_dir');
});

test('the route reporting the Guard down reads as Guard unreachable, with no raw error text', () => {
  const read = guardQueueReadModel(502, JSON.stringify({ error: 'GUARD_UNAVAILABLE', status: 500 }));
  assert.equal(read.state, 'guard-unreachable');
  assert.equal(read.message, 'Guard is unreachable. Nothing will run until it answers.');
  const timeout = guardQueueReadModel(502, JSON.stringify({ error: 'GUARD_TIMEOUT' }));
  assert.equal(timeout.state, 'guard-unreachable');
});

test('an unreadable Guard answer (via the route) is its own state, distinct from unreachable', () => {
  const read = guardQueueReadModel(502, JSON.stringify({ error: 'GUARD_BAD_RESPONSE', status: 200 }));
  assert.equal(read.state, 'guard-bad-response');
  assert.match(read.message, /could not be read/);
  assert.notEqual(read.message, 'Guard is unreachable. Nothing will run until it answers.');
});

test('a non-JSON answer is unreadable: it never claims the Guard is down and never shows a parser error', () => {
  const read = guardQueueReadModel(500, HTML_PAGE);
  assert.equal(read.state, 'unreadable');
  assert.ok(!read.message.includes('Guard is unreachable'), 'an HTML error page is not proof the Guard is down');
  assert.ok(!read.message.includes('Unexpected token'), 'raw parser errors are never rendered');
  assert.ok(!read.message.includes('<'), 'no markup from the answer leaks into the words');
  assert.match(read.message, /state is unknown/);
});

test('a 200 with an HTML body is still unreadable, not ok', () => {
  const read = guardQueueReadModel(200, HTML_PAGE);
  assert.equal(read.state, 'unreadable');
});

test('the route own states keep their exact words (503, 403, 401)', () => {
  assert.deepEqual(guardQueueReadModel(503, JSON.stringify({ error: 'GUARD_APPROVER_NOT_CONFIGURED' })), { state: 'not-configured', message: 'PC approvals are not switched on for this workspace yet. Once your PC is linked, Guard asks you here before anything runs on it.' });
  assert.equal(guardQueueReadModel(403, JSON.stringify({ error: 'GUARD_APPROVER_REQUIRED' })).state, 'forbidden');
  assert.equal(guardQueueReadModel(403, JSON.stringify({ error: 'GUARD_APPROVER_REQUIRED' })).message, 'PC actions are approved by the PC owner’s account. Sign in with that account to Allow or Deny them.');
  assert.equal(guardQueueReadModel(401, JSON.stringify({ error: 'Not authenticated' })).state, 'unauthenticated');
});

test('no-answer words blame the missing server answer, never the Guard, and carry no raw error', () => {
  assert.ok(!GUARD_QUEUE_NO_ANSWER.includes('Guard is unreachable'));
  assert.ok(!GUARD_QUEUE_NO_ANSWER.includes('Unexpected token'));
  assert.match(GUARD_QUEUE_NO_ANSWER, /did not answer at all/);
});

test('app.js renders Guard queue states through the model — the raw-error banner is gone', async () => {
  const src = await readFile(new URL('../app/app.js', import.meta.url), 'utf8');
  assert.ok(!src.includes('Guard is unreachable (${error.message})'), 'the raw parser error banner must not come back');
  assert.ok(src.includes('guardQueueReadModel(res.status, await res.text())'), 'both Guard queue reads classify before parsing');
  assert.ok(src.includes('GUARD_QUEUE_NO_ANSWER'), 'a fetch that never answers gets the no-answer words');
});
