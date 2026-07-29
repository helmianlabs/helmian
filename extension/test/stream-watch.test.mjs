// The streaming detector.
//
// Two signals, and the tests cover both, because the whole point is that either
// one alone is enough. The stop button is the prompt signal; quiescence is the
// one that survives a redesign.

import test from 'node:test';
import assert from 'node:assert/strict';

import { loadContentScript } from '../test-support/load-content-script.mjs';
import { element, documentWith } from '../test-support/mini-dom.mjs';

function makeObserverHolder() {
  const holder = { instances: [] };
  holder.MutationObserver = class FakeMutationObserver {
    constructor(callback) {
      this.callback = callback;
      this.records = [];
      this.disconnected = false;
      holder.instances.push(this);
    }

    observe(target, options) {
      this.target = target;
      this.options = options;
    }

    disconnect() {
      this.disconnected = true;
    }

    fire(records) {
      this.callback(records);
    }
  };
  return holder;
}

function siteMutation(node) {
  return { type: 'childList', target: node, addedNodes: [node], removedNodes: [] };
}

const wait = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

async function loadWatch(doc) {
  const holder = makeObserverHolder();
  const sandbox = await loadContentScript('content/stream-watch.js', {
    MutationObserver: holder.MutationObserver,
    document: doc,
  });
  return { api: sandbox.HelmionStreamWatch, holder };
}

test('a control labelled Stop means the assistant is still typing', async () => {
  const streaming = documentWith([
    element('button', { 'aria-label': 'Stop response' }, ['stop']),
  ]);
  const { api } = await loadWatch(streaming);
  assert.equal(api.isStreaming(streaming), true);
});

test('the label match is case-insensitive and matches the wording all three sites use', async () => {
  const { api } = await loadWatch(documentWith([]));
  const labels = ['Stop', 'Stop generating', 'stop streaming', 'Stop response'];
  for (const label of labels) {
    const doc = documentWith([element('button', { 'aria-label': label }, [])]);
    assert.equal(api.isStreaming(doc), true, `did not read "${label}" as streaming`);
  }
});

test('a send button is not a stop button', async () => {
  const idle = documentWith([element('button', { 'aria-label': 'Send message' }, [])]);
  const { api } = await loadWatch(idle);
  assert.equal(api.isStreaming(idle), false);
});

test('a hidden stop button does not count as streaming', async () => {
  const doc = documentWith([
    element('button', { 'aria-label': 'Stop response', 'aria-hidden': 'true' }, []),
  ]);
  const { api } = await loadWatch(doc);
  assert.equal(api.isStreaming(doc), false);
});

test('a stop button found only by test id still counts', async () => {
  const doc = documentWith([element('button', { 'data-testid': 'stop-button' }, [])]);
  const { api } = await loadWatch(doc);
  assert.equal(api.isStreaming(doc), true);
});

test('THE DEBOUNCE: a burst of token mutations produces one pass, not hundreds', async () => {
  const doc = documentWith([element('div', {}, ['reply'])]);
  const { api, holder } = await loadWatch(doc);

  let passes = 0;
  const watch = api.createStreamWatch({
    target: doc,
    document: doc,
    debounceMs: 20,
    quiescenceMs: 60,
    onPass: () => { passes += 1; },
  });

  watch.start();
  const passesAfterStart = passes;
  const observer = holder.instances[0];

  // 200 mutations, the shape of a reply streaming in token by token.
  for (let i = 0; i < 200; i += 1) observer.fire([siteMutation(element('span', {}, [String(i)]))]);

  await wait(120);
  watch.stop();

  assert.equal(passesAfterStart, 1, 'start() should check the page once immediately');
  assert.equal(passes - passesAfterStart, 1, `200 mutations produced ${passes - passesAfterStart} passes`);
  assert.equal(watch.stats().mutationCount, 200);
});

