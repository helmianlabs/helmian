# Mark as a remote control for Helmion

**Voice in, visual out, over the relay, with the conversation never closing.**

Troy is in a truck. He says what he wants, Helmion does it, and Mark reads back
what happened. No desktop. That is the whole product.

Written 2026-07-31, the night Layer 1 landed.

---

## Where this actually stands

| Layer | What it is | State |
|---|---|---|
| 1 | Voice → phone → relay → Helmion executes | **BUILT**, unverified end to end |
| 2 | Helmion → relay → phone, spoken back | **HALF BUILT** — see below |
| 3 | Live Helmion UI rendered in Mark's widget | **SPEC ONLY** |

Layer 2 is the one worth being precise about, because "half built" is exactly the
kind of thing that gets rounded up to "done" and then fails in front of someone.

**What already returns:** every turn's answer. `src/relay/hands.mjs` calls `say()`
after each turn, which posts Helmion's reply to the phone. Troy asks for a file,
gets told it was made.

**What does not return yet:** anything Troy did not ask for. A guard block, an
escalating warning, an agent finishing work he started ten minutes ago. Those all
happen on the desktop and die there. That is the gap this spec closes.

---

## Layer 2 — the return path

### The rule that makes it usable

**Push what he would want interrupted for. Nothing else.**

A channel that reports everything is a channel he stops listening to — the same
failure as the yellow pill that was always on, and the 128 manager alerts nobody
read. The bar is: would he want a voice in his ear about this while driving?

| Event | Pushed? | Why |
|---|---|---|
| A guard BLOCK | **yes** | Something was stopped. He needs to know now. |
| A warning escalating to critical | **yes** | It is about to matter. |
| A task he asked for finishing | **yes** | He is waiting on it. |
| A task finishing that he did not ask for | **yes** | Agents work while he drives. |
| A steady OK card | no | Nothing happened. |
| A heartbeat | no | "Still fine" every 30s is how a channel becomes noise. |

### Asked-for status

Troy: *"What warnings are up?"*

That is a question with a real answer, and it must come from **measured state**,
never from a model's recollection:

- the block ledger on disk (`.helmion/audit/blocks-*.jsonl`)
- the write lease (`.helmion/lease.json`) and whether its holder is alive
- which agents are running

If a source cannot be read, the answer says so. "I cannot tell you" is a valid
answer and "everything looks fine" is not, when nothing was checked. That rule is
the whole reason the fake green ledger card was found and killed tonight.

### Shape on the wire

The relay carries text, so events go as one readable line — Mark speaks it
straight out with no parsing:

```
GUARD BLOCKED a recursive delete in E:\Helmion. Nothing was removed.
DONE  hello.txt created in mark-hands-test.
LEASE An old lock was left behind. Nothing is holding it. Nothing is wrong.
```

Prefix first so Mark can decide tone. Plain English after it, because it is going
to be **spoken**, not read. No file paths in the middle of a sentence, no JSON key
names, no "not recorded" — every one of those was a real complaint tonight.

---

## Layer 3 — the live dashboard

Structured state, on a heartbeat, rendered as a small Helmion dashboard inside
Mark's widget. Not a screenshot — data the widget draws.

### What gets sent

```json
{
  "kind": "helmion.state",
  "at": "2026-07-31T06:00:00Z",
  "cards": [
    { "subject": "Claude 2", "title": "cannot run a turn",
      "level": "critical", "action": "retry" }
  ],
  "agents": [
    { "name": "kill-the-fakes", "state": "working", "for": "8m" }
  ],
  "lease": { "held": true, "by": "Claude 2" }
}
```

`subject` is first on purpose. The first question about a red card is **whose it
is** — that was fixed in the desktop panel tonight for exactly this reason, and
the phone must not regress it.

### Four things that will go wrong if they are not designed in

**1. It cannot ride this relay.** Every heartbeat is a row in Postgres and a poll
from a phone on cellular. Three seconds forever is a bill and a flat battery.
Send on CHANGE, with a floor of about 10 seconds, and a keepalive no more than
once a minute.

**2. The relay must stay text-only for the conversation.** Adding a second frame
kind is the thing `src/relay/protocol.mjs` warns about. State goes on its own
channel — `pilot-state` — so a malformed dashboard payload can never be mistaken
for something Troy said.

**3. The desktop UI is not the source.** Scraping the WPF panel means the phone
breaks every time the app is restyled. Both should read the same Core state.

**4. Stale must look stale.** If the last heartbeat is two minutes old, the
widget greys out and says when it last heard. A dashboard confidently showing old
data is worse than a blank one — the exact defect that got found in the guard
cards tonight, which said "probed just now" about a reading taken hours earlier.

---

## Security, stated once and plainly

Layer 1 already changed the risk. A lane reachable from the open internet can now
cause work on this machine. What holds:

- **one folder**, named on the command line, and the agent's tool layer confines
  paths to it
- **the ordinary guard**, untouched — every tool call still passes the same gate
  that refused a real `rm -rf` on 2026-07-30
- **off by default** — plain `helmion relay` only prints
- **it says what it did** — silent work triggered by a text message is the
  failure worth fearing

Layer 3 adds one more: **the dashboard leaks state.** Whoever can read that
channel learns what Troy is working on and what is failing. Sending it to the
same shared secret as the conversation is the easy answer and the wrong one.

---

## Order of work

1. **Layer 2 push** — guard blocks and completions to the phone. Small.
2. **Layer 2 status** — answer "what warnings are up" from measured state.
3. **Verify Layer 1** — Troy speaks, `hello.txt` appears. Not proven yet.
4. **Layer 3** — its own session. Widget work, not relay work.

Layers 1 and 2 together are the product. Layer 3 is the demo.
