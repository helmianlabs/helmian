// Both lanes, running together, on one page.
//
// extension/test/guard-end-to-end.test.mjs does this for the destructive-command
// lane. This file is about what happens when the unsourced-claim lane is added
// beside it: that the quiet channel stays quiet, that it never borrows the red
// one, and that either lane can fail without the page lying about the other.
//
// What it does NOT prove: that the prose selectors match the live claude.ai,
// chatgpt.com and gemini.google.com DOM today, or that the note reads well on
// screen. Neither can be checked from here. Those need a browser.

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

const codeBlock = (code) => element('pre', {}, [element('code', {}, [code])]);
const paragraph = (sentence) => element('p', {}, [sentence]);

const HEDGED = 'The retry limit is probably set in config.json.';
const HEDGE_ONLY = 'I think we should go with the second approach.';
const SOURCED = 'The retry limit is set in config.json.';

const claimNotes = (doc) => doc.querySelectorAll('.helmion-guard-claims');
const panels = (doc) => doc.querySelectorAll('.helmion-guard-panel');
const banners = (doc) => doc.querySelectorAll('.helmion-guard-banner');
const advisoryBanners = (doc) => doc.querySelectorAll('.helmion-guard-advisory-banner');
const toasts = (doc) => doc.querySelectorAll('.helmion-guard-toast');
const lastBadgeText = () => fake.badgeCalls.filter((entry) => entry.call === 'setBadgeText').pop();

async function runExtension(children, options = {}) {
  fake.reset();

  const doc = createDocument(children);
  const observers = [];

  class FakeMutationObserver {
    constructor(callback) { this.callback = callback; observers.push(this); }

    observe() {}

    disconnect() {}

    fire(records) { this.callback(records); }
  }

  await loadContentScripts(CONTENT_SCRIPTS, {
    document: doc,
    chrome: options.chrome || chrome,
    MutationObserver: FakeMutationObserver,
    window: { addEventListener() {} },
    setInterval() { return 0; },
  });

  return { doc, observers };
}

function touch(doc, observers) {
  const tick = element('span', {}, ['tick']);
  doc.body.appendChild(tick);
  observers[0].fire([{ type: 'childList', target: doc.body, addedNodes: [tick], removedNodes: [] }]);
}

test('a hedged fact in the reply gets a note, and NOTHING is hidden', async () => {
  const hedged = paragraph(HEDGED);
  const { doc } = await runExtension([hedged]);
  await wait(60);

  assert.equal(claimNotes(doc).length, 1, 'no note was drawn beside an unsourced claim');
  const note = claimNotes(doc)[0];
  assert.match(note.textContent, /UNVERIFIED CLAIM/);
  assert.match(note.textContent, /stated without a source/);
  assert.match(note.textContent, /config\.json/, 'the note does not say what to go and check');
  assert.match(note.textContent, /not whether it is true/, 'the note overstates what was checked');

  // The whole point of the quiet channel.
  assert.equal(hedged.classList.contains('helmion-guard-masked'), false, 'a paragraph was masked');
  assert.ok(hedged.classList.contains('helmion-guard-claim-marked'), 'the paragraph was not marked at all');
  assert.equal(hedged.textContent, HEDGED, 'the paragraph text was altered');
});

test('the quiet channel never touches the red one', async () => {
  await runExtension([paragraph(HEDGED)]);
  await wait(60);

  const badge = lastBadgeText();
  assert.ok(badge, 'the badge was never set, so this proves nothing');
  assert.equal(badge.text, '', 'an unsourced claim lit the destructive-command badge');

  const colours = fake.badgeCalls.filter((entry) => entry.call === 'setBadgeBackgroundColor');
  assert.equal(colours.length, 0, 'the badge went coloured for an advisory finding');
});

test('a hedged paragraph draws no red warning and no toast', async () => {
  const { doc } = await runExtension([paragraph(HEDGED)]);
  await wait(60);

  assert.equal(panels(doc).length, 0);
  assert.equal(toasts(doc).length, 0);
  assert.equal(banners(doc).length, 0);
});

test('NEGATIVE CONTROL: a hedge with nothing checkable draws no note', async () => {
  // Without this the first test would pass on a lane that flags every
  // paragraph, which is the failure mode that gets a feature switched off.
  const { doc } = await runExtension([paragraph(HEDGE_ONLY)]);
  await wait(60);

  assert.equal(claimNotes(doc).length, 0, 'a bare opinion was flagged as an unsourced claim');
});

test('NEGATIVE CONTROL: a sourced statement with no hedge draws no note', async () => {
  const { doc } = await runExtension([paragraph(SOURCED)]);
  await wait(60);

  assert.equal(claimNotes(doc).length, 0, 'a plain statement of fact was flagged');
});

test('both lanes on one page: the code block is masked, the paragraph is not', async () => {
  const hedged = paragraph(HEDGED);
  const pre = codeBlock('cd /var/www\nrm -rf html/*');
  const { doc } = await runExtension([hedged, pre]);
  await wait(60);

  assert.equal(panels(doc).length, 1, 'the destructive command was not warned about');
  assert.ok(pre.classList.contains('helmion-guard-masked'), 'the code block was not hidden');

  assert.equal(claimNotes(doc).length, 1, 'the claim note was lost when a real warning fired');
  assert.equal(hedged.classList.contains('helmion-guard-masked'), false);

  assert.equal(lastBadgeText().text, '1', 'the badge counted something other than the one code block');
});

