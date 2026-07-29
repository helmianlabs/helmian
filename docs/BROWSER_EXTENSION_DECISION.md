# DECISION: the browser AI protection layer is a BROWSER EXTENSION

Status: **DECIDED by Troy.** Not open. Not a menu. Recorded 2026-07-29.

## Why this file exists

Troy made this decision in a live session and it was lost. The word "extension"
appears three times in that transcript and **zero times** in the handoff written
afterward. The write-up genericized it into "automation layer" and "monitoring
layer," so the specific decision — build it as a browser extension — never
reached Claude Code.

This file exists so that cannot happen again. If a future document describes
this work without the word "extension" in it, that document is wrong.

## The decision

Two options existed.

| | Option | Verdict |
|---|---|---|
| 1 | Browser extension that reads the AI's reply off the page and verifies it locally | **CHOSEN** |
| 2 | Retire the browser; route every model through Helmion as a checked API call | Fallback only |

Troy chose option one knowingly, calling it "the hacky one." **Option two is the
fallback, not the recommendation.** Do not promote it to "the safer choice" in a
later write-up. That is exactly the drift that lost this decision once.

## What the extension does

Troy's words: it "reads the page as Gemini or Claude web types out its answer,
then pipes that text to a local verifier before you ever see it."

1. The extension runs on the tab — `claude.ai`, `chatgpt.com`,
   `gemini.google.com`.
2. It watches the reply **as it streams**, token by token into the DOM. Observing
   an in-progress response is a first-class design problem, not a detail.
3. It sends that text to a **local** verifier. Ollama with `qwen3.5:4b` is
   already installed and running; measured ~3.1s median, prompt-eval bound.
4. The verifier checks the output against the operator's source of truth —
   `MEMORY.md`, `CLAUDE.md`, `LESSONS.md`, and the memory folder.
5. Bad output is flagged or held **before the human reads or acts on it**.

## This is OUTPUT verification, not INPUT governance

Read this twice before briefing anyone.

Helmion's existing kernel (`src/core/governance.mjs`,
`src/core/governance-gate.mjs`) inspects an action an agent proposes, **before it
runs**. It is input-side.

This extension inspects text a model has **already produced**, on its way to the
human's eyes. It is output-side.

Same product, opposite direction. A brief that says only "governance" produces
the wrong build — that error was already made on 2026-07-29 and caught mid-flight.

Troy's framing: "the enforcement-layer version of the grounding fix — not just
feeding context in beforehand, but catching bad output on the way out too."

## The motivating incident

Gemini handed Troy destructive code that would have wiped a production backend.
He caught it by chance. The whole feature exists to remove the chance.

## Required: self-healing selectors

An extension reads the page's DOM. When Anthropic, OpenAI or Google redesign,
the selectors break silently and the protection goes dark without saying so.

Troy raised this himself and required the fix: maintenance code that
**self-updates when a site's interface changes** — a watcher that detects the
page structure changed and repairs itself rather than failing quietly. Silent
failure is the worst outcome for a safety tool, worse than a loud break.

This is a requirement, not an enhancement.

## Fastest phase 1

A reply containing a destructive shell command or destructive SQL needs no model
call. `src/core/governance.mjs` already carries destructive-command patterns.
Verify whether that kernel runs verbatim against text scraped from a page. Pure
pattern match, instant, no LLM. That is the smallest thing that visibly works.

## Open gates before public release

Being researched as of 2026-07-29, unresolved here — do not assume either way:

- Do Anthropic's, OpenAI's and Google's consumer terms permit an extension to
  read and modify their pages?
- Does the Chrome Web Store permit publishing it?

Reading page text is a lighter policy ask than modifying the page, so phase 1 may
be read-and-warn only. If public listing is barred, an unlisted personal
extension still works for Troy and Bryce.
