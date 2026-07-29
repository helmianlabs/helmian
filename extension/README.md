# Helmion Guard — browser extension, phase 1

It watches the AI's reply as it types. It pulls the code blocks out of that
reply. It checks those code blocks against Helmion's 15 destructive-command
patterns. If one matches, it hides the block behind a red warning that names the
exact line.

It works on three sites: claude.ai, chatgpt.com, gemini.google.com.

No model. No network. No account. It is a regular expression running on your own
machine, and nothing leaves the browser.

---

## Install it

Do these in order. It takes about a minute.

1. Open Chrome.
2. In the address bar type `chrome://extensions` and press Enter.
3. Top right of that page, turn ON the switch that says **Developer mode**.
4. Three buttons appear top left. Click **Load unpacked**.
5. A folder picker opens. Choose this folder:
   `E:\Helmion\extension`
6. Click **Select Folder**.
7. A card appears saying **Helmion Guard 0.1.0**. That means it is installed.

Edge works too. Same steps, but the address is `edge://extensions`.

---

## See it fire

1. Open `https://claude.ai` in a new tab.
2. Ask it exactly this:

   > Show me, in a bash code block, the command to recursively force-delete the
   > folder /tmp/scratch. Just the code block, no explanation.

3. When the answer arrives, the code block is **gone**. In its place is a red
   panel that says **HELMION GUARD**, names the pattern it matched, and quotes
   the exact line.
4. A red box appears in the top right corner of the page as well.
5. The extension's icon in the toolbar gets a red **1** on it.
6. Click **Show the code anyway** if you want to see the block. It takes that
   second click on purpose.

Then do the same on `https://chatgpt.com` and `https://gemini.google.com`.

---

## See it stay quiet

This is the half that matters just as much. A warning that fires on ordinary
writing gets switched off within a week.

Ask any of the three sites this:

> Write me one sentence warning me never to run rm -rf on a production server.

Nothing should happen. No red panel, no toast, no badge. The sentence contains
the words `rm -rf`, but a sentence is not a command, and the extension does not
check sentences.

---

## Check it is actually running

Two ways.

**The toolbar.** Hover the extension's icon. It says "Helmion Guard is watching
this page."

**The console.** Press `F12` on one of the three sites, click the **Console**
tab, and look for this line:

```
[Helmion Guard] self-test passed — watching this page.
```

That line means more than it looks like. On every page load the extension pushes
two strings through its own detection chain: one it knows is destructive, one it
knows is harmless. It only prints that line if the first came back flagged and
the second came back clean. So the line is proof the checking works, not just
proof the code loaded.

---

## If something breaks, it says so

A safety tool that quietly stops working looks exactly like one that found
nothing wrong. This one is not allowed to go quiet.

If anything fails, a dark red bar appears across the top of the page:

**HELMION GUARD IS NOT WATCHING THIS PAGE**

with a plain sentence underneath saying what failed. The toolbar icon also shows
an orange `!`.

You get that bar when:

| What went wrong | What the bar says |
|---|---|
| The background worker stopped answering | the checks are not running |
| The self-test failed | the detection chain failed its own test |
| A site redesign moved the code blocks | the usual code-block anchor no longer matches |
| The page never changes, so it may not be watching | this page is full of content but the extension has not seen it change once |
| Anything else throws | the extension hit an unexpected error |

If you see that bar, the extension is not protecting you. Reload the tab first.
If it comes back, that is a real bug worth reporting.

---

## What it does NOT do

Read this bit. It is short and it matters.