test('a hedge INSIDE a code block never produces a note', async () => {
  // The lane separation, end to end. A comment in a shell script is not the
  // model hedging at Troy, and the claim detector must never see it.
  const { doc } = await runExtension([
    paragraph('Here is the build script.'),
    codeBlock('# the retry limit is probably set in config.json\nnpm run build'),
  ]);
  await wait(60);

  assert.equal(claimNotes(doc).length, 0, 'a comment inside a code block was flagged as a claim');
  assert.equal(panels(doc).length, 0, 'a harmless build script was warned about');
});

test('the note comes down when the sentence it was about is rewritten', async () => {
  const hedged = paragraph(HEDGED);
  const { doc, observers } = await runExtension([hedged]);
  await wait(60);
  assert.equal(claimNotes(doc).length, 1);

  hedged.textContent = SOURCED;
  touch(doc, observers);
  await wait(400);

  assert.equal(claimNotes(doc).length, 0, 'the note outlived the claim it was about');
  assert.equal(hedged.classList.contains('helmion-guard-claim-marked'), false);
});

test('the extension does not flag its own note, or the note about the note', async () => {
  const { doc, observers } = await runExtension([paragraph(HEDGED)]);
  await wait(60);
  assert.equal(claimNotes(doc).length, 1);

  for (let i = 0; i < 3; i += 1) {
    touch(doc, observers);
    await wait(60);
  }
  await wait(400);

  assert.equal(claimNotes(doc).length, 1, 'the extension started reading its own output back');
});

test('an unchanged paragraph is not re-sent to the worker', async () => {
  const { doc, observers } = await runExtension([paragraph(SOURCED)]);
  await wait(60);

  const sent = [];
  const realSend = chrome.runtime.sendMessage;
  chrome.runtime.sendMessage = function counted(message, callback) {
    if (message && message.type === 'helmion:claims') sent.push(message.passages.length);
    return realSend.call(this, message, callback);
  };

  try {
    for (let i = 0; i < 3; i += 1) {
      touch(doc, observers);
      await wait(50);
    }
    await wait(400);
  } finally {
    chrome.runtime.sendMessage = realSend;
  }

  // Each `touch` appends a <span>, which is not prose the tier-1 selector
  // collects, so nothing new should ever be sent.
  assert.deepEqual(sent, [], `an unchanged paragraph was re-sent ${sent.length} times`);
});

test('FAIL LOUD, IN ITS OWN VOICE: the claim lane failing does not claim the guard stopped', async () => {
  // The two lanes fail independently and the page has to say which. A red
  // "HELMION GUARD IS NOT WATCHING THIS PAGE" banner here would be false: the
  // destructive-command lane is fine, and this test proves it is still working
  // in the same breath.
  const brokenClaims = {
    ...chrome,
    runtime: {
      ...chrome.runtime,
      sendMessage(message, callback) {
        if (message && message.type === 'helmion:claims') {
          setTimeout(() => {
            if (callback) callback({ ok: false, error: 'the claim lane was switched off by this test' });
          }, 0);
          return undefined;
        }
        return chrome.runtime.sendMessage(message, callback);
      },
    },
  };

  const pre = codeBlock('rm -rf /');
  const { doc } = await runExtension([paragraph(HEDGED), pre], { chrome: brokenClaims });
  await wait(120);

  assert.equal(advisoryBanners(doc).length, 1, 'the claim lane died silently');
  const banner = advisoryBanners(doc)[0];
  assert.match(banner.textContent, /NOT READING THIS PAGE FOR UNSOURCED CLAIMS/);
  assert.match(banner.textContent, /Destructive-command checking is unaffected/);

  assert.equal(banners(doc).length, 0, 'a dead reading aid claimed the guard had stopped watching');
  assert.equal(panels(doc).length, 1, 'the destructive-command lane went down with the claim lane');
  assert.ok(pre.classList.contains('helmion-guard-masked'));
  assert.equal(claimNotes(doc).length, 0);
});

test('POSITIVE CONTROL: a healthy claim lane draws no advisory banner', async () => {
  // The test above proves the banner appears when the lane is broken. This
  // proves it is not simply always there.
  const { doc } = await runExtension([paragraph(HEDGED)]);
  await wait(120);

  assert.equal(advisoryBanners(doc).length, 0, 'the advisory banner is drawn even when nothing is wrong');
  assert.equal(claimNotes(doc).length, 1, 'the lane that is supposedly healthy found nothing');
});

test('a site with no semantic markup falls back and says so, without stopping', async () => {
  const { doc } = await runExtension([
    element('div', {}, [element('div', {}, [HEDGED])]),
  ]);
  await wait(120);

  assert.equal(claimNotes(doc).length, 1, 'the fallback tier found nothing');
  assert.equal(advisoryBanners(doc).length, 1, 'a degraded prose anchor was not reported');
  assert.match(advisoryBanners(doc)[0].textContent, /paragraph anchor no longer matches/);
  assert.equal(banners(doc).length, 0, 'a degraded prose anchor was reported as the guard failing');
});