test('THE QUIESCENCE FALLBACK: the idle pass fires once the page goes quiet', async () => {
  const doc = documentWith([element('div', {}, ['reply'])]);
  const { api, holder } = await loadWatch(doc);

  const idleAt = [];
  const watch = api.createStreamWatch({
    target: doc,
    document: doc,
    debounceMs: 20,
    quiescenceMs: 60,
    onIdle: () => { idleAt.push(Date.now()); },
  });

  watch.start();
  const observer = holder.instances[0];
  observer.fire([siteMutation(element('span', {}, ['a']))]);

  await wait(30);
  assert.equal(idleAt.length, 1, 'idle fired before the page went quiet');

  await wait(80);
  watch.stop();
  assert.equal(idleAt.length, 2, 'idle did not fire after the page went quiet');
});

test('OUR OWN WARNING DOES NOT RETRIGGER THE WATCHER', async () => {
  // Without this the extension would draw a warning, see its own change, scan
  // again, draw again, forever.
  const doc = documentWith([]);
  const { api, holder } = await loadWatch(doc);

  let passes = 0;
  const watch = api.createStreamWatch({
    target: doc,
    document: doc,
    debounceMs: 20,
    quiescenceMs: 60,
    onPass: () => { passes += 1; },
  });

  watch.start();
  const passesAfterStart = passes;
  const observer = holder.instances[0];

  const ourPanel = element('div', { 'data-helmion-ui': '1' }, ['warning']);
  doc.appendChild(ourPanel);
  observer.fire([{ type: 'childList', target: doc, addedNodes: [ourPanel], removedNodes: [] }]);

  await wait(80);
  watch.stop();

  assert.equal(passes, passesAfterStart, 'the extension reacted to its own page change');
  assert.equal(watch.stats().mutationCount, 0);
});

test('a change inside our own panel is ignored, a change beside it is not', async () => {
  const { api } = await loadWatch(documentWith([]));

  const panel = element('div', { 'data-helmion-ui': '1' }, []);
  const inside = element('span', {}, ['x']);
  panel.appendChild(inside);

  const theirs = element('p', {}, ['their content']);
  documentWith([theirs]);

  assert.equal(
    api.isOwnMutation({ type: 'characterData', target: inside, addedNodes: [], removedNodes: [] }),
    true,
  );
  assert.equal(
    api.isOwnMutation({ type: 'childList', target: theirs, addedNodes: [theirs], removedNodes: [] }),
    false,
  );
});

test('stop() disconnects the observer so nothing keeps running', async () => {
  const doc = documentWith([]);
  const { api, holder } = await loadWatch(doc);
  const watch = api.createStreamWatch({ target: doc, document: doc });
  watch.start();
  assert.equal(watch.stats().started, true);
  watch.stop();
  assert.equal(holder.instances[0].disconnected, true);
  assert.equal(watch.stats().started, false);
});

test('start() without anything to observe throws instead of pretending to watch', async () => {
  const { api } = await loadWatch(documentWith([]));
  const watch = api.createStreamWatch({ target: null, document: documentWith([]) });
  assert.throws(() => watch.start(), /needs a DOM node to observe/);
});

test('an exception thrown by the caller is handed to onError, not swallowed', async () => {
  const doc = documentWith([]);
  const { api } = await loadWatch(doc);

  const errors = [];
  const watch = api.createStreamWatch({
    target: doc,
    document: doc,
    debounceMs: 10,
    quiescenceMs: 20,
    onPass: () => { throw new Error('scan blew up'); },
    onError: (error) => { errors.push(error.message); },
  });

  watch.start();
  await wait(40);
  watch.stop();

  assert.ok(errors.includes('scan blew up'), `errors were ${JSON.stringify(errors)}`);
});

test('the debounce and quiescence defaults are the ones the plan calls for', async () => {
  const { api } = await loadWatch(documentWith([]));
  assert.equal(api.DEBOUNCE_MS, 300);
  assert.equal(api.QUIESCENCE_MS, 700);
});
