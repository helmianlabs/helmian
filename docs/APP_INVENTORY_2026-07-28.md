# APP INVENTORY — every app/product on this machine

**Built 2026-07-28 by `f3673e34/agent-R-app-inventory`. READ-ONLY sweep — no code changed, nothing deleted, no `.env` contents read (presence only).**

## How status was determined (no guesses)

Every status cell comes from one or more of these, and the evidence column says which:

| Evidence type | Command / method |
|---|---|
| Last commit + branch | `git -C <path> log -1 --format=%cI` and `rev-parse --abbrev-ref HEAD` |
| Real vs copy | `git -C <path> rev-parse --git-dir` (a linked worktree points into another repo's `.git/worktrees/…`) and `git worktree list` from the parent |
| Unmerged work | `git -C <parent> rev-list --count <branch> --not <canonical-HEAD>` |
| Deployed | `curl -s -o /dev/null -w "%{http_code}" -L <url>` run 2026-07-28 ~23:00 MDT |
| Deploy target | `.vercel/project.json`, `vercel.json`, `fly.toml` `app =`, `app.json`/`eas.json` slug |
| Disk size | `robocopy /L` byte totals (list-only, copies nothing) |

Status vocabulary: **LIVE** = deployed and answering · **WORKING** = runs locally, not deployed · **IN PROGRESS** = active commits, not finished · **STALLED** = no commits in 30+ days · **ARCHIVE/DEAD** = superseded or non-functional.

Today is 2026-07-28, so the 30-day stall line falls at 2026-06-28.

---

## 1. THE MAIN PRODUCTS

| App | Absolute folder path | What it is (one line) | Live URL(s) | Status |
|---|---|---|---|---|
| **DairyForge** | `C:\Users\troyh\dairyforge-monorepo` | The real dairy-hauling TMS: dispatch, PMO wash compliance, EDI 204, GPS/geofence engine — Troy's flagship product | **https://dairyforge.com** → HTTP **200** · API `dairyforge-api.fly.dev` (answers 404 at `/`, so the app resolves; no root route) | **LIVE** — last commit `113f08b` 2026-07-26 18:27, branch `fix/edi204-x12-conformance-2026-07-26`, 12 ahead of origin/main, 10 dirty files |
| **AimForge** | `C:\Users\troyh\aimforge` *(work here)* · `C:\Users\troyh\aimforge-main` *(what's shipped)* | A hard fork of DairyForge rebuilt as a general-freight console (load board, factoring, dispatch) for the trucking prospects | **https://aimforge-console.vercel.app** → HTTP **200** · API `aimforge-api.fly.dev` (404 at `/`, app resolves) | **LIVE** — `aimforge` `58047fc` 2026-07-26 14:03 on the EDI branch; `aimforge-main` `ec559f3` 2026-07-26 17:47 == origin/main exactly |
| **Caldmere** (the game) | `E:\UnityProjects\Caldmere_v2` | Unity 6000.4.10f1 fantasy MMO — 10 playable races, chargen, terrain world, sigil/siege systems | Codex **https://caldmere-codex.vercel.app** → **200** · Account portal **https://caldmere-login.vercel.app** → **200** | **IN PROGRESS** — `b1528c3d` 2026-07-26; newest file write on E: is *today* 7/28 21:57. Owns the `.git` that 15 worktrees point into |
| **Faith & Thread** (Faith & Light) | `C:\Users\troyh\Desktop\Faith-and-Light\code-zips` | Christian apparel / print-on-demand storefront — React+Vite + Express + Postgres + Stripe, fulfilling through Printful | **https://faithnlight.shop** → HTTP **200** · Vercel project `faith-thread-live` | **LIVE site, STALLED code** — last commit `ea3ae44` **2026-06-10** (48 days), fixing a real Printful v1/v2 order mismatch |
| **Helmion** | `E:\Helmion` | Local governance kernel for coding agents — npm `@helmion/agent-control` v0.1.0, 5 CLI bins, 4 MCP servers, plus a WPF desktop Pilot app | No web deploy. Ships as npm bin + `desktop/scripts/publish.ps1` | **IN PROGRESS** — 4 commits total, newest `fda4883` **today** 2026-07-28 19:49. This is tonight's work |
| **SiteVector** | `C:\Users\troyh\sitevector` | Python engine that infers unmapped truck stop-locations from Samsara telematics (tells a weighbridge from a red light) | None — `sitevector.spec` builds a PyInstaller EXE. `SHIPPING.md`: a desktop EXE is structurally ineligible for the Samsara Marketplace | **IN PROGRESS** — `fe0df00` 2026-07-26 |
| **Gauge / Cora** (driver app) | `C:\Users\troyh\gauge-sandbox` | Expo/React-Native driver app: wake-word ("Hey DairyForge"), Hume voice analysis, pre/post-trip, scanner | Expo slug `gauge-sandbox` · ⚠ `app.json` name still says **DairyForge** · bundle `com.dairyforge.gauge` | **IN PROGRESS** — `6345f8e` 2026-07-25 on `feat/event-driven-gauge-mic`, **44 dirty files**. ⚠ Your memory says this was **handed to another person** for wake-word work — coordinate before touching |
| **ThinkBuddy** | `C:\Users\troyh\n8n_Pod_Uploader_jarvis` | Next.js app (repo `package.json` is still named `faith-and-thread`; the `jarvis/` folder holds the actual ThinkBuddy app) | Vercel project `thinkbuddy` → **https://thinkbuddy.vercel.app** → **200** | **LIVE** — `4e462d0` 2026-07-20 |

---

## 2. MOBILE APPS

| App | Absolute folder path | What it is | Deploy identity | Status |
|---|---|---|---|---|
| AimForge Driver | `C:\Users\troyh\aimforge-mobile` | Expo driver app for AimForge; itself a fork of gauge-sandbox | slug `aimforge-mobile`, bundle `com.aimforge.driver`, all 4 EAS profiles → `aimforge-api.fly.dev` | **IN PROGRESS** — `c3b957e` 2026-07-25, == origin/main |
| DairyForge Driver | `C:\Users\troyh\dairyforge-mobile` | Expo driver app for DairyForge | slug `dairyforge`, bundle `com.dairyforge.app`, EAS → `dairyforge-api.fly.dev` | **STALLED (29 days)** — `689b445` 2026-06-29, clean tree. One day short of the 30-day line; treat as cold |
| Forge Driver | `C:\Users\troyh\forge-mobile` | Expo driver app for the abandoned "Forge" freight rebrand | slug `forge-mobile`, bundle `com.forgefreight.driver` → `forgefleet-api.fly.dev` (**host does not resolve**) | **ARCHIVE/DEAD** — `8a3815f` 2026-07-11 |
| Caldmere Launcher | `C:\Users\troyh\caldmere-launcher` | C#/WPF Windows launcher: Supabase sign-in, patch self-update, launches `Caldmere.exe --token <jwt>`. Has xUnit tests | Distributed via `{siteUrl}/patch/manifest.json` | **WORKING** — builds + tests present. ⚠ No git commit date obtained (root has no `.git` the sweep could read) |
| DairyForge mobile preview | `C:\Users\troyh\dairyforge-mobile-preview` | GitHub-Pages build artifact of an old mobile preview | — | **ARCHIVE/DEAD** — `a5111e0` 2026-05-07 (82 days) |

---

## 3. CUSTOMER-FACING SALES ARTIFACTS (DFA / Dairy Farmers of America)

| App | Absolute folder path | What it is | Live URL | Status |
|---|---|---|---|---|
| DFA Saadi demo | `C:\Users\troyh\dfa-saadi-demo` | Next.js 14 + Leaflet wash-compliance sales demo. README: *"All operational data is SYNTHETIC"* | **https://dfa-saadi-demo.vercel.app** → **200** (also the long deploy URL in `DEPLOY_URL.txt`) | **LIVE** — not a git repo; a hand-built sales artifact |
| DFA first-use pilot kit | `C:\Users\troyh\dfa-pilot-configurable` | USB flash-drive kit: DairyForge's 96-hour PMO freshness logic packaged to run standalone, **zero npm dependencies**, Node 18+ built-ins only | Hand-delivered on USB | **WORKING** — real customer deliverable; explicitly never touches the DairyForge app or DB |
| DFA orphan-trailer pilot | `C:\Users\troyh\dfa-orphan-trailer-configurable` | Second USB kit: catches orphaned trailers / dwell and fires a check-call nudge | Hand-delivered on USB | **WORKING** — same standalone design |
| DFA data archive | `C:\Users\troyh\_DFA_DATA_ARCHIVE_PRESERVED` | `realSchedule_ORIGINAL_20260605.csv` + a synthetic-schedule generator | — | **ARCHIVE** — preserved real customer data. Not opened |
| DFA identity vault | `C:\Users\troyh\_DFA_IDENTITY_VAULT_OFFLINE` | `identity_vault_20260606.json` | — | **ARCHIVE** — name implies real identity data. Not opened |

---

## 4. SMALLER LIVE APPS AND SERVICES

| App | Absolute folder path | What it is | Live URL | Status |
|---|---|---|---|---|
| Claude Memory API | `C:\Users\troyh\claude-memory-api` | REST API giving Claude.ai read/write access to your conversation memory in Neon | **https://claude-memory-api.vercel.app** → **200** | **LIVE** |
| Claude Memory MCP | `C:\Users\troyh\claude-memory-mcp` | Remote MCP server (OAuth 2.1 + DCR) exposing `search_memory` over the same Neon history | **https://claude-memory-mcp-troy.fly.dev** → **200** (pinned to 1 machine — in-memory OAuth state) | **LIVE** |
| First Principles assessment | `C:\Users\troyh\firstprinciples-assessment` | Next.js assessment app with its own DB and a node test runner | **https://firstprinciples-assessment.vercel.app** → **200** | **LIVE** — `02f62a0` 2026-07-20 |
| HVAC Tech Calc | `C:\Users\troyh\hvac-tech-calc` | Static PWA field calculator for HVAC techs (service worker, manifest, icons), no build step | **https://hvac-tech-calc.vercel.app** → **200** | **LIVE** — no git date available |
| Faith & Thread n8n | `C:\Users\troyh\faith-thread-n8n-deploy` | Self-hosted n8n running the POD order pipeline (folder holds only `fly.toml`) | **https://faith-thread-n8n.fly.dev** → **200** | **LIVE** |
| POD image resizer | `C:\Users\troyh\n8n_Pod_Uploader` | Flask "Faith & Thread POD Image Resizer" so n8n can POST `/resize` instead of running Python locally | Fly app `faith-thread-resizer` — 404 at `/` | **STALLED** — `1552b7e` 2026-05-25 (64 days) |
| IQ / Cognitive Aptitude app | `C:\Users\troyh\iq-app` | Next.js quiz app, "how sharp are you today?" | Vercel project `iq-app`. ⚠ `iq-app.vercel.app` **redirects to `iq.hdang09.tech`, a stranger's site** — that alias is not yours | **WORKING** — deployed URL unknown; check the Vercel dashboard |
| DairyForge Telegram bot | `C:\Users\troyh\dairyforge-telegram-bot` | Telegram bot bridging your phone to Claude (`/ask`), whitelist-gated | Fly app `dairyforge-telegram-bot` (long-polling worker, no HTTP) | **STALLED** — `705c6cb` 2026-05-11 (78 days) |
| Heartbeat Voice | `C:\Users\troyh\heartbeat-voice` | Node WebSocket server wrapping the Anthropic streaming API with AbortController for instant interruptible voice chat | Local only (`npm start`) | **WORKING** — keys present, not read |
| PC Auto Drive Organizer | `D:\pc-auto-drive-organizer` | Electron desktop app that watches any drive and files things into tidy folders. *"Moves, never deletes"* | Local; `electron-builder --win` | **WORKING** — has `engine.test.js` |

---

## 5. TOOLING, HARNESSES AND RESEARCH

| App | Absolute folder path | What it is | Status |
|---|---|---|---|
| Grok MCP shim | `C:\Users\troyh\claude-code-grok-mcp` | Third-party MCP server (`wynandw87/claude-code-grok-mcp`) giving Claude Code a Grok tool | **WORKING** — `7cbdf0e` 2026-04-30 |
| Gemini / OpenAI MCP shims | `C:\Users\troyh\claude-code-gemini-mcp`, `…-openai-mcp` | One `server.py` each — the MCP servers behind `mcp__Gemini__*` and `mcp__OpenAI__*` | **WORKING** — no git |
| EDI synthetic gates | `C:\Users\troyh\edi-synthetic` | Node scripts building synthetic EDI 204 + GPS chains and running 5 numbered gates against the AimForge parser | **IN PROGRESS** — `7c5561d` 2026-07-25; findings logged, not fixed |
| openWakeWord fork | `C:\Users\troyh\dev\openwakeword-dairyforge` | Clone/fork of openWakeWord for training "Hey DairyForge" | **WORKING** |
| Wake-word replay harness | `C:\Users\troyh\wakeword-offline-test` | Replays a recording through the same 3 tflite models the mobile app loads | **WORKING** |
| DairyForge AWS infra | `C:\Users\troyh\dairyforge-aws-infra` | Terraform (`main.tf`, modules, `EXECUTION_CHECKLIST.md`) for an AWS footprint | **ARCHIVE** — superseded by Fly + Vercel + Neon |
| GPS engine handoff pack | `C:\Users\troyh\dairyforge_gps_engine_handoff` | 7-folder redacted extract of the GPS engine prepared for an outside party | **ARCHIVE** |
| Image generator | `C:\Users\troyh\image_generator` | One Python script: generate images, upload to a fixed Google Drive folder | **WORKING** |
| Portable Postgres | `C:\Users\troyh\pgportable`, `C:\Users\troyh\pgdata-integ` | A portable PG binary + an integration-test data dir (port 5433) | **WORKING** — test infrastructure, not an app |
| Android platform-tools | `C:\Users\troyh\platform-tools-install` | adb/fastboot unzip for Expo device work | **WORKING** — tooling |
| Global learnings log | `C:\Users\troyh\planning\LEARNINGS.md` | Not an app — the cross-project validated-mistakes log | n/a |

---

## 6. DEAD / SUPERSEDED LINEAGE — the freight-fork graveyard

You have attempted the "de-dairy DairyForge into general freight" idea **four times**. Only the newest one is alive.

| Attempt | Path | Date range | Status |
|---|---|---|---|
| 1. fleet-fwd (PWA) | `C:\Users\troyh\fleet-fwd-pwa` | frozen **2026-06-06** | **ARCHIVE/DEAD** — no Vercel, no Fly, no Expo. Its own README says phases A/B/D landed, UI is spec-only |
| 2. fleet-fwd (ELD) | `C:\Users\troyh\fleet-fwd-eld` | frozen **2026-06-06** | **ARCHIVE/DEAD** — README says it supersedes fleet-fwd-pwa. Keep `STATUS.md` for the FMCSA HOS/ELD research; the code is dead |
| 3. Forge / FleetForge | `C:\Users\troyh\forge-monorepo` + `forge-api` + `forge-mobile` | 2026-07-10 → 07-11 | **ARCHIVE/DEAD** — `forgefleet-dash.vercel.app` still returns **200**, but its backend `forgefleet-api.fly.dev` **does not resolve** (curl 000). A live dashboard with no API. Split brain: `forge-monorepo` points at `forgefleet-api` while `forge-api` deploys as `forge-api-app` — two Fly apps, one product |
| 4. **AimForge** | `C:\Users\troyh\aimforge` | active through 2026-07-26 | **LIVE** — the survivor |

Also dead: `C:\Users\troyh\forge-fleet-ops-recovered` — **not a git repo**, 4 files, a `server.mjs` salvage stub with no history.

---

## 7. DUPLICATES AND WORKTREES — which path is REAL

**Four parent repos own 44 linked worktrees between them.** A worktree is not a copy you can delete freely — its branch lives in the parent's `.git`, but its working files are real and often carry unmerged work.

| Product | THE REAL PATH | Proof it's the parent | Copies / worktrees |
|---|---|---|---|
| DairyForge | `C:\Users\troyh\dairyforge-monorepo` | `rev-parse --git-dir` → `.git`; `worktree list` returns **24 entries** (itself + 23); `worktree prune --dry-run` clean | 23 registered worktrees: 14 `df-wt-*`, plus `_wt_page2`, `dairyforge-csv204-replay`, `-geofences-list`, `-monorepo-seed-realistic`, `-override-history`, `-spreadsheet`, `-tender`, `df-deploy-main`, `df-deploy-route` |
| AimForge | `C:\Users\troyh\aimforge` | git-dir → `.git`; holds the only `.vercel/repo.json` (project `aimforge-console`) | ⚠ **`aimforge-main` is a WORKTREE of `aimforge`, not the parent — the name lies.** Also `aimforge-purge` (fully merged) |
| Gauge | `C:\Users\troyh\gauge-sandbox` | git-dir → `.git`; `worktree list` = **9 entries** | `gauge-autozoom`, `gauge-sandbox-{deploy,f9-combined,v15,voiceall-audit,wt-b13-posttrip-voice,wt-b14-smell-test}`, + a stray worktree living inside a Claude scratchpad |
| Caldmere | `E:\UnityProjects\Caldmere_v2` | git-dir → `.git`; **16 worktrees** registered; every sibling's `git-common-dir` points into its `.git` | 15 `Caldmere_v2_*` worktrees on E:, plus `D:\_caldmere_asset_qa_worktree_20260727` |
| AimForge mobile | `C:\Users\troyh\aimforge-mobile` | own `.git` | `aimforge-mobile-purge` (worktree, fully merged) |

### Three traps worth knowing

1. **`aimforge.git` is a hard fork of `dairyforge.git`** — they share root commit `8337c4b` (2026-04-18). That is *why* the two trees have byte-identical filenames and why conflating them is so easy. Always confirm the remote before acting.
2. **`C:\Users\troyh\_work\dairyforge` is a WHOLE SEPARATE pnpm copy of the DairyForge monorepo** (`artifacts/api-server`, `artifacts/dairyforge`, `lib/db`). It is not the canonical tree. Do not work there.
3. **`D:\gs` is a copy of gauge-sandbox** — its `package.json` name is literally `gauge-sandbox`. It also holds the Cora/Kora voice specs (`CORA_HANDSFREE_SPEC.md`, `KORA_VOICE_FLOW_MAP.md`). Read the specs there; do the code in `C:\Users\troyh\gauge-sandbox`.
4. **`C:\Users\troyh\df-wt-dashboard` is Vercel-linked** to project `dairyforge-unified-dash`. A `vercel --prod` from that folder would deploy a **June-16 feature branch** to a real Vercel project.

### 🔴 76 commits of unmerged work live in worktrees — do not mass-delete

Measured with `git rev-list --count <branch> --not <canonical HEAD>`:

| Path | Branch | Commits nowhere else |
|---|---|---|
| `df-wt-unified-integration` | `integration/unified-six-2026-07-07` | **15** |
| `df-wt-harvest` | `feat/harvest-unified-six-2026-07-14` | **13** (proven *disjoint* from unified-integration) |
| `gauge-sandbox-f9-combined` | `feat/ios-audio-mode-dedupe-2026-05-27` | **9** |
| `dairyforge-tender` | `fix/tender-api-rewrite-to-fly-2026-05-27` | **6** |
| `gauge-autozoom` | `feat/apk-scanner-photos-2026-05-28` | **6** |
| `gauge-sandbox-deploy` | `fix/audio-p0-diagnostic-2026-05-26` | **5** |
| `df-wt-dashboard` | `feat/unified-dashboard-intel-design-2026-06-16` | **4** |
| `aimforge` | `fix/edi204-x12-conformance-2026-07-26` | **4** (active work) |
| `gauge-sandbox-v15` | `feat/hume-v15-pump-tools-…` | **3** |
| `df-wt-testfix` | `fix/api-server-test-suite-green-2026-07-08` | 2 |
| 9 more `df-wt-*` + `gauge-sandbox-voiceall-audit` | various | 1 each |

**Total: 48 DairyForge + 24 Gauge + 4 AimForge = 76 commits that exist in no other tree.**

Caveat that matters: every ahead/behind number is against *local* remote-tracking refs and no network fetch was performed. `dairyforge.git origin/main` was last fetched at `61a74f0` 2026-07-23. **Run `git fetch` before acting on any of this** — a branch shown as unmerged may have landed upstream since.

Cleanly merged (0 commits unique) and safe to `git worktree remove`: `_wt_page2`, `dairyforge-csv204-replay`, `-geofences-list`, `-monorepo-seed-realistic`, `-override-history`, `-spreadsheet`, `df-deploy-main`, `df-deploy-route`, `df-wt-autovector`, `df-wt-dwell`, `gauge-sandbox-wt-b13-posttrip-voice`, `gauge-sandbox-wt-b14-smell-test`, `aimforge-purge`, `aimforge-mobile-purge`. Use `git worktree remove`, **never `rm -rf`**, so the registry stays consistent.

---

## 8. DISK USAGE

**Free space right now: C: 22.7 GB free (215.1 used) · D: 736.5 GB free (195.0 used) · E: 79.0 GB free (852.5 used).**

E: is the emergency, not C:.

| Path | Approx GB | Note |
|---|---|---|
| `E:\UnityProjects` (whole) | **821.89** | The single biggest thing on the machine |
| `E:\UnityProjects\_wt` | **194.90** | Only 1 of its 5 subdirs is a registered worktree; untouched since 7/19 |
| `E:\UnityProjects\Caldmere_v2` | 134.66 | **The live game — keep** |
| `E:\UnityProjects\Caldmere` | 104.08 | v1, different remote, dead |
| `E:\UnityProjects\Caldmere_v2_chargendiag` | 62.87 | **No git at all** |
| `E:\UnityProjects\Caldmere_v2_SELFTEST` | 60.54 | **No git at all** |
| `E:\UnityProjects\Caldmere_v2_terrain` | 39.29 | Worktree, 7/16 |
| `E:\UnityProjects\Caldmere_v2_integration` | 37.02 | Worktree; files stale since 7/15 |
| `E:\UnityProjects\Caldmere_v2_relay-build` | 25.30 | Worktree |
| `E:\UnityProjects\Caldmere-MCP` | 23.92 | No git, untouched since 6/16 |
| `E:\UnityProjects\fuck claude code` | 22.66 | 2 commits ever; purchased asset packs |
| `E:\UnityProjects\Caldmere_v2_sigilorbit-build` | 14.84 | Worktree |
| `E:\UnityProjects\Caldmere_v2_recovery` | 14.55 | Worktree |
| `E:\UnityProjects\Caldmere_v2_sigils` | 14.35 | Worktree |
| `E:\UnityProjects\Caldmere_v2_sigils_SELFTEST` | 13.69 | **No git at all** |
| `E:\UnityProjects\Caldmere_v2_QA_Codex` | 12.68 | **No git at all** |
| `E:\UnityProjects\Caldmere_v2_siege-build` | 8.70 | Worktree |
| `Caldmere_v2_{wiring,summon,content,groups}` | 7.72 each (30.9) | Worktrees, all 7/14 |
| `E:\Helmion` | 7.76 | Tonight's active work |
| `C:\Users\troyh\gauge-sandbox` | **12.37** | Largest single item in your home dir |
| `C:\Users\troyh\df-wt-*` (25 folders) | **10.97 total** | ~half your remaining C: headroom |
| `C:\Users\troyh\aimforge-*purge` (2) | **4.03 total** | Both fully merged |
| `C:\Users\troyh\aimforge` | 3.86 | |
| `C:\Users\troyh\forge-monorepo` | 3.81 | Dead product |
| `C:\Users\troyh\dairyforge-monorepo` | 3.73 | |
| `C:\Users\troyh\aimforge-main` | 3.56 | |
| `D:\_3D-Assets` | 2.87 | |
| `C:\Users\troyh\sitevector` | 0.18 | |
| `C:\Users\troyh\n8n_Pod_Uploader_jarvis` | 0.14 | |
| `D:\Caldmere` | 0.04 | 188 files — design docs only |
| `D:\_Docs` | 0.003 | 57 files — session handoffs |
| `D:\DairyForge` | 0.0001 | 7 files — effectively empty |
| `C:\Users\troyh\gauge-sandbox-*` siblings (6) | 0.06 total | Negligible — not worth touching |

---

## 9. RECLAIM CANDIDATES — **SUGGESTION ONLY. Nothing was deleted.**

Ranked by GB per unit of risk. Verify each yourself before removing anything.

| Rank | Path | GB | Why it looks abandoned | Risk |
|---|---|---|---|---|
| 1 | `E:\UnityProjects\_wt` minus `sigil-orbit-land` | ~**180** | 4 of 5 subdirs are non-git audit/selftest copies (`*_SELFTEST`, `visualaudit-caldmere*`); untouched since 7/19 | Low — but confirm `sigil-orbit-land` survives; it IS a registered worktree |
| 2 | `Caldmere_v2_chargendiag` + `_SELFTEST` + `_sigils_SELFTEST` + `_QA_Codex` | **149.8** | **No `.git` at all**, not in `worktree list` — throwaway snapshots by construction | Low — but nothing in them is recoverable from git, so glance first |
| 3 | `E:\UnityProjects\Caldmere` (v1) | **104** | Different remote, your memory calls it dead since 6/20 | Low — real clone with a real remote, so code is safe on GitHub; only Library/asset cache is at risk |
| 4 | Stale Caldmere worktrees 7/14–7/16 (`terrain`, `integration`, `wiring`, `summon`, `content`, `groups`, `recovery`) | ~**112** | Registered but cold for 12+ days | Medium — use `git worktree remove`, never `rm`; branches survive in `Caldmere_v2/.git` |
| 5 | `E:\UnityProjects\Caldmere-MCP` | **23.9** | No git, untouched since 6/16 | Low |
| 6 | `E:\UnityProjects\fuck claude code` | **22.7** | 2 commits, no README, last touched 7/17; assets are purchased packs (re-downloadable) | Low |
| 7 | 13 gutted `df-wt-*` shells | part of the 10.97 | **`fatal: not a git repository`** — `artifacts/`, `lib/` and the `.git` pointer are already gone. No git identity → no recoverable work: `df-wt-{anon2,anon3,calloff-type,docs,fixpass,fuel,load500,poolfix,staging,verify-base,verify-fix}`, `dairyforge-theme-fix`, `_wt_plantid_push` | Very low — plain delete is correct here; they are not worktrees |
| 8 | `aimforge-purge` + `aimforge-mobile-purge` | **4.03** | Both fully merged (0 unique commits); "purge" in both names | Low — `git worktree remove` |
| 9 | `C:\Users\troyh\ansel` | 0 | **Completely empty — 0 files** | None |
| 10 | `C:\Users\troyh\source\repos` | 0 | Visual Studio default folder, completely empty | None |

Doing #1, #2 and #7 alone would return roughly **330 GB on E: and several GB on C:** without touching a single git-tracked commit.

---

## 10. WHERE TO GO FOR WHAT

| I want to… | Open this path |
|---|---|
| Work on the **dairy product** (dairyforge.com) | `C:\Users\troyh\dairyforge-monorepo` — ⚠ HANDS-OFF on the live site; read-only unless you mean it |
| Work on the **freight console** (AimForge) | `C:\Users\troyh\aimforge` to write code · `C:\Users\troyh\aimforge-main` to see what's shipped |
| Work on the **game** | `E:\UnityProjects\Caldmere_v2` (Unity 6000.4.10f1). Design docs live in `D:\Caldmere` |
| Work on the **voice / driver stack** | `C:\Users\troyh\gauge-sandbox` — ⚠ another person owns this right now. Specs in `D:\gs\CORA_*.md` |
| Work on the **agent control app** (tonight) | `E:\Helmion` — board at `E:\Helmion\SESSION_BOARD.md`, docs in `E:\Helmion\docs\` |
| Work on the **Christian apparel store** | `C:\Users\troyh\Desktop\Faith-and-Light\code-zips` (live at faithnlight.shop) · pipeline in `C:\Users\troyh\faith-thread-n8n-deploy` |
| Work on **stop/site detection** | `C:\Users\troyh\sitevector` |
| Work on a **driver mobile app** | AimForge → `C:\Users\troyh\aimforge-mobile` · DairyForge → `C:\Users\troyh\dairyforge-mobile` (cold, 29 days) |
| Prep a **DFA customer demo** | Web demo → `C:\Users\troyh\dfa-saadi-demo` · USB kits → `dfa-pilot-configurable`, `dfa-orphan-trailer-configurable` |
| Find a **handoff or brain dump** | `D:\_Docs` (57 files) · Caldmere handoffs also `D:\_Handoffs` |
| Free up **disk space** | Start at `E:\UnityProjects\_wt` (194.9 GB) — see section 9 |

---

## Honest gaps in this inventory

- **I could not determine which Vercel project serves `dairyforge.com` from disk.** `dairyforge-monorepo` has no `.vercel` directory; the only on-disk reference is `MIGRATION_PLAN.md:153`. It is almost certainly deployed by Vercel's GitHub integration on `troy83352/dairyforge.git`, which leaves no local artifact. Confirm in the Vercel dashboard.
- **Fly `404` is weak evidence.** `dairyforge-api.fly.dev` and `aimforge-api.fly.dev` returned 404 at `/`, which proves the hostname routes to a running app — it does **not** prove the API is healthy. A real health check needs an actual API path.
- **`caldmere-launcher` and `hvac-tech-calc` have no commit date** in this sweep; their status is from file contents only.
- **Eight Caldmere branches all committed on 2026-07-26 with the message "Capture uncommitted work on this branch."** That is one automated sweep, not eight days of work. Do not read those dates as development activity.
- **No `git fetch` was run.** All ahead/behind and unmerged counts are against local refs.
- **No `.env` file was opened.** Presence confirmed in: Helmion, heartbeat-voice, claude-memory-api, iq-app, firstprinciples-assessment, caldmere-login, aimforge, gauge-sandbox, dairyforge-mobile, fleet-fwd-pwa. Values never read.

---

## FOUND LATER

**Appended 2026-07-28 by `f3673e34/agent-V-find-missing-apps`. READ-ONLY sweep — nothing above this line was altered. No `.env` or secret file was opened.**

Troy said the sweep above missed several apps. It did. This section is the second pass.

### The one he was asking about: Site Diary — voice → Haiku → a Google spreadsheet

| Fact | Evidence |
|---|---|
| Where it lives | `C:\Users\troyh\n8n_Pod_Uploader_jarvis\jarvis\api\diary.js` (server) + `jarvis\public\diary.html` and `jarvis\diary.html` (the mic page, title `Site Diary`) |
| Voice in | `diary.html:165` `navigator.mediaDevices.getUserMedia({audio:true})` → `MediaRecorder` → base64 POST to `/api/diary` |
| Transcription | `diary.js:79` OpenAI Whisper (`whisper-1`), English |
| The organizer | `diary.js:123` **`model: 'claude-haiku-4-5-20251001'`** — a system prompt at `diary.js:100-113` turns the raw dictation into strict JSON: date, time, location, category, summary, detail, `action_items[]`, priority |
| Where it lands | `diary.js:148-171` POSTs a flat row to a Google **Apps Script webhook** in `SHEETS_DIARY_WEBHOOK` |
| Deploy wiring | `jarvis\vercel.json` gives `api/diary.js` a 60 s maxDuration; `jarvis\.vercel\project.json` → Vercel project **`thinkbuddy`** |
| History | `api/diary.js` committed `86ddabd` 2026-07-01; `public/diary.html` last touched `8b3d24f` 2026-07-20 |

🔴 **Two honest corrections to how it was described.**

1. **It writes to Google _Sheets_, not Google Docs.** `diary.js:148` builds an 8-cell `row` and posts it to a Sheets Apps Script webhook. There is no Docs call anywhere in the file. (The Docs behaviour he may be thinking of is a *different* app of his — Claude AI Memory Vault, below, which really does create Google Docs.)
2. **Its prompt is written for a construction job site,** not a personal diary — `diary.js:101` says *"a voice note dictated on a job site"* and the categories are Safety / Progress / Subcontractor / Material / Weather / Issue / Inspection / General.

🔴 **Live status UNVERIFIED, not assumed.** `https://thinkbuddy.vercel.app/` returns **401** right now (Vercel deployment protection), and `/diary.html` returned 404 through that same protection. The code is complete and committed and the route is configured; I could not prove the page is reachable in production, and I am not claiming it is.

### The other voice → Google **Docs** app (this one really is Docs)

| App | Absolute path | What it is | Status |
|---|---|---|---|
| **Claude AI Memory Vault** | `C:\Users\troyh\OneDrive\Desktop\claude-ai-memory-vault` | A packaged, sellable kit: 3 MCP tools — `search_memory`, `save_to_memory`, **`push_to_docs`** (creates a real Google Doc in his own Drive via his own Apps Script, `google-docs/PushToDocs.gs`). Because MCP connectors do not load inside claude.ai voice mode, it also answers plain GET URLs `/m/<secret>/{search,save,docs}` (`vercel.json:7-9`) so a voice session can still reach it hands-free while driving. Has an OAuth Pro extra that deploys to Fly, and `GUMROAD_LISTING.md` with a suggested $49 price | **PRODUCT / KIT** — this is the source kit behind the already-listed live `claude-memory-api` and `claude-memory-mcp` |

### The drive organizer — question 1 answered: yes, and there are **two**

| App | Absolute path | What it is | Status |
|---|---|---|---|
| **PC Auto Drive Organizer** | `D:\pc-auto-drive-organizer` | **CONFIRMED as the one.** `package.json` → `productName: "PC Auto Drive Organizer"`, `author: "Troy Halter"`, *"Automatically watches and organizes files on any drive (HDD, USB, SD) into tidy folders. Moves, never deletes."* Electron + Vite + chokidar, has `engine/engine.test.js`, ships via `electron-builder --win`, has a `dist\` and a `release\`. Shortcut on his OneDrive Desktop: `PC Auto Drive Organizer.lnk` | **WORKING** — no newer or different organizer app exists |
| **D: drive auto-organizer (script)** | `D:\_organizer` | A *separate, earlier* one — `organize-d.ps1`, a PowerShell FileSystemWatcher for `D:\` with `-DryRun` / `-Once` / `-IncludeExisting` modes, plus `install-organizer-task.ps1` to run it as a Scheduled Task. Same safety promise: *"It NEVER deletes anything."* Has `baseline.txt` + `organize-log.txt`, so it has actually run | **WORKING** — script, not an app |

### Apps and products with no row in the inventory above

| App | Absolute path | What it is (one line) | Status |
|---|---|---|---|
| **AimForge landing page** | `C:\Users\troyh\OneDrive\Desktop\aimforge-web` | Single static marketing page for the Forge/AimForge brand, no backend, no build step. Its own `CLAUDE.md` warns the copy is aspirational — Cora voice, EDI, ELD, ROI numbers are marketing, not shipped features | **LIVE** — `https://aimforge-gray.vercel.app` → **200**; Vercel project `aimforge`; commit `0aebb83` 2026-07-11 |
| **Caldmere account portal** | `C:\Users\troyh\caldmere-login` | Next.js + Supabase sign-in portal for the game, plus Codex and Builder nav tabs and the character builder hosted at `/builder`. This is what the WPF launcher authenticates against | **LIVE** — `https://caldmere-login.vercel.app` → **200**; Vercel project `caldmere-login`; commit `c36d256` 2026-07-14 on `master`. Keys present, not read |
| **DairyForge backend (legacy)** | `C:\Users\troyh\dairyforge-backend` | The earlier standalone TypeScript/Drizzle backend for dairyforge.com, superseded by `dairyforge-monorepo` | **ARCHIVE — DO NOT DEPLOY.** `fly.toml` was deliberately renamed to `dairyforge-backend-legacy` on 2026-07-25 with a comment stating that deploying from here would replace the LIVE API and run a stale migration against the production database. Last commit `0de053c` 2026-06-27 on `feat/driver-loads-endpoints` |
| **Shadowbane private server** | `E:\ShadowbaneServer` | A Node/Express/socket.io game server for the `sb2Client` — accounts, characters, guilds, banes, mobs, loot, market, `seed_world.js`, node-cron ticks | **WORKING (local)** — not deployed, no git found |
| **Image Automation** | `C:\Users\troyh\OneDrive\Desktop\Image Automation` | Python image generator that uploads straight into Google Drive (`run_this.py`, google-auth + googleapiclient + cv2), with a `run_image_generator.bat` launcher. Sibling of the already-listed `C:\Users\troyh\image_generator` — this copy is the one holding live OAuth credentials | **WORKING** — ⚠ `client_secret.json`, `credentials.json` and `token.json` sit here in plaintext on the Desktop. Not opened. Worth moving or rotating |
| **OilForge** | `C:\Users\troyh\Desktop\OilForge` | The oilfield vertical of DairyForge — hotshot, frac sand, water hauling, vacuum trucks. `OilForge_Full_Spec.md` dated 2026-05-01, grounded in his own Oilfield Solutions LLC background | **SPEC ONLY** — one markdown file, zero code. A fifth Forge vertical that was never built |
| **Unity scratch project** | `C:\Users\troyh\My project` | An untitled Unity **2022.3.34f1** project (Caldmere is 6000.4.10f1, so this is unrelated to the game) | **UNKNOWN / scratch** — default name, never renamed |

### Not apps, but worth knowing they exist

| Thing | Absolute path | What it is |
|---|---|---|
| Obsidian knowledge vault | `C:\Users\troyh\OneDrive\Desktop\troys brain` | An Obsidian vault (`troys brain\`) plus the `KJ OS Template` and the Obsidian 1.12.7 installer. His personal second-brain system |
| Voice brain-dump recordings | `D:\braindumps_2026-05-21_wav` | 24 WAV files from 2026-05-21, named `mic_*` and `phone_*`. Real captured brain dumps. 🔴 I could not identify which app recorded them — no recorder in that folder and no matching output path in the diary or wake-word trees. Stated as unresolved rather than guessed |
| Gauge recovery scripts | `C:\Users\troyh\Desktop\Gauge` | Python scripts that recovered the Gauge/Jarvis source (`recover_gauge*.py`, `probe_*.py`) plus the 2026-05-06 JARVIS handoff. Archive of a rescue, not a product |
| Gemini brain-dump pack | `C:\Users\troyh\Documents\Gemini_Braindump_2026-06-25` | 9 markdown files (PMO compliance engine, PostGIS schema, biometric triggers, Blender rebake) plus an `AUDIT_REPORT.md` |
| ProDriver LLC archive | `C:\Users\troyh\Desktop\ProDriver-Archive` | His prior trucking company's financials, bank analysis and investor plan. Business records, not software |
| Third-party, **not his** | `D:\Bezi` (Bezi.exe, a Unity AI assistant) · `C:\Users\troyh\.minion` (Minion 3.0.12, a game addon manager) | Listed only so a future sweep does not mistake them for his products |

### What I checked and found nothing in

`C:\Users\troyh\Downloads` (no project folders at all) · `D:\dairyforge-work` (empty) · `C:\Users\troyh\OneDrive\Desktop\veritas` (empty) · `C:\Users\troyh\OneDrive\Desktop\replit` (a single unopened `ReplitExport-troy83352.tar.gz`) · `C:\Users\troyh\OneDrive\Desktop\Cowork Homebase` (spreadsheets only).

### Method, so this is auditable

Grep patterns run against candidate trees: `diary`, `Diary`, `brain.?dump`, `braindump`, `journal`, `haiku`, `docs\.google`, `googleapis`, `drive\.file`, `documents\.create`, `transcri`. The diary was found by grepping `n8n_Pod_Uploader_jarvis` — a repo whose `package.json` is still named `faith-and-thread` and which the inventory above lists as "ThinkBuddy", which is exactly why the diary was invisible on the first pass: **it is a second app living inside a third app's repo under a fourth app's name.**

Live HTTP checks run 2026-07-28 ~23:45 MDT via `Invoke-WebRequest -Method Head`: `thinkbuddy.vercel.app` **401** · `aimforge-gray.vercel.app` **200** · `caldmere-login.vercel.app` **200**.

---

## DEEP HUNT 2026-07-29

**Appended by `f3673e34/agent-AC-deep-app-hunt`. APPEND ONLY — nothing above this line was altered. READ-ONLY sweep. No `.env` or secret file was opened.**

### Why the two earlier passes fell short

Both prior sweeps read **folders**. Folders lie about deployment. This pass read the **deploy account** instead: `vercel project ls` as the logged-in user `troy83352`, which returns every project *and its real production URL*. That single command corrected four of Troy's five complaints at once, because **the production URL is not derived from the folder name**.

The headline: `thinkbuddy.vercel.app` is not the site. The `thinkbuddy` project serves **`thinkinbuddy.vercel.app`** (note the extra "in"). The first hostname is a stale deploy sitting behind Vercel deployment protection and returns **401**, which is exactly why Troy could not open the diary on his phone and why the FOUND LATER pass had to leave it unverified.

Every URL below was fetched with `Invoke-WebRequest -Method Get` on 2026-07-29 ~01:15 MDT and the HTML `<title>` recorded. A status with no title means the page renders its title in JavaScript.

### 1. SELLABLE AND LIVE — things with a price on them today

| App | Real name | Path | Live link (verified) | State |
|---|---|---|---|---|
| **Gumroad product #1** | **The AI Memory Blueprint** | `C:\Users\troyh\OneDrive\Desktop\BLUEPRINT_MEMORY.md` | **https://troyverse387.gumroad.com/l/gnroja** → **200** | **PUBLISHED, FOR SALE.** Teaches a buyer to build a Neon + Vercel MCP memory server. Price recorded as **$29** in the session where he published it — the live page renders price in JS so I could not read it off the page itself |
| **Gumroad product #2** | **The Voice Diary Blueprint** | `C:\Users\troyh\OneDrive\Desktop\BLUEPRINT_VOICE.md` | **https://troyverse387.gumroad.com/l/qlnaps** → **200** | **PUBLISHED, FOR SALE.** Sells the Site Diary app as a build-it-yourself kit. Same $29 caveat |
| **His storefront** | Gumroad store, seller name **"Troy Shoemaker"** | — | **https://troyverse387.gumroad.com** → **200** | **LIVE.** Neither product appears anywhere in the inventory above — this is real revenue infrastructure that was completely invisible to both prior passes |
| **Site Diary** | `Site Diary` (HTML `<title>`, `diary.html:7`) | `C:\Users\troyh\n8n_Pod_Uploader_jarvis\jarvis\api\diary.js` + `jarvis\public\diary.html` | **https://thinkinbuddy.vercel.app/diary.html** → **200**, title `Site Diary` | **LIVE — open it on your phone.** Voice → Whisper → Claude Haiku → Google Sheets |
| **ThinkinBuddy** | `ThinkinBuddy` | `C:\Users\troyh\n8n_Pod_Uploader_jarvis\jarvis` | **https://thinkinbuddy.vercel.app** → **200** | **LIVE.** The parent app the diary lives inside — 28 API routes (chat, memory, image, video, MCP, alarm, search, browse). 🔴 A prior audit found `/api/mcp` has **no auth**: `mcp.js:3` promises a Bearer check that `mcp.js:135-227` never implements |
| **Cognitive Aptitude Test** | `Cognitive Aptitude Test — how sharp are you today?` | `C:\Users\troyh\iq-app` | **https://iq-app-seven.vercel.app** → **200** | **LIVE.** This is the real IQ app URL |
| **FirstPrinciples Assessment** | `FirstPrinciples Assessment — how do you think?` | `C:\Users\troyh\firstprinciples-assessment` | **https://firstprinciples-assessment.vercel.app** → **200** | **LIVE.** Separate app from the IQ test, but they **share one Neon database** — the `firstprinciples` schema holds `iq_attempts`, `iq_results`, `candidates` (13 rows), `visual_responses` (77 rows) |
| **HVAC Tech Calc** | `HVAC Tech Calc` | `C:\Users\troyh\hvac-tech-calc` | **https://hvac-tech-calc.vercel.app** → **200** | **LIVE and the UI is COMPLETE** — 7 working calculators, no placeholders, no "coming soon" |
| **Claude AI Memory Vault** | `Claude AI Memory Vault` | `C:\Users\troyh\OneDrive\Desktop\claude-ai-memory-vault` | **https://claude-ai-memory-vault.vercel.app** → **200** | **LIVE.** The inventory above called this a "kit" — it is also a deployed site. This is the app that really does write **Google Docs** |
| **PC Auto Drive Organizer** | `PC Auto Drive Organizer` | `D:\pc-auto-drive-organizer` | Desktop app — no URL | **BUILT EXE EXISTS:** `D:\pc-auto-drive-organizer\release\win-unpacked\PC Auto Drive Organizer.exe`, **180 MB, built 2026-07-26 14:58** |

### 2. LIVE, ALREADY KNOWN — links corrected or confirmed

| App | Live link (verified 2026-07-29) | Note |
|---|---|---|
| DairyForge | **https://dairyforge.com** → 200 · also **https://dairyforge.vercel.app** → 200 | Vercel project `dairyforge`. The gap the first pass flagged is now closed |
| AimForge console | **https://aimforge-console.vercel.app** → 200 | Title reads `Forge — TMS & AI dispatch for freight carriers` |
| AimForge landing | **https://aimforge-gray.vercel.app** → 200 | Vercel project `aimforge`, from `OneDrive\Desktop\aimforge-web` |
| Caldmere Codex | **https://caldmere-codex.vercel.app** → 200 | 🔴 Deploys from **`C:\Users\troyh\.claude\apps\caldmere-codex`** (one 420 KB static `index.html`) — NOT from `E:\UnityProjects\Caldmere_v2` as line 30 above says |
| Caldmere login | **https://caldmere-login.vercel.app** → 200 | |
| Caldmere screenshots | **https://troy83352.github.io/caldmere-shots/** → 200 | Live gallery, title `Caldmere — Minotaur Character Creation`. Pushed by `D:\_dem\bridge\push_gallery.ps1` |
| DFA Saadi demo | **https://dfa-saadi-demo.vercel.app** → 200 | |
| Claude Memory API | **https://claude-memory-api.vercel.app** → 200 | |
| Claude Memory MCP | **https://claude-memory-mcp-troy.fly.dev** → 200 | |
| Faith & Light store | **https://faithnlight.shop** → 200 | 🔴 Its page title still says **"Faith & Light"**, the name Troy calls dead — see §4 |
| Faith & Thread store | **https://n8n-pod-uploader.vercel.app** → 200 | Title `Faith & Thread — Christian Streetwear`. A **second live storefront** with the new brand name |
| Faith & Thread API | **https://faith-thread-api-production.up.railway.app/api/products** → 200 | 🔴 **RAILWAY.** The inventory has zero Railway rows. Root `/` returns 404; the API path answers |
| Faith & Thread n8n | **https://faith-thread-n8n.fly.dev** → 200 | |
| Forge Fleet Ops | **https://forge-fleet-ops.fly.dev** → 200, title `Fleet Ops Layer` | 🔴 A **live Fly app whose source is lost** — only the 4-file salvage stub at `C:\Users\troyh\forge-fleet-ops-recovered` remains |
| Forge punch list | **https://forge-punchlist.vercel.app** → 200 | Title `Forge — Master Punch List`. No folder on disk |
| ForgeFleet landing | **https://forgefleet.vercel.app** → 200 | No folder on disk |
| Forge web deploy | **https://forge-web-deploy.vercel.app** → 200 | No folder on disk |
| ForgeFleet dash | **https://forgefleet-dash.vercel.app** → 200 | From `C:\Users\troyh\forge-monorepo` |
| DairyForge unified dash | **https://dairyforge-unified-dash.vercel.app** → 200 | From `C:\Users\troyh\df-wt-dashboard` — a June-16 feature branch is what is live |

### 3. DEAD LINKS — verified non-answering, so nobody chases them again

`jarvis-asteroid.vercel.app` **404** · `memorybridge-demo.vercel.app` **404** · `forge-api-app.fly.dev` **404** · `faith-thread-resizer.fly.dev` **404** · `dairyforge-api.fly.dev` **404 at `/`** (routes, but no root route) · `aimforge-api.fly.dev` **404 at `/`** (same) · `troy83352.itch.io/caldmere` **404** (the Caldmere itch.io build is gone or private) · `thinkbuddy.vercel.app` **401** · `faithandlight.shop` **DNS does not resolve** · `forgefleet-api.fly.dev` **DNS does not resolve** · `dairyforge-backend-legacy.fly.dev` **DNS does not resolve** (good — that is the do-not-deploy archive).

**Not his, do not chase:** `iq-app.vercel.app` (redirects to a stranger, already noted above) and **`aim-forge.vercel.app`**, which is live but titles itself `AIM FORGE — Crosshair Overlay` — a gaming overlay. 🔴 `skills/name-the-system-before-you-touch-it/SKILL.md:72` wrongly equates `aim-forge.vercel.app` with the AimForge console. That skill line is wrong.

### 4. Apps with NO row anywhere in this document

| App | Real name | Path | Live link | State |
|---|---|---|---|---|
| **DairyForge USB demo / DairyPort** | Two EXE brands off ONE `app.py` | `C:\Users\troyh\Documents\Codex\2026-07-02\alright-forget-that-fucking-email-thing\work` | Desktop EXE, no URL | **WORKING.** `app.py` is 6,212 lines. Builds `dist\START_DAIRYFORGE_DEMO.exe` **and** `dist\START_DAIRYPORT_DEMO.exe` — "DairyPort" is a second brand, not a second codebase. 20 dated USB release folders under `release\`. **Not a git repo.** This is the Chobani/Twin Falls demo tree — the most customer-facing artifact he owns, and it had no inventory row |
| **Helmion Hub** | `helmion-hub` | `C:\Users\troyh\helmion-hub` | Not deployed | **IN PROGRESS.** Next.js + vitest. Its own description: *"Shared access hub: Troy and Bryce publish and test each other's Helmion builds."* |
| **ThinkinBuddy Android APK** | "Mark" | `…\n8n_Pod_Uploader_jarvis\jarvis\public\mark-android.apk` | Wraps thinkinbuddy.vercel.app | **BUILT.** Capacitor thin shell loading the live site in a native WebView |
| **Gauge pre-rename snapshots** | bundle `com.troy.gaugesandbox` | `C:\Users\troyh\OneDrive\Desktop\archive\gauge-snapshots-2026-05-09\` (5 trees) + `C:\Users\troyh\Desktop\Gauge\recovered` | — | **ARCHIVE.** The whole `OneDrive\Desktop\archive` tree was missing from this document |
| **`D:\_dem`** | "Caldmere tooling / scratch" | `D:\_dem` | — | **ACTIVE.** Registered as a first-class project in Neon (`bigsister.projects` id=8) with a running watcher and 615 `pattern_library` rows, yet absent from this document |

### 5. Fly apps — the complete list, from all 36 `fly.toml` files on disk

`flyctl` is **not logged in** on this machine (`no access token available`), so disk config is the only source. **9 real app names + 1 placeholder:**

`dairyforge-api` (in **25** separate folders — every worktree carries a deployable copy) · `aimforge-api` (3) · `forgefleet-api` (1, DNS dead) · `forge-api-app` (1) · `dairyforge-backend-legacy` (1) · `dairyforge-telegram-bot` (1) · `faith-thread-n8n` (1) · `faith-thread-resizer` (1) · `claude-memory-mcp-troy` (1) · and `CHANGEME-claude-ai-memory-vault-pro`, a **template placeholder that was never deployed**.

🔴 The 25-folder `dairyforge-api` count is the real hazard: **a `fly deploy` from any one of those 28 folders targets live production.**

### 6. Two structural traps that made apps invisible

1. **`.vercel/repo.json` is not `.vercel/project.json`.** `C:\Users\troyh\aimforge\.vercel\` contains only `repo.json`, so any sweep grepping for `project.json` misses the AimForge console entirely. Search for both.
2. **The OneDrive tree is a reparse point** (attribute `0x100411`, cloud placeholders). A recursive scan with a standard `ReparsePoint` skip returns **zero hits for all of `OneDrive\Desktop` in ~300 ms** and looks like a successful empty search. Both Gumroad products, the Memory Vault and the archive tree live in there. This is almost certainly why two passes missed them.

Also: **8 live Vercel projects have no deploy config on disk at all** — `dairyforge`, `forgefleet`, `forge-web-deploy`, `claude-ai-memory-vault`, `n8n-pod-uploader`, `forge-punchlist`, `jarvis`, `jarvis-troy`. They deploy through Vercel's GitHub integration, which leaves no local artifact. **No disk-only sweep can ever find them.** `vercel project ls` is the only way.

### 7. Honest gaps in THIS pass

- **Gumroad prices were not read off the live pages.** Both product pages return 200 and render their correct titles, but the price is JavaScript-rendered. The `$29` figure comes from his own `BLUEPRINT_*.md` files and the session transcript where he confirmed both showed "Unpublish". Treat the *price* as secondary-source, the *published status* as verified.
- **Fly runtime status is unproven.** `flyctl` is not authenticated, so "live" for a `.fly.dev` host means only that HTTP answered, not that the app is healthy.
- **`bigsister.context`, `bigsister.decisions` and `bigsister.sprints` are all EMPTY** (0 rows). The high-trust tier described in Rule 0.27 has never been written to, while the low-trust lane holds 405 `agent_logs`, 1,752 `failure_logs` and 3,978 `session_snapshots`.
- **No `.env` was opened**, and no credential value was read or printed anywhere in this pass.
- **Nothing was changed, deployed, or deleted.**