| Limitation | Why |
|---|---|
| Only **fenced code blocks** are checked | Prose is never checked, on purpose. The kernel flags the sentence "never run rm -rf on a production server" if you feed it the whole reply, and that is a warning against the command, not the command. |
| **Inline backticks are not checked** | `rm -rf /` written in the middle of a sentence is somebody naming a command, not handing you one to copy. Same reasoning. |
| It cannot stop you | It hides the block and makes you click twice. It cannot follow the text to your terminal. It is a speed bump at the moment of danger, not a gate. |
| The site's own Copy button may still work | Hiding the block hides the code. Some sites put their Copy button in a header row just above the block, and that button is still there. The red panel is the protection; the hiding is friction. |
| A commented-out command still warns | `# rm -rf /` inside a code block fires. Left deliberately — inside a code block, erring toward a warning is cheap. |
| It checks **every** code block on the page | Including one you pasted yourself. It does not try to work out which message is the assistant's. That guess is the fragile part of every extension like this, and phase 1 does not need it — a dangerous command is worth flagging wherever it sits. |
| It only knows 15 patterns | Whatever `src/core/governance.mjs` carries. It does not reason. It does not know your systems. That is phase 3. |
| A line over a million characters is not checked | It says so on the page, in amber, naming the line. It is never reported as clean. The cap used to be 4,000 characters and the skip was silent — a command padded past 4,000 went unchecked and unmentioned. Measured cost at the new cap: under 4 ms. |
| Nobody has run it on the live sites yet | It is proven by tests, not by clicking. You are the first person to open it in a browser. |

---

## Where the patterns come from

There is one list of destructive-command patterns and it lives in
`E:\Helmion\src\core\governance.mjs`. The extension does not have its own copy
that somebody typed out by hand — two hand-maintained lists would drift apart,
and a safety tool whose two halves disagree is worse than one half on its own.

Instead `extension/tools/sync-kernel.mjs` copies that file, byte for byte, into
`extension/generated/helmion-governance.generated.js`. The extension imports the
copy. So the extension runs the identical code, not just the identical patterns.

If you change `governance.mjs`, run this:

```
node extension/tools/sync-kernel.mjs
```

If you forget, `npm test` goes red and tells you. That check is in
`extension/test/kernel-sync.test.mjs`, and it has a positive control that
corrupts the copy on purpose to prove the check really catches it.

---

## Turn off the hiding

Open `extension/content/guard.js` and change one word near the top:

```js
const MASK_DANGEROUS_BLOCKS = false;
```

Then reload the extension on `chrome://extensions`. The red panel, the corner
box and the badge all still work. The code block just stays visible.

This is not a read-only mode, and nothing here has one. Even with hiding off,
the extension writes its own bookkeeping attributes onto each code block and
inserts its warning, corner box and banner into the page.

---

## Files

| File | What it does |
|---|---|
| `manifest.json` | Tells Chrome what to load and where to run |
| `content/extract.js` | Pulls code blocks out of the reply. Prose never gets past here |
| `content/stream-watch.js` | Knows when the assistant is typing and when it stopped |
| `content/ui.js` | Draws the warning, the corner box and the broken banner |
| `content/guard.css` | Styles for all of the above, namespaced so the page cannot bend them |
| `content/guard.js` | Ties it together, and fails loud when anything breaks |
| `background/scan.js` | Runs the kernel, one line of one code block at a time |
| `background/worker.js` | The background service worker, the only place that can load modules |
| `generated/helmion-governance.generated.js` | The copied kernel. Do not edit |
| `tools/sync-kernel.mjs` | Makes that copy |
| `test/` | 90 tests. Run them with `npm test` from `E:\Helmion` |
| `test-support/` | A tiny fake DOM and a fake `chrome` API, so the tests run the real files |

---

## Run the tests

From `E:\Helmion`:

```
npm test
```

The extension's tests run as part of the repo's suite — 514 tests total, 90 of
them the extension's. The ones that matter most are in
`extension/test/reply-cases.test.mjs`, which holds the sentence that must stay
quiet and the commands that must be caught, and
`extension/test/guard-end-to-end.test.mjs`, which loads all four content scripts
against a page and checks what actually gets drawn.

`npm run check` does not cover the extension's files. It does not need to:
`extension/test/package.test.mjs` runs `node --check` over every one of them, so
a syntax error still turns `npm test` red.
