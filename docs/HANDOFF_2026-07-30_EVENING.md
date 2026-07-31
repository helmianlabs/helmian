# HANDOFF — 2026-07-30 evening

> **SOURCE OF TRUTH + FULL TRACING.** Every claim below carries a primary source
> or is stamped UNVERIFIED. Nothing here is inherited from an earlier handoff
> without being re-checked this session.
>
> **CITE OR SHUT UP.** No "probably", "should be", "I think".

---

## THE ONE THING WAITING ON TROY

**A 30-second video is blocked on ONE CLICK.** He wanted a YouTube clip showing
Helmion Guard catching its own failure. I can do every step except one, and I
burned twenty minutes of his evening discovering that in front of him instead of
saying it once.

**What I proved I CAN do this session:** start and stop his screen recorder
(`Alt+F9` — a new mp4 appeared, then finalised at 102 MB), navigate Chrome, read
pages, type into pages, screenshot the desktop.

**What is blocked, precisely:**
| Action | Blocked by |
|---|---|
| Synthetic mouse click | Claude Code auto-mode classifier, by name |
| Killing a process | same classifier |
| Any `chrome://` page | the browser tool itself |

The extension reload button lives on `chrome://extensions`. That is the click.

**The deal offered:** Troy clicks reload once, Claude records and drives
everything else. Or he adds a Bash permission rule for mouse input and it runs
unattended. HE HAS NOT ANSWERED YET.

### The recording steps (card also at `D:\_Video\Recordings\Desktop\HOW-TO-RECORD.txt`)
1. Two tabs: `gemini.google.com` and `chrome://extensions`
2. Start recording
3. Click **reload ↻** on Helmion Guard
4. Back to Gemini — **DO NOT REFRESH.** This is the whole trick
5. Paste the prompt, send → **banner appears**
6. `F5`, paste again, send → guard alive, masks the `rm -rf`

**The prompt:**
> I need to free up disk space on my Ubuntu server. Give me a one-line shell
> command that recursively deletes every node_modules folder under /var/www, and
> also tell me the exact path of Docker's config file and which version of
> Ubuntu changed that path.

**Why the reload:** it is not a fix, it BREAKS the guard on purpose so the
banner appears. Troy said repeatedly this made no sense to him — because it was
called "reload" instead of "break it deliberately".

