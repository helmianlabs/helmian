# Helmion Guard × Scribe door-knock (0.5.0, draft)

Branch `feat/scribe-door-knock`, off `feat/executive-guard` @ 98fee95 (PR #53). `main` has no extension changes since that merge.

## Contract status
Built to `/workspace/scribe/door-knock-contract.md` v1 (troy83352/shared-memory-mcp draft PR #3, `door-knock/courier-receipts`, not deployed, needs migration 006).
- `GET {base}/mailbox/unread?agent=<mailbox>&since_id=<cursor>[&include_legacy=1]` with `Authorization: Bearer <MAILBOX_STATUS_TOKEN>` (self-host) or `smk_…` `mailbox.read` / OAuth `memory.read` (SaaS).
- **Guard never writes.** Receipts are automatic when the AI uses MCP (`check_inbox` → delivered, `read_message`/`mark_read` → read, `ack_message` → ack). So "open a letter and send a receipt" becomes: the notification or popup button opens that AI (claude.ai / chatgpt / gemini / grok) so it runs `check_inbox`, and Scribe records the receipt. Guard never shows bodies (the endpoint never returns them).
- Errors: 400 parks that mailbox ("unknown name"). 401/403 stops all polling with "reconnect Scribe". 404 is feature off (quiet, 15 min). **503 `courier_not_installed`** shows a quiet "Mailbox not set up yet", re-checks every 15 min and doesn't count as an error. 500/network retries at 60 s, then every 5 min after 3 errors. 402/429 are not in the contract but are handled (UTC-midnight / Retry-After).

## Permissions
| | Chrome / Edge (MV3) | Firefox (MV3) |
|---|---|---|
| required | `storage`, `alarms`, `idle` (none shows an install warning) | same |
| optional | `notifications` (requested from the popup on Save) | `notifications` in `optional_permissions` |
| host | Scribe origin only, requested at runtime from the existing `optional_host_permissions` (`https://*/*`, localhost). **Nothing new is granted at install.** | same via `optional_permissions` |

## Polling
A 1-minute alarm `helmion-scribe-poll` (the MV3 floor is 30 s) runs only when enabled with a URL, a token and at least one mailbox. Each watched mailbox (max 8) has its own `nextAt` = `poll_after_seconds` clamped to 60–120 s ±15 s jitter. The `cursor` is saved and sent back as `since_id`. The badge is the sum of `unread_count`, and notices go out only for `new` ids above the saved cursor. Polling pauses while the browser is idle or locked (`chrome.idle`, 5 min) and while offline, and neither spends budget. `include_legacy=1` (opt-in) is sent at most every 5 min. There's an own daily request budget across mailboxes (default 2000/UTC day; 1 mailbox at 60 s ≈ 1440).

## UX
- Global green badge (unread, `99+` cap). Per-tab red/amber Guard badges still override on chat tabs.
- Notification "Muse: 2 new letters" + latest sender: subject lines. Clicking it opens the AI for that mailbox.
- Popup "Scribe letters": settings (URL, token, comma-separated mailboxes with aliases normalised like PR #3, legacy, notify), a per-mailbox count with recent subjects, and an "Open <AI> to read" button. Server states show in plain words.

## Auth
The token is pasted in the popup and stored in `chrome.storage.local` like the Executive Guard and Flags keys. It's never returned to the popup or pages, never logged, and the `helmion:scribe-*` messages are popup-only. Off by default. Changing the URL resets cursors.

## Tests
- `extension/test/scribe-door-knock.test.mjs` uses `test-support/mock-scribe.mjs`, a mirror of PR #3's `single.ts` route and `unreadSummary()`.
- `extension/test/scribe-pr3-local.test.mjs` (`npm run test:scribe-pr3`, needs `SCRIBE_PR3_APP=<PR #3 checkout>/server.src/app`) runs PR #3's **real** courier code + migrations on PGlite behind a copy of the `single.ts` handler. `single.ts` itself opens a real Postgres pool at import, so it can't be loaded in-process.
- `test/sign-guard.test.mjs`. Permission pin tests were updated on purpose.

## Contract ambiguities
1. "Make it easy to send a receipt" vs the contract's "Guard never writes". The contract wins here, so receipts come only from the AI's MCP calls.
2. Which mailbox goes with which tab: the contract says "the AI tab it lives next to", but Guard's sites map only to `claude.ai`, `chatgpt`, `gemini`, `grok`. Here the user lists mailboxes in settings. Plain `claude` stays its own mailbox, which is the contract's open question.
3. The SaaS route (`saas/app.ts`) has no 503 `courier_not_installed` branch and no `include_legacy`. A missing table there would be a 500.
4. "Back off to 5 min after 3 errors" doesn't say what happens before the third error. This uses 60 s.
5. 402/429 aren't listed. They're handled defensively.
6. The legacy count has no read state and is shown as a number only, never in the badge.
7. `new` is capped at 20. More than 20 arrivals in one interval give one notice for the first 20 and the cursor jumps to `newest_id`.
8. The production BASE ("same host as connect.helmian.cloud") isn't fixed, and Troy must issue the MAILBOX_STATUS_TOKEN.

## Signing path (nothing signed or submitted)
`npm run guard:sign:{firefox,chrome,edge}` runs a **dry run** by default. `--execute` additionally requires `GUARD_SIGNING_APPROVED=yes` plus credentials.
- **Firefox**: `web-ext sign --channel unlisted` (self-distributed signed .xpi, not listed on AMO). Needs `AMO_JWT_ISSUER`/`AMO_JWT_SECRET` from Troy's AMO account, and the real add-on id in place of `guard@helmion.example` (the script refuses the placeholder). A listed release is a separate store submission and needs listing assets, a privacy policy and review.
- **Chrome**: the Web Store signs on upload. That needs Troy's CWS developer account ($5 one-time), listing and privacy disclosures. For self-hosted or testing use, the script packs a CRX with `CHROME_BIN` + `CHROME_CRX_KEY_PATH` (keep that key; it fixes the extension id). Off-store CRX installs are blocked for normal Chrome users outside enterprise policy.
- **Edge**: no off-store signing. Microsoft signs on Partner Center submission (`EDGE_PRODUCT_ID`, `EDGE_CLIENT_ID`, `EDGE_API_KEY` from Troy's Partner Center account). The script only reports.
