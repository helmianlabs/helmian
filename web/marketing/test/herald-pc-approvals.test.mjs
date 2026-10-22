// Herald PC approvals panel with a tiny DOM stand-in (no browser needed).
import test from 'node:test';
import assert from 'node:assert/strict';
import { mountPcApprovals } from '../herald/pc-approvals.js';

function node(tag) {
  return { tag, children: [], hidden: false, textContent: '', className: '', disabled: false, onclick: null,
    append(...c) { this.children.push(...c); }, prepend(c) { this.children.unshift(c); }, replaceChildren(...c) { this.children = c; } };
}
globalThis.document = { createElement: node };
const all = (n) => [n, ...n.children.flatMap(all)];

function fakeFetch(state) {
  return async (url, init = {}) => {
    state.calls.push({ url, init });
    if (state.status !== 200) return { status: state.status, json: async () => ({}) };
    if (url.endsWith('/decide')) { state.pending = []; return { status: 200, json: async () => ({ approval: { status: 'denied' } }) }; }
    return { status: 200, json: async () => ({ approvals: state.pending }) };
  };
}

test('hidden when not configured or not the owner', async () => {
  for (const status of [401, 403, 503]) {
    const container = node('section');
    const p = mountPcApprovals({ container, token: async () => 't', fetchImpl: fakeFetch({ calls: [], status, pending: [] }) });
    await p.refresh();
    assert.equal(container.children[0].hidden, true, String(status));
  }
});

test('lists pending PC actions and Deny posts the decision with the Clerk bearer', async () => {
  const state = { calls: [], status: 200, pending: [{ approvalId: 'e1297528-2117-4430-9c76-ea10bd833c19', summary: 'hands write_file', reason: 'needs a human' }] };
  const container = node('section');
  const p = mountPcApprovals({ container, token: async () => 'clerk-token', fetchImpl: fakeFetch(state), confirmImpl: () => true });
  await p.refresh();
  const section = container.children[0];
  assert.equal(section.hidden, false);
  assert.ok(all(section).some((n) => n.textContent === 'hands write_file'));
  const deny = all(section).find((n) => n.textContent === 'Deny');
  await deny.onclick();
  const post = state.calls.find((c) => c.url.endsWith('/decide'));
  assert.deepEqual(JSON.parse(post.init.body), { approvalId: 'e1297528-2117-4430-9c76-ea10bd833c19', approve: false });
  assert.equal(post.init.headers.authorization, 'Bearer clerk-token');
  assert.ok(all(section).some((n) => n.textContent === 'No PC actions waiting.'));
});

test('Approve asks for confirmation first', async () => {
  const state = { calls: [], status: 200, pending: [{ approvalId: 'e1297528-2117-4430-9c76-ea10bd833c19', summary: 'x' }] };
  const container = node('section');
  const p = mountPcApprovals({ container, token: async () => 't', fetchImpl: fakeFetch(state), confirmImpl: () => false });
  await p.refresh();
  await all(container).find((n) => n.textContent === 'Approve').onclick();
  assert.equal(state.calls.some((c) => c.url.endsWith('/decide')), false);
});
