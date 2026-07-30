// The whole extension, running.
//
// Every other test file checks a piece. This one loads the four content scripts
// in the order manifest.json lists them, points them at a page, and routes their
// messages to the real service worker in background/worker.js. What gets drawn
// is what would be drawn in Chrome.
//
// What it does NOT prove: that the selectors match the live claude.ai,
// chatgpt.com and gemini.google.com DOM today, and that the warning looks right
// on screen. Neither can be checked from here. Those need a browser.

import test from 'node:test';
import assert from 'node:assert/strict';

import { loadContentScripts } from '../test-support/load-content-script.mjs';
import { element, createDocument } from '../test-support/mini-dom.mjs';
import { chrome, fake, installWorker } from '../test-support/fake-chrome.mjs';

await installWorker();

const CONTENT_SCRIPTS = [
  'content/extract.js',
  'content/stream-watch.js',
  'content/ui.js',
  'content/guard.js',
];

const wait = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

function codeBlock(code) {
  return element('pre', {}, [element('code', {}, [code])]);
}

// Loads the extension against a page. Returns everything a test needs to poke
// at it afterwards.
async function runExtension(children) {
  fake.reset();

  const doc = createDocument(children);
  const observers = [];
  const intervals = [];
  const windowListeners = new Map();

  class FakeMutationObserver {
    constructor(callback) {
      this.callback = callback;
      observers.push(this);
    }

    observe() {}

    disconnect() { this.disconnected = true; }

    fire(records) { this.callback(records); }
  }

  await loadContentScripts(CONTENT_SCRIPTS, {
    document: doc,
    chrome,
    MutationObserver: FakeMutationObserver,
    window: {
      addEventListener(type, handler) { windowListeners.set(type, handler); },
    },
    // The 60-second health check would keep the test process alive. Record the
    // call instead of scheduling it.
    setInterval(handler, ms) { intervals.push({ handler, ms }); return intervals.length; },
  });

  return { doc, observers, intervals, windowListeners };
}

const panels = (doc) => doc.querySelectorAll('.helmion-guard-panel');
const banners = (doc) => doc.querySelectorAll('.helmion-guard-banner');
const toasts = (doc) => doc.querySelectorAll('.helmion-guard-toast');

test('a dangerous code block on the page is warned about and hidden', async () => {
  const pre = codeBlock('cd /var/www\nrm -rf html/*\nnpm run build');
  const { doc } = await runExtension([element('div', {}, ['Clear the build output:']), pre]);

  await wait(60);

  assert.equal(panels(doc).length, 1, 'no warning was drawn');
  const panel = panels(doc)[0];
  assert.match(panel.textContent, /HELMION GUARD/);
  assert.match(panel.textContent, /destructive command/);
  assert.match(panel.textContent, /recursive\/forced rm/);
  assert.match(panel.textContent, /rm -rf html\/\*/, 'the warning does not quote the offending line');
  assert.match(panel.textContent, /line 2/, 'the warning does not name the line number');

  assert.ok(pre.classList.contains('helmion-guard-masked'), 'the code block was not hidden');
  assert.equal(toasts(doc).length, 1, 'no corner warning was drawn');
});

test('the warning is placed directly above the block it is about', async () => {
  const pre = codeBlock('rm -rf /');
  const { doc } = await runExtension([pre]);
  await wait(60);

  const siblings = doc.body.childNodes;
  const panelIndex = siblings.indexOf(panels(doc)[0]);
  const preIndex = siblings.indexOf(pre);
  assert.equal(panelIndex + 1, preIndex, 'the warning is not immediately above the code block');
});

test('the toolbar badge turns red and counts the flagged blocks', async () => {
  await runExtension([codeBlock('DROP TABLE loads;'), codeBlock('rm -rf /')]);
  await wait(60);

  const text = fake.badgeCalls.filter((entry) => entry.call === 'setBadgeText').pop();
  const colour = fake.badgeCalls.filter((entry) => entry.call === 'setBadgeBackgroundColor').pop();
  assert.equal(text.text, '2');
  assert.equal(text.tabId, 7);
  assert.equal(colour.color, '#b3261e');
});

