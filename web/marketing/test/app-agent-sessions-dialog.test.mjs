import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';

// Regression (2026-11-01 walk): on the Agents page, "+ New session" rendered by
// renderAgentSessions was wired as `newBtn.onclick = showNewSessionDialog` — a
// DIRECT assignment of a function whose first parameter is defaultProvider.
// A click handler receives the MouseEvent as its first argument, so the event
// landed in defaultProvider; `providerSelect.value = <event>` matched no
// option, selectedIndex became -1, and the next line
// (`providerSelect.options[providerSelect.selectedIndex].text`) threw a
// TypeError before the overlay was ever appended. The press died silently:
// no dialog, no error surface, nothing.
//
// This test executes the REAL functions extracted from app.js against a
// minimal DOM whose <select> implements the spec value/selectedIndex
// semantics the bug turns on, and drives the full create path:
// list (empty) -> click "+ New session" -> dialog opens -> Start session ->
// POST /api/admin/envoy/agents/sessions -> session listed afterward.

const js = await readFile(new URL('../app/app.js', import.meta.url), 'utf8');

function extractFn(src, name) {
  let start = src.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `${name} not found in app.js`);
  if (src.slice(start - 6, start) === 'async ') start -= 6;
  let depth = 0;
  for (let j = src.indexOf('{', start); j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}') { depth--; if (depth === 0) return src.slice(start, j + 1); }
  }
  throw new Error(`unbalanced braces in ${name}`);
}
function extractConst(src, name) {
  const m = src.match(new RegExp(`const ${name} = [^;]+;`));
  assert.ok(m, `${name} not found in app.js`);
  return m[0];
}

// ---- minimal DOM (only what the extracted functions touch) ----
class FakeElement {
  constructor(tag) {
    this.tagName = tag.toUpperCase();
    this.children = [];
    this.className = '';
    this._text = '';
    this.style = {};
    this.dataset = {};
    this.value = '';
    this.parent = null;
  }
  set textContent(v) { this._text = String(v); this.children = []; }
  get textContent() { return this._text + this.children.map((c) => c.textContent).join(''); }
  // HTMLOptionElement.text reflects the option's text content; app.js reads it.
  get text() { return this.textContent; }
  set text(v) { this.textContent = v; }
  append(...kids) { for (const k of kids) { k.parent = this; this.children.push(k); } }
  replaceChildren(...kids) { this.children = []; this._text = ''; this.append(...kids); }
  remove() {
    if (!this.parent) return;
    const i = this.parent.children.indexOf(this);
    if (i >= 0) this.parent.children.splice(i, 1);
    this.parent = null;
  }
  setAttribute() {}
  focus() {}
  get firstChild() { return this.children[0] ?? null; }
  get childElementCount() { return this.children.length; }
}
const optVal = (o) => (o.value !== undefined && o.value !== '' ? String(o.value) : o.textContent);
class FakeSelect extends FakeElement {
  constructor() { super('select'); this._selectedIndex = -1; }
  get options() { return this.children.filter((c) => c.tagName === 'OPTION'); }
  append(...kids) {
    super.append(...kids);
    // Spec: inserting an option when none is selected selects the first one.
    if (this._selectedIndex === -1 && this.options.length) this._selectedIndex = 0;
  }
  get selectedIndex() { return this._selectedIndex; }
  set selectedIndex(i) { this._selectedIndex = i; }
  get value() { const o = this.options[this._selectedIndex]; return o ? optVal(o) : ''; }
  set value(v) { this._selectedIndex = this.options.findIndex((o) => optVal(o) === String(v)); }
}

function* walk(node) { yield node; for (const c of node.children) yield* walk(c); }
const findAll = (root, pred) => [...walk(root)].filter(pred);