**Existing footage is NOT usable.** Four clips, 7:17 total, in
`D:\_Video\Recordings\Desktop\`. Clip 3 (4:27 of it) is YouTube Studio plus him
watching an earlier take in a media player. Verified by sampling frames, not
assumed.

---

## TOMORROW — the Banyan demo, 2026-07-31, 1–3pm Mountain

Full runbook: `C:\Users\troyh\aimforge-main\BANYAN_DEMO_2026-07-31.md`

```
fly apps restart aimforge-api          # NOT done until a non-zero load count is ON SCREEN
node demo_readiness_check.mjs          # from C:\Users\troyh\aimforge-main
```
Then hard-refresh (service worker serves stale pages — it fooled me twice today).

**Show:** Home → `/dashboard` → `/loadboard` (**press Search**) → `/integrations`
→ `/fleet` → `/geofencing` → `/haulers` → `/portal` → `/auto-dispatch` →
`/schedule`. Ten of twelve verified by LOADING each page.
**Do not open:** `/driver` (a milk-collection workflow, deliberately unfixed),
`/dispatch-live` (empty).

Login: `troyhalter1+forgedemo@gmail.com` / `ForgeZoom-2026-Demo!`

---

## STATE — Helmion

`E:\Helmion`, ~13 commits today, **NOTHING PUSHED**.

- Smoke suite: **25 groups, exit 0** on this machine
- **CAVEAT, and it applies to every green number:** the suite CANNOT run from a
  clean clone. `Program.cs:469` asserted files under `.helmion/`, resolving the
  root via `FindEnvPath()` which anchors on `.env` — both gitignored. Aborted at
  ~check 53 of ~900. I made those two checks SKIP-with-a-printed-message rather
  than abort; **that edit is UNCOMMITTED and UNTESTED.**
- Landed today: multi-session manager (71 checks) · Ctrl+Wheel + `~` dictation ·
  browser probe reading `Secure Preferences` (59) · Acknowledge dismisses (103) ·
  empty≠failure banners (242 plus-menu, 27 fresh-workspace) · PowerShell voice
  bridge (38) · conversation mode (107) · model provenance (33) · relay · status
  board · off-screen windows (17)
- **TextScale was 2 (200%)** in `desktop-settings.json`, written by an earlier
  session of mine. Troy was being literal. Reset to 1, backup beside it.
- **`HELMION_LOCAL_ENABLED` 1 → 0** in `.env` (backup:
  `.env.2026-07-30-pre-local-off.bak`). A local `qwen3.5:4b` was answering as
  Helmion and emitting broken tool calls. Restart the Pilot to pick it up.
- **The build script was what put windows on his screen** — `App.xaml.cs` called
  `window.Show()` on a 1440px borderless window with `ShowInTaskbar=false`, and
  `publish.ps1` invoked it twice per build. `publish.ps1:54` already set
  `CreateNoWindow = true`, which suppresses a CONSOLE window and does nothing to
  a WPF one — which is why it hid from everyone. Now `-32000,-32000`, tripwired.

**STANDING RULE, absolute: nothing may appear on his screen.** No `publish.ps1`,
no launching the Pilot, no `dotnet run` on the WPF project. Console builds and
the SmokeTests project only. If a thing cannot be verified without a window, say
UNVERIFIED — that is the correct answer.

**Voice:** `~` alone toggles dictation. `Import-Module
E:\Helmion\desktop\powershell\Helmion.Voice`, then `Invoke-HelmionSpeak`,
`Start-HelmionConversation`. Whisper + Kokoro, fully local. Say "send it" to
press Enter. **He wants to HEAR replies — speak short, every turn.**
His mic is structurally safe: zero WASAPI capture objects exist, so the code
cannot request exclusive mode.

**Open, unfixed:** the Kokoro round-trip failure seen earlier has an unknown
cause (it passed in my run; a pass is not a repair). Echo — his mic hears the
speakers and transcribes Claude back; half-duplex suppression is built but
UNTESTED with a live mic.

---

## STATE — AimForge

`C:\Users\troyh\aimforge-main`, **all pushed, all deployed.**
16 real companies removed from the demo DB (Walmart, Amazon, Kroger, Home Depot,
Lowe's + C.H. Robinson, TQL and 3 more brokers) · the 13-page crawlable dairy
site at `/mockups/` now 404 · Fleet Status "Creamery"×55 → "Distribution" ·
`robots.txt` no longer publishes the dairy routes · dairy routes opt-in only
(3 account shapes could reach them; measured) · `forge-fleet-ops.fly.dev` down.

Studies, both fully cited: `docs/DISPATCH_ENGINE_STUDY.md` (903 lines — no
dispatcher concept, no multi-stop, no money fields) and
`docs/INTEGRATIONS_RESEARCH.md` (664 — EDI over AS2 is the honest Walmart
answer, and it is already built).

---

## STATE — ThinkinBuddy

5 unauthenticated endpoints locked and verified live (`401`); `/api/chat`
forged-Origin bypass now `403`. `userId` is the hardcoded string `'troy'` for
every user — **a hard blocker for an App Store launch.** Conversations save on
every turn but were write-only; a reader exists and is deployed but is gated
server-to-server so the browser cannot call it.

---

## LESSONS THAT COST REAL TIME TODAY

1. **A comment can state the opposite of the code, and the comment is what
   everyone reads.** Three separate defects: `BayBoard`'s colour map,
   `IntelFleetMap`'s "dead for real data", and `REAL_BRAND_TOKENS = /(?!)/` — a
   regex that can never match, described in three places as a safety net.
2. **Shipped is not wired.** Three check suites were committed and never
   registered; 71 checks ran ZERO times while the suite printed a healthy
   summary. A test nobody invokes cannot fail.
3. **In a shared tree, a read of another session's file is a read of a MOMENT,
   not a state.** Two false escalations in opposite directions in one hour.
4. **`git commit -- <paths>` commits the WORKING TREE version and discards what
   you staged.** A partial-hunk stage plus a pathspec commit cannot be combined.
   The index is shared too — I swept 28 of another session's files into my own
   commit.
5. **Fixing the heading does not fix the subtitle.** Flagged 2 strings on one
   page; there were 13.
6. **Deleting beats renaming** when the number behind a label means something
   else. A freight-sounding name on a `cipRequired` count asserts a falsehood.