test('a clean page draws nothing and clears the badge', async () => {
  const { doc } = await runExtension([
    element('p', {}, ['Never run rm -rf on a production server without a backup.']),
    element('p', {}, ['Use ', element('code', {}, ['rm -rf /']), ' with care.']),
    codeBlock('npm install\nnpm run dev'),
  ]);

  await wait(60);

  assert.equal(panels(doc).length, 0, 'a warning was drawn on a clean page');
  assert.equal(banners(doc).length, 0);
  assert.equal(toasts(doc).length, 0);

  const text = fake.badgeCalls.filter((entry) => entry.call === 'setBadgeText').pop();
  assert.equal(text.text, '');
});

test('"Show the code anyway" takes a second deliberate click', async () => {
  const pre = codeBlock('git push --force origin main');
  const { doc } = await runExtension([pre]);
  await wait(60);

  assert.ok(pre.classList.contains('helmion-guard-masked'));

  const button = doc.querySelectorAll('.helmion-guard-reveal')[0];
  assert.ok(button, 'there is no way to reveal the block');
  assert.equal(button.textContent, 'Show the code anyway');

  button.dispatch('click');

  assert.equal(pre.classList.contains('helmion-guard-masked'), false, 'the block stayed hidden');
  assert.equal(panels(doc).length, 1, 'the warning disappeared with the click; it must not');
  assert.match(panels(doc)[0].textContent, /The warning above still stands/);
});

test('a block that streams in AFTER load is caught', async () => {
  const { doc, observers } = await runExtension([element('p', {}, ['thinking...'])]);
  await wait(60);
  assert.equal(panels(doc).length, 0);

  const pre = codeBlock('DROP TABLE loads;');
  doc.body.appendChild(pre);
  observers[0].fire([{ type: 'childList', target: doc.body, addedNodes: [pre], removedNodes: [] }]);

  await wait(400);

  assert.equal(panels(doc).length, 1, 'a block that arrived while streaming was not checked');
  assert.match(panels(doc)[0].textContent, /direct SQL DDL/);
});

test('an unchanged block is not scanned twice', async () => {
  const { doc, observers } = await runExtension([codeBlock('npm install')]);
  await wait(60);

  const before = fake.listeners.length; // keeps the fake honest about being wired
  assert.ok(before > 0, 'the worker listener was never registered');

  const scans = [];
  const realSend = chrome.runtime.sendMessage;
  chrome.runtime.sendMessage = function counted(message, callback) {
    if (message && message.type === 'helmion:scan') scans.push(message.blocks.length);
    return realSend.call(this, message, callback);
  };

  try {
    for (let i = 0; i < 5; i += 1) {
      observers[0].fire([{
        type: 'childList',
        target: doc.body,
        addedNodes: [element('span', {}, ['tick'])],
        removedNodes: [],
      }]);
      await wait(50);
    }
    await wait(400);
  } finally {
    chrome.runtime.sendMessage = realSend;
  }

  assert.equal(scans.length, 0, `an unchanged block was rescanned ${scans.length} times`);
});

test('FAIL LOUD: a worker that never answers puts a banner on the page', async () => {
  const doc = createDocument([codeBlock('rm -rf /')]);
  fake.reset();
  fake.mode = 'silent';

  const observers = [];
  class FakeMutationObserver {
    constructor(callback) { this.callback = callback; observers.push(this); }

    observe() {}

    disconnect() {}
  }

  await loadContentScripts(CONTENT_SCRIPTS, {
    document: doc,
    chrome,
    MutationObserver: FakeMutationObserver,
    window: { addEventListener() {} },
    setInterval() { return 0; },
  });

  // guard.js gives the worker 5 seconds before it calls it broken.
  await wait(5400);
  fake.reset();

  assert.equal(banners(doc).length, 1, 'the extension went quiet instead of saying it was broken');
  const banner = banners(doc)[0];
  assert.match(banner.textContent, /HELMION GUARD IS NOT WATCHING THIS PAGE/);
  assert.match(banner.textContent, /did not answer/);
});

test('FAIL LOUD: a dead service worker puts a banner on the page', async () => {
  const doc = createDocument([codeBlock('rm -rf /')]);
  fake.reset();
  fake.mode = 'missing';

  await loadContentScripts(CONTENT_SCRIPTS, {
    document: doc,
    chrome,
    MutationObserver: class { constructor(cb) { this.callback = cb; } observe() {} disconnect() {} },
    window: { addEventListener() {} },
    setInterval() { return 0; },
  });

  await wait(120);
  fake.reset();

  assert.equal(banners(doc).length, 1);
  assert.match(banners(doc)[0].textContent, /unreachable|answered with nothing/);
});

