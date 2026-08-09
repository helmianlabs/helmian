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

## Phase gate — Helmion Guard-wrapped AI exception analysis

This phase comes **after the first-party, paired, read-only Helmion Remote** and
**before any remotely initiated write action**. It does not turn the current
phone bridge into an action lane.

Normal dispatch and tender flow stays **rules- and optimizer-first**. An LLM may
only analyze an exception and return structured, advisory evidence and options.
It may never autonomously accept a tender, assign a person or vehicle, choose or
change a route, send a message, invoke a filesystem/tool action, or write to
production.

Helmion Guard enforces the boundary outside the model:

- tenant scope and data minimization/redaction
- trusted-source and source-timestamp requirements
- structured-schema validation, then hard-rule and staleness checks
- explicit action and human-approval gates
- strict production-versus-simulation separation
- an immutable audit trail of the minimized inputs, sources and timestamps,
  policy result, advisory output, explanation, and any human decision

No model output may automate employment, discipline, compensation, or
termination decisions. Safety or driver signals must be presented for human
review and support with traceable evidence and explanation; they must never be
reduced to an opaque score. **Helmion Executive Guard** is the approval, audit,
and explanation view for this phase.

**Dependencies before implementation:** a provider-neutral exception-analysis
interface, plus versioned evaluation fixtures covering normal, exceptional,
stale, redacted, adversarial, and cross-tenant cases. Provider-specific types or
credentials must not cross the interface.

**Acceptance criteria:**

1. Normal dispatch/tender fixtures complete without an LLM call.
2. Advisory output cannot reach an action, tool, message, filesystem, or
   production-write path; an explicit approved decision is required outside the
   model.
3. Guard rejects wrong-tenant, untrusted, untimestamped, stale, malformed,
   hard-rule-breaking, and replayed results before they reach Executive Guard.
4. Simulation output cannot be applied to production, and the immutable audit
   record reconstructs the evidence, policy checks, explanation, and reviewer
   decision.
5. Employment and safety fixtures prove that prohibited automated decisions and
   opaque driver scoring fail closed.
6. The same evaluation suite passes against provider-neutral stubs without
   changing Guard policy or downstream schemas.

---

## Enterprise AI governance and audit-readiness track

This is an engineering evidence roadmap, not legal advice, a compliance claim,
or a claim that Helmion is certified. **SOC 2 is a future assurance objective,
not a current certification.** Use the NIST AI Risk Management Framework as the
initial organizing model, and consider ISO/IEC 42001 only when the product,
customer scope, and operating system are mature enough to justify it.

The phone/mobile roadmap must produce and maintain:

- a capability inventory that separates released, pilot, simulated, and
  unavailable desktop/mobile/remote behavior
- a use-case risk assessment, plus a tenant-scoped data map with minimization,
  redaction, retention, deletion, and provider-transfer rules
- controlled model, provider, prompt, policy, and schema changes with owner,
  version, evaluation result, approval, rollout, and rollback evidence
- versioned evaluation fixtures and access/security tests, including pairing,
  expiry, replay, revocation, wrong-device, wrong-tenant, and prohibited-action
  cases
- immutable Guard decision, approval, incident, and recovery evidence, plus
  explicit customer/pilot acceptance and exception records

The prohibited-use boundary remains absolute: no automated employment,
discipline, compensation, or termination decisions, and no opaque driver
scoring. Any consequential-decision use case requires legal review of both the
use case and the product/customer state footprint **before** it is enabled.

Evidence gates:

1. **Pre-pilot:** approve the capability/risk inventory, data and retention map,
   provider-neutral contract, change controls, evaluation baseline, access and
   security tests, incident procedure, prohibited-use tests, and any required
   legal review. No unresolved critical result enters a pilot.
2. **Pilot:** bind participants, tenants, devices, capabilities, models, and
   providers to the approved scope; preserve immutable decisions/incidents;
   rerun evaluations on every material change; and record customer/pilot
   acceptance, rejection, exception, and remediation.
3. **Post-pilot:** reconcile promised versus observed capability, incidents,
   access, retention/deletion, model/provider changes, evaluation regressions,
   and acceptance records. Close material gaps before expansion and obtain an
   independent readiness assessment before making any assurance claim.

The enterprise build and evidence ownership are tracked in
[MULTI_USER_RELEASE_ROADMAP.md](MULTI_USER_RELEASE_ROADMAP.md).

---

## Order of work

1. **Layer 2 push** — guard blocks and completions to the phone. Small.
2. **Layer 2 status** — answer "what warnings are up" from measured state.
3. **Verify Layer 1** — Troy speaks, `hello.txt` appears. Not proven yet.
4. **Layer 3** — its own session. Widget work, not relay work.

Layers 1 and 2 together are the product. Layer 3 is the demo.
