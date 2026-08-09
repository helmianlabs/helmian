# Helmian desktop punch list

**Updated:** 2026-08-02 (polish pass)

## Done this pass

| Item | Proof |
|------|--------|
| Integrations modern form + OpenAI Images key enroll | Integrations page; `Save key` → Local Service DPAPI |
| Create → Generate → Preview (images) | Dragon wings artifact delivered live |
| Right dock splitters both ends | Sidebar↔main, main↔Guard/Create/Preview |
| Preview/Create internal splitters | List↔detail, compose↔history |
| Reply content policy (harm + unsourced confidence) | `ReplyContentPolicy.cs` → Guard cards; extension `harmful-content.mjs` |
| Multi-agent write+preview hard requirement | `MaestroMentions.BuildWorkerPrompt` REQUIRED write + `start_project_preview` |
| Voice S7/S8 | Pill beside composer; short Voice/Dictate tooltips |
| Browser / Canvas / Preview **Clear** | Toolbar Clear blanks WebView / canvas fields / preview detail |
| Guard full slide-off right | Drag or › → edge strip restore |
| Connector search dialog | + Connectors prompts for need when box empty |
| Esc mid-turn recovery | Esc cancels; Esc×2 clears all stuck busy; less Busy spam |

## Open (next)

| # | Item | Notes |
|---|------|--------|
| O1 | Mic device picker (voice M2) | Settings list + save preferred WaveIn id |
| O2 | Partial captions (voice M4) | “…” while utterance open |
| O3 | Flywheel live gate | Advisory catch on agent write / push — design in `advisory-loop.mjs`, not on `@all` path yet |
| O4 | Multi image providers | Only OpenAI Images enroll today |
| O5 | Video adapter | Not in build |
| O6 | Claude/Grok chat-only @all | Mitigated by REQUIRED write rule — re-test @all bounce |
| O7 | Room native chat | Local store + Discord WebView; not full Slack |
| O8 | Full smoke path fix | Suite crashes on wrong `C:\Users\troyh\desktop\...` path mid-run |

## Operator QA

1. Pack: latest `artifacts\Helmion-Pilot-win-x64-self-contained-team-*`
2. Integrations → Save OpenAI key → Create → Review → Generate
3. `@all` bounce ball — expect 4 files under `artifacts/agent-slices/<Agent>/`
4. Drag Create/Preview rails + main↔right dock
5. Voice / Dictate short tooltips; pill shows backend