test('FAIL LOUD: the badge shows an orange ! when the guard reports itself broken', async () => {
  fake.reset();

  await new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: 'helmion:badge', dangerous: 0, broken: true }, resolve);
  });

  const text = fake.badgeCalls.filter((entry) => entry.call === 'setBadgeText').pop();
  const colour = fake.badgeCalls.filter((entry) => entry.call === 'setBadgeBackgroundColor').pop();
  const title = fake.badgeCalls.filter((entry) => entry.call === 'setTitle').pop();

  assert.equal(text.text, '!');
  assert.equal(colour.color, '#c77700');
  assert.match(title.title, /NOT watching/);
});

test('the worker refuses a message it does not understand instead of ignoring it', async () => {
  fake.reset();
  const response = await new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: 'helmion:something-else' }, resolve);
  });
  assert.equal(response.ok, false);
  assert.match(response.error, /unknown message type/);
});

test('a worker exception comes back as an error, never as a clean result', async () => {
  // scanBlocks throws on anything that is not a list. If that ever came back as
  // ok:true the page would show no warning and nothing would be wrong-looking.
  fake.reset();
  const response = await new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: 'helmion:scan', blocks: 'rm -rf /' }, resolve);
  });
  assert.equal(response.ok, false);
  assert.match(response.error, /expects an array/);
});

test('the degraded-anchor banner appears when <pre> stops matching', async () => {
  // A site redesign that drops <pre> is the silent break this guards against.
  const fallback = element('div', { 'data-testid': 'code-block-1' }, [
    element('code', {}, ['rm -rf /']),
  ]);
  const { doc } = await runExtension([fallback]);
  await wait(60);

  assert.equal(banners(doc).length, 1, 'running on a fallback anchor was not reported');
  assert.match(banners(doc)[0].textContent, /no longer matches this site/);
  assert.equal(panels(doc).length, 1, 'the fallback anchor stopped the check working');
});

test('the degraded-anchor banner CLEARS when <pre> starts matching again', async () => {
  // The banner used to be drawn without recording that anything was wrong, and
  // recover() returns early unless state says so — so once drawn it stayed on
  // the page for the life of the tab, long after the site was answering on the
  // primary anchor again.
  const fallback = element('div', { 'data-testid': 'code-block-1' }, [
    element('code', {}, ['npm install']),
  ]);
  const { doc, observers } = await runExtension([fallback]);
  await wait(60);
  assert.equal(banners(doc).length, 1, 'the fallback anchor was not reported at all');

  // The site starts serving <pre> again.
  doc.body.removeChild(fallback);
  const pre = codeBlock('npm install');
  doc.body.appendChild(pre);
  observers[0].fire([{ type: 'childList', target: doc.body, addedNodes: [pre], removedNodes: [] }]);
  await wait(400);

  assert.equal(banners(doc).length, 0, 'the degraded banner never came down');
});

test('a degraded anchor marks the toolbar, not just the page', async () => {
  fake.reset();
  await runExtension([
    element('div', { 'data-testid': 'code-block-1' }, [element('code', {}, ['npm install'])]),
  ]);
  await wait(60);

  const text = fake.badgeCalls.filter((entry) => entry.call === 'setBadgeText').pop();
  assert.equal(text.text, '!', 'a degraded anchor left the toolbar looking healthy');
});

test('A FLAGGED BLOCK THAT LEAVES THE PAGE STOPS BEING COUNTED', async () => {
  // dangerousIds only ever had entries deleted for blocks in the current pass,
  // so a flagged block removed by a conversation switch stayed counted forever:
  // the red badge could climb but never come down, and the toast could never
  // clear because that path needs the count to reach zero.
  const pre = codeBlock('rm -rf /');
  const { doc, observers } = await runExtension([pre]);
  await wait(60);

  assert.equal(toasts(doc).length, 1, 'the flagged block was never counted in the first place');
  let text = fake.badgeCalls.filter((entry) => entry.call === 'setBadgeText').pop();
  assert.equal(text.text, '1');

  doc.body.removeChild(pre);
  observers[0].fire([{ type: 'childList', target: doc.body, addedNodes: [], removedNodes: [pre] }]);
  await wait(400);

  text = fake.badgeCalls.filter((entry) => entry.call === 'setBadgeText').pop();
  assert.equal(text.text, '', `the badge still reads "${text.text}" for a block that is gone`);
  assert.equal(toasts(doc).length, 0, 'the corner warning outlived the block it was about');
});