function buildWorld() {
  const document = {
    body: new FakeElement('body'),
    createElement: (tag) => (tag === 'select' ? new FakeSelect() : new FakeElement(tag)),
    getElementById: () => null,
  };
  const el = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  };
  const server = { sessions: [] };
  const apiCalls = [];
  const api = async (path, init = {}) => {
    apiCalls.push({ path, init });
    if (init.method === 'POST' && path === '/api/admin/envoy/agents/sessions') {
      const body = JSON.parse(init.body);
      const session = { id: `sess-${server.sessions.length + 1}`, status: 'idle', lastMessage: null, ...body };
      server.sessions.push(session);
      return { valid: true, session };
    }
    if (path === '/api/admin/envoy/agents/sessions') return { valid: true, sessions: server.sessions };
    throw new Error(`unexpected api path ${path}`);
  };
  const container = new FakeElement('div');
  const $ = (sel) => (sel === '#agents-sessions' ? container : null);
  const toasts = [];
  const code = [
    extractConst(js, 'SESSION_STATUS_COLORS'),
    extractConst(js, 'SESSION_PROVIDERS'),
    extractConst(js, 'SESSION_TIERS'),
    extractFn(js, 'loadAgentSessions'),
    extractFn(js, 'renderAgentSessions'),
    extractFn(js, 'showNewSessionDialog'),
    'return { loadAgentSessions, renderAgentSessions, showNewSessionDialog };',
  ].join('\n');
  const factory = new Function('document', 'el', 'api', 'toast', 'state', 'agentIconFor', 'closeAgentSession', '$', code);
  const fns = factory(document, el, api, (m, k) => toasts.push([m, k]), {}, () => null, async () => {}, $);
  return { document, container, server, apiCalls, toasts, ...fns };
}

test('"+ New session" opens the dialog and a created session is listed afterward', async () => {
  const w = buildWorld();
  await w.loadAgentSessions();
  assert.match(w.container.textContent, /No agent sessions yet/, 'empty state renders');

  const newBtn = findAll(w.container, (n) => n.tagName === 'BUTTON' && n.textContent === '+ New session')[0];
  assert.ok(newBtn, 'the + New session button exists');
  assert.equal(typeof newBtn.onclick, 'function', 'the button has a click handler');

  // A browser dispatches the click EVENT as the handler's first argument.
  let thrown = null;
  try { newBtn.onclick({ type: 'click' }); } catch (e) { thrown = e; }
  assert.equal(thrown, null, `clicking must not throw (threw: ${thrown && thrown.message})`);

  const overlay = findAll(w.document.body, (n) => n.className === 'dialog-overlay')[0];
  assert.ok(overlay, 'the new-session dialog overlay is on the page after the click');
  const title = findAll(overlay, (n) => n.tagName === 'H3')[0];
  assert.match(title.textContent, /^New Maestro agent\./, 'dialog defaults to the first provider instead of dying on an unselected one');

  const nameInput = findAll(overlay, (n) => n.tagName === 'INPUT' && n.placeholder === 'e.g. Claude muse')[0];
  assert.ok(nameInput, 'name input present');
  nameInput.value = 'Claude muse';
  const startBtn = findAll(overlay, (n) => n.tagName === 'BUTTON' && n.textContent === 'Start session')[0];
  assert.ok(startBtn, 'Start session button present');
  await startBtn.onclick();
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));

  const post = w.apiCalls.find((c) => c.init.method === 'POST');
  assert.ok(post, 'creating the session POSTs');
  assert.equal(post.path, '/api/admin/envoy/agents/sessions');
  assert.deepEqual(JSON.parse(post.init.body), { name: 'Claude muse', provider: 'maestro', routingTier: 'auto' });
  assert.equal(w.server.sessions.length, 1, 'the session exists server-side');
  assert.equal(findAll(w.document.body, (n) => n.className === 'dialog-overlay').length, 0, 'dialog closed after create');
  assert.match(w.container.textContent, /1 session/, 'the list header counts the new session');
  assert.match(w.container.textContent, /Claude muse/, 'the new session is listed afterward');
});
