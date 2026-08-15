# Helmion Guard — browser extension, phase 1

It watches the AI's reply as it types, and it reads that reply twice.

It also checks the chat composer at send time. An explicit request to erase an
entire computer, drive or data set is stopped before the site can submit it and
gets a bounded corner warning with a **Return to editing** action.

**The code blocks** are checked against Helmion's 15 destructive-command
patterns. If one matches, the block is hidden behind a red warning that names the
exact line. That is the safety half.

**The prose** is checked for facts stated without a source — a hedge welded to
something checkable, like "the setting is probably under Preferences > Advanced"
or "it's called flushSync() I think". Those get a quiet note beside them saying
what to go and verify. Nothing is hidden and nothing is blocked. That is the
reading half.

The two never see each other's input, and that is the whole reason neither one
cries wolf. Feed prose to the command patterns and "never run rm -rf on a
production server" comes back as a destructive command. Feed a code block to the
claim detector and every comment in it looks like an unsourced fact.

It works on four sites: claude.ai, chatgpt.com, gemini.google.com and grok.com.

No model. No network. No account. It is regular expressions running on your own
machine, and nothing leaves the browser.

The Phase 1/2 permission matrix, local-first redaction boundary, and zero-data-
retention behavior are documented in
[`docs/HELMION_GUARD_PHASE_1_PRIVACY.md`](../docs/HELMION_GUARD_PHASE_1_PRIVACY.md).

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
7. A card appears saying **Helmion Guard**. That means Chrome knows the unpacked
   folder. After any source update, click the card's reload button and reload
   every already-open AI chat tab so its content scripts are replaced.

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

To test the prompt lane, type this into a chat composer and press Send:

> Permanently erase all computer files.

The send event should be cancelled. A small warning says **Helmion Guard blocked
this request**, the text stays in the composer for editing, and the site receives
nothing. A defensive question such as "How can I prevent someone from erasing
all computer files?" is allowed.

---

## See the quiet half fire

Ask any of the three sites this:

> In one sentence and no code block, tell me where React's flushSync is exported
> from, but hedge it — say you think that is where it is.

When the answer arrives the sentence is still there, still readable, still
copyable. Above it sits a small slate-blue note:

**UNVERIFIED CLAIM — A fact here is stated without a source.**

underneath it, what to go and check, and then the line that matters:

> Helmion checked whether this was sourced, not whether it is true.

The paragraph gets a dotted underline. Nothing is hidden, no red panel appears,
no corner box appears, and the toolbar badge does not move. That separation is
deliberate: red means somebody handed you a command that destroys something, and
an unsourced sentence is not that.

