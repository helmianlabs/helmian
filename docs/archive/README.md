# Archive

Dated session notes, handoffs, and superseded audits. These are kept for
provenance — several are cited by comments in the source — but they are **not**
product documentation and they are not maintained.

Current documentation lives one directory up, in [`docs/`](../).

## What is in here

| Kind | Files |
|---|---|
| Session handoffs | `HANDOFF_2026-07-28_*`, `HANDOFF_2026-07-29_*`, `HANDOFF_2026-07-30_*` |
| Point-in-time audits | `APP_INVENTORY_*`, `COMPLETENESS_AUDIT_*`, `FLYWHEEL_AUDIT_*`, `GEMINI_DOC_VERIFICATION_*` |
| Fix and incident write-ups | `SECURITY_FIX_REPORT.md`, `ROUND_18_RESOLUTION.md`, `ENV_INHERITANCE_FIX.md`, `ZERO_TOOLS_REGRESSION_FIX.md` |
| Research and one-off spikes | `GROK_VOICE_RESEARCH_*`, `MOSHI_INSTALL_ATTEMPT_*`, `VOICE_PHASE1_WIRING_TODO.md` |
| Superseded `.bak` copies | `*.bak` — kept only because they were already committed; git holds these versions anyway |

## Reading these

Treat every claim in here as a snapshot of what one session believed on one day,
not as current fact. Where an archived document and the code disagree, the code
wins. Several of these files describe defects that have since been fixed, and at
least two quote credential-shaped strings while explaining how redaction works —
they are historical records of an incident, not configuration to copy.