test('AN EDIT THAT KEEPS THE SAME LENGTH IS STILL RESCANNED', async () => {
  // Change detection compared text LENGTH. Two different commands of equal
  // length looked identical to it, so the second was never checked.
  const inner = element('code', {}, ['npm install']);
  const pre = element('pre', {}, [inner]);
  const { doc, observers } = await runExtension([pre]);
  await wait(60);
  assert.equal(panels(doc).length, 0, 'a clean block was flagged');

  // Same character count, entirely different command.
  const replacement = 'rm -rf /tmp';
  assert.equal(replacement.length, 'npm install'.length, 'the test itself is not length-neutral');
  inner.textContent = replacement;
  observers[0].fire([{ type: 'characterData', target: inner }]);
  await wait(400);

  assert.equal(panels(doc).length, 1, 'a same-length edit was never rescanned');
  assert.match(panels(doc)[0].textContent, /rm -rf \/tmp/);
});

test('A LINE TOO LONG TO CHECK IS SAID OUT LOUD, NOT PASSED OFF AS CLEAN', async () => {
  const monster = 'a'.repeat(1000001);
  const { doc } = await runExtension([codeBlock(`echo hello\n${monster}`)]);
  await wait(200);

  const notices = doc.querySelectorAll('.helmion-guard-unchecked');
  assert.equal(notices.length, 1, 'a line nobody checked was reported as if it had been');
  assert.match(notices[0].textContent, /did not check line 2/);
  assert.equal(panels(doc).length, 0, 'a skipped line must not be reported as a match either');
});

test('A BLOCK THAT IS BOTH DANGEROUS AND PART-UNCHECKED SAYS BOTH THINGS', async () => {
  // Found 2026-07-29 while verifying the 2935ab2 repairs. The skipped-line fix
  // was real but only half-wired: content/guard.js drew the amber "did not
  // check line N" notice and THEN called warnBlock, whose first act is
  // clearWarning, whose last act is clearUnchecked. The notice was created and
  // destroyed inside the same pass.
  //
  // It only showed up on a block that trips both paths at once — which is the
  // worst case, not an edge case. A red panel implies the block was examined,
  // and here part of it was not.
  const monster = 'a'.repeat(1000001);
  const { doc } = await runExtension([codeBlock(`rm -rf /\n${monster}`)]);
  await wait(200);

  assert.equal(panels(doc).length, 1, 'the destructive line was not warned about');
  const notices = doc.querySelectorAll('.helmion-guard-unchecked');
  assert.equal(
    notices.length,
    1,
    'the red warning swallowed the notice that part of this block was never checked',
  );
  assert.match(notices[0].textContent, /did not check line 2/);
});

test('THE STOP BUTTON IS ACTUALLY WIRED: the end of streaming forces a re-check', async () => {
  // Both callbacks received { streaming } and both discarded it, so the signal
  // stream-watch.js calls "primary" was computed on every tick and never acted
  // on. It now forces one full pass at the streaming -> finished transition,
  // because that is the moment the reply is final.
  const stop = element('button', { 'aria-label': 'Stop generating' }, ['Stop']);
  const pre = codeBlock('npm install');
  const { doc, observers } = await runExtension([stop, pre]);
  await wait(400);

  const scans = [];
  const realSend = chrome.runtime.sendMessage;
  chrome.runtime.sendMessage = function counted(message, callback) {
    if (message && message.type === 'helmion:scan') scans.push(message.blocks.length);
    return realSend.call(this, message, callback);
  };

  try {
    // The model finishes: the stop button goes away. Content is UNCHANGED, so
    // the fingerprint cache would skip it — only the streaming signal can force
    // this pass.
    doc.body.removeChild(stop);
    observers[0].fire([{
      type: 'childList', target: doc.body, addedNodes: [], removedNodes: [stop],
    }]);
    await wait(400);
  } finally {
    chrome.runtime.sendMessage = realSend;
  }

  assert.ok(scans.length > 0, 'the reply finishing triggered no final check at all');
});

test('the health check is scheduled once a minute', async () => {
  const { intervals } = await runExtension([]);
  await wait(60);
  assert.equal(intervals.length, 1);
  assert.equal(intervals[0].ms, 60000);
});

test('the page error handler is registered so extension errors surface', async () => {
  const { windowListeners } = await runExtension([]);
  await wait(60);
  assert.ok(windowListeners.has('error'));
  assert.ok(windowListeners.has('unhandledrejection'));
});