It takes **two** signals and never fires on one. "I'm not sure, let me check" is
honest uncertainty and is left alone. "That design is probably cleaner" is an
opinion about `config.json` and is left alone. It is the pairing — a hedge and
something you could go and look up — that gets the note.

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
[Helmion Guard] claim self-test passed — reading this page for unsourced claims.
```

Those lines mean more than they look like. On every page load, and again every
60 seconds, the extension pushes known strings through its own detection chains
and checks the answers.

The first line needs two: a string it knows is destructive must come back
flagged, and a string it knows is harmless must come back clean.

The second needs three, because that lane fires on two signals and either one
going missing has to silence it. A hedge welded to a file path must be flagged;
a hedge with nothing checkable must not be; and a plain sourced statement must
not be. Two probes could not tell "still working" apart from "now flagging
everything".

So the lines are proof the checking works, not just proof the code loaded. You
get one line per lane because the two lanes can fail separately.

---

## If something breaks, it says so without covering the page

A safety tool that quietly stops working looks exactly like one that found
nothing wrong. This one is not allowed to go quiet.

If destructive-command protection actually fails, a small dark-red alert appears
in a corner. It says only that Guard needs attention and that checks may be
incomplete. A **Details** button shows the next step; parser, worker, selector and
fallback diagnostics remain in the developer console. The alert has a strict
width and height limit and never stretches across the page.

The toolbar icon shows an orange `!` for that actionable failure. Reload the tab
first. If the warning returns, open the toolbar popup for the plain-language
status and do not rely on Guard on that page until it is fixed.

When checking still works through a compatibility path, the page stays clear and
the toolbar uses only a small dot. Claim-checking health also stays off the page.
Open the Helmion Guard toolbar popup to see both lanes' current status.

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

### And what the claim half does not do

| Limitation | Why |
|---|---|
| It says **unsourced**, never **wrong** | It cannot tell a true hedged claim from a false one. It reports that a fact arrived without evidence. Checking whether the fact is *right* needs a real documentation or filesystem lookup, which is phase 2 — every finding already carries the extracted referent so that lookup runs against one claim instead of a whole reply. |
| **Inline code is not read** | "It's called `flushSync()` I think" is not flagged, because the symbol lives inside the backticks. `src/core/unverified-claims.mjs` strips inline spans before it looks at anything, and the extension does the same so the browser and the CLI never disagree about the same sentence. |
| Talking **about** hedging is flagged | A sentence like "never write 'probably' next to a file path" carries both signals and gets a note. Cheap to ignore, expensive to fix properly, and the failure direction is the safe one. |
| Quoting somebody else is flagged | "He said it's probably in config.json" reads the same as asserting it. |
| **English only** | The confidence markers are an English list. |
| It reads **your** messages too | It does not try to work out which paragraph is the assistant's — that guess is the fragile part of every extension like this. So a hedge you typed yourself gets a note as well. |
| There is **no badge, no toast, no count** | On purpose. The badge is reserved for destructive commands. An advisory finding that lit the same indicator would teach you to discount it, and then the red one goes with it. |

---

## Where the patterns come from

Two files under `src/core/` do the actual thinking, and the extension has a copy
of each — never one somebody typed out by hand. Two hand-maintained lists drift
apart, and a safety tool whose halves disagree is worse than one half alone.

| The one source of truth | The copy the extension imports |
|---|---|
| `src/core/governance.mjs` — the 15 destructive-command patterns | `extension/generated/helmion-governance.generated.js` |
| `src/core/unverified-claims.mjs` — confidence markers and checkable referents | `extension/generated/helmion-unverified-claims.generated.js` |

`extension/tools/sync-kernel.mjs` writes both, byte for byte. The extension runs
the identical code, not just the identical patterns, so a sentence gets the same
verdict in Chrome as it does in the CLI and the desktop pilot.

If you change either original, run this:

```
node extension/tools/sync-kernel.mjs
```

If you forget, `npm test` goes red and tells you which copy is stale. Those
checks are in `extension/test/kernel-sync.test.mjs`, and each has a positive
control that corrupts a throwaway copy on purpose to prove the check really
catches it.

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
inserts its warning and bounded corner alert into the page.

---

## Files

| File | What it does |
|---|---|
| `manifest.json` | Tells Chrome what to load and where to run |
| `content/prompt-risk.js` | Detects explicit whole-device or whole-data deletion requests in the composer before send |
| `content/extract.js` | Splits the reply in two: code blocks for one lane, prose for the other. Neither ever gets the other's text |
| `content/stream-watch.js` | Knows when the assistant is typing and when it stopped |
| `content/ui.js` | Draws the red warning, bounded corner alerts, and the quiet claim note that never hides anything |
| `content/guard.css` | Styles for all of the above, namespaced so the page cannot bend them |
| `content/guard.js` | Runs both lanes, keeps their state apart, and reports health without exposing internal diagnostics on the page |
| `background/scan.js` | Runs the destructive-command kernel, one line of one code block at a time |
| `background/claims.js` | Runs the claim detector over one passage of prose at a time. Cannot block; the literal `false` is tested |
| `background/worker.js` | The background service worker, the only place that can load modules |
| `generated/helmion-governance.generated.js` | The copied kernel. Do not edit |
| `generated/helmion-unverified-claims.generated.js` | The copied claim detector. Do not edit |
| `tools/sync-kernel.mjs` | Makes both copies |
| `test/` | 134 tests. Run them with `npm test` from `E:\Helmion` |
| `test-support/` | A tiny fake DOM and a fake `chrome` API, so the tests run the real files |

---

## Run the tests

From `E:\Helmion`:

```
npm test
```

The extension's tests run as part of the repo's suite — 687 tests total, 134 of
them the extension's. The ones that matter most are in
`extension/test/reply-cases.test.mjs`, which holds the sentence that must stay
quiet and the commands that must be caught;
`extension/test/guard-end-to-end.test.mjs`, which loads all four content scripts
against a page and checks what actually gets drawn; and
`extension/test/claims-end-to-end.test.mjs`, which does the same for the quiet
lane and pins the thing it must never do — mask, count, or borrow the red
channel.

`npm run check` does not cover the extension's files. It does not need to:
`extension/test/package.test.mjs` runs `node --check` over every one of them, so
a syntax error still turns `npm test` red.
