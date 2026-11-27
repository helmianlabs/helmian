# Screenshots and videos: inventory and gaps

Checked 2026-11-26. "Stale" means the image or video shows a screen that has
changed since it was made. Nothing here was deleted; this is a list for the
owner to act on.

## Screenshots and stills in the repo

| File | Date | Used by | Status |
|---|---|---|---|
| `docs/assets/logo.png` (also `web/marketing/assets/helmian-logo.png`, `desktop/.../Helmian-logo.png`) | 2026-08-03 | README, site, desktop | Current |
| `docs/media/2026-11-06-workbench-browser-built-page.jpg` | 2026-11-06 | README | Dated but fair: the channel and workbench still look like this |
| `docs/media/2026-11-06-guard-panel.jpg` | 2026-11-06 | README | Dated but fair |
| `docs/media/2026-11-06-integrations-discord-slack.jpg` | 2026-11-06 | `docs/media/README.md` | **Stale**: taken before the 2026-11-20 API-key-only connect change; the Integrations cards changed |
| `docs/media/2026-11-06-pull-request-in-workbench.jpg` | 2026-11-06 | `docs/media/README.md` | Dated but fair |
| `docs/assets/hero.gif` | 2026-08-03 | Nothing (not referenced) | **Stale**: an early multi-agent desktop with numbered seats ("Claude1", "Grok1") and a local `127.0.0.1` preview |
| `docs/assets/desktop-4panel.jpg` | 2026-10-18 | Nothing (no longer referenced) | Stale: the Windows desktop four-panel view |
| `web/marketing/media/helmian-desktop-overview.jpg/.mp4` | 2026-08-03 | **helmian.cloud home page** | **Stale**: shows the old "Helmian Personal Pilot" Windows desktop, not the web app people sign up for |
| `web/marketing/media/helmian-guard-review.jpg/.mp4` | 2026-08-03 | helmian.cloud home page | **Stale**: same era |
| `web/marketing/media/helmian-project-flow.jpg/.mp4` | 2026-08-03 | helmian.cloud home page | **Stale**: same era (numbered seats, local preview) |
| `web/marketing/test/shots/*.png` (20 files) | 2026-10-15 | Visual test baselines | Test artifacts, not product media |
| `web/marketing/assets/agents/*.png`, `assets/emoji/*.svg` | Oct–Nov | App UI | Icons, current |

## Public videos (HELMIAN AI channel)

| Video | Status |
|---|---|
| jf9XE3cXEEk "Ten AIs, One Room, One Set of Rules" (Nov 6) | Linked in README. Accurate for its date. |
| jF_mlaKBdDk "The Seats, Working" (Nov 6) | Linked in README. Accurate for its date. |
| vs4QFFdD7Fg "The Guard Says No" (Nov 7) | Linked in README. Accurate. |
| eZHzldfgB-g, Den0KNuqGGk (DairyForge Driver App, Forge TMS) | Linked under "Built with Helmian". |
| Tp65loZwK_0 and DEQA9uUa5A0 (Nov 10) | **Stale, still public on the channel**: they show connecting a seat with an account password, a road retired on 2026-11-20. Not linked from the repo. Owner's call whether to unlist. |
| GOL0gtuXxbE (old tutorial, unlisted) and IU80dwFytXs | Removed from the README on 2026-11-26 (wrong or outdated). |

## Missing: needs the owner to record

Video cannot be recorded from the build box, so these are requests:

1. **Setup tutorial (new):** sign up, connect one seat by API key, pair the PC spoke, first message in a channel.
2. **Helmian Guard extension 0.7.0:** sideload on Chrome or Edge, then on claude.ai, ChatGPT, Gemini and Grok show a destructive command hidden in a reply, a pasted key redacted at send, and an injection-looking paste asking first.
3. **Executive Guard approval:** an agent asks to change something on the PC, the approval card appears, the owner approves, the action runs, and the audit trail verifies.
4. **Site Guard, honest scope:** a destructive message stopped, a flood stopped, an injection-looking message flagged in the Guard feed but let through.
5. **Write lease:** two agents try to write the same project; the second is refused.
6. **Home page videos:** replacements for the three Aug 3 clips on helmian.cloud.

Screenshots also missing: the extension's popup and its warnings on each of
the four sites; the approvals page on door.helmian.cloud; a Site Guard
finding in the Guard feed; the Integrations page after the 2026-11-20
change; the spoke installer.

## Why no screenshots were regenerated on 2026-11-26

Every useful product screen needs a signed-in account (the app, approvals)
or signed-in AI sites (the extension). Capturing them from the build box
would mean signing in to the owner's accounts, which is not a clean or
appropriate capture. Public marketing pages could be captured, but they are
not product screenshots. So this list flags the gaps instead.
