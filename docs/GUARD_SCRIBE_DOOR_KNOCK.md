# Helmion Guard × Scribe door-knock (0.5.0, draft)

Branch `feat/scribe-door-knock`, off `feat/executive-guard` @ 98fee95 (PR #53). `main` has no extension changes since that merge.

## Contract status
Paul's contract `/workspace/scribe/door-knock-contract.md` **did not exist** on 2026-10-29 15:35 MT. Built against:
- `GET {base}/mailbox-status`: **real**, already on Scribe main (f58c762). SaaS: Bearer `smk_…` with `mailbox.read` (or OAuth `memory.read`). Self-host: Bearer `MAILBOX_STATUS_TOKEN`. Shape `{generated_at, mailboxes:[{tag:"for-<agent>", agent?, count, newest:{id,sender,created_at,subject}|null}]}`. Subjects only, never bodies.
- `GET {base}/api/courier/messages/:id` and `POST {base}/api/courier/messages/:id/receipt`: **provisional, mocked**. These are one constant (`SCRIBE_PATHS` in `background/scribe-client.js`) to change when the contract lands.
- Note: Courier letters live in `agent_messages` (not memories tagged `for-<name>`). The self-host feed still counts tagged memories. The client accepts both shapes.

## Permissions
| | Chrome / Edge (MV3) | Firefox (MV3) |
|---|---|---|
| required | `storage`, `alarms` (no install warning) | same |
| optional | `notifications` (requested from the popup on Save) | `notifications` in `optional_permissions` |
| host | Scribe origin only, requested at runtime via the existing `optional_host_permissions` (`https://*/*`, localhost). **Nothing new is granted at install.** | same via `optional_permissions` |
The existing optional pattern is broad because the user types the URL. Only the exact origin typed is ever requested. Tightening it to a fixed Scribe host is possible once Troy picks the production URL.

## Polling
- `chrome.alarms` `helmion-scribe-poll`, period 1 or 2 min (clamped; MV3 floor is 30 s). It's created only when enabled + URL + token, and cleared otherwise.
- Backoff: 1, 2, 4… min, capped at 30 min on network/5xx. 429 honours `Retry-After`. 402 (Scribe's daily tenant limit) waits until UTC midnight, matching Scribe's `usage_daily` reset. 401/403 stops polling until a new token is pasted.
- Offline (`navigator.onLine === false`): skip, spend no budget.
- Own daily budget (default 1000 polls/UTC day, settable) so the door-knock can't eat the tenant's shared Scribe allowance. 1/min = 1440/day, 1/2 min = 720/day. Troy should confirm whether `/mailbox-status` is metered against the plan limit.

## UX
- Global badge = total unread (`99+` cap, green). The existing per-tab red/amber Guard badges still override on chat tabs.
- One notification per *new* newest letter per mailbox (deduped). It shows the sender and subject, never the body. Clicking it opens the popup where supported (`action.openPopup`).
- Popup "Scribe letters" section: settings, an inbox list (mailbox, count, newest), **Open** fetches the letter, and **Send receipt** posts the receipt and re-polls.

## Auth
The token is pasted in the popup and stored in `chrome.storage.local` like the Executive Guard and Flags keys. It's never returned to the popup or pages, never logged, and all `helmion:scribe-*` messages are popup-only. Off by default.

## Tests
`extension/test/scribe-door-knock.test.mjs` (mock Scribe in `test-support/mock-scribe.mjs`) and `test/sign-guard.test.mjs`. Permission pin tests were updated on purpose.

## Signing path (nothing signed or submitted)
`npm run guard:sign:{firefox,chrome,edge}` runs a **dry run** by default. `--execute` additionally requires `GUARD_SIGNING_APPROVED=yes` plus credentials.
- **Firefox**: `web-ext sign --channel unlisted` (self-distributed signed .xpi, not listed on AMO). Needs `AMO_JWT_ISSUER`/`AMO_JWT_SECRET` from Troy's AMO account, and the real add-on id in place of `guard@helmion.example` (the script refuses the placeholder). A listed release is a separate store submission and needs listing assets, a privacy policy and review.
- **Chrome**: the Web Store signs on upload. That needs Troy's CWS developer account ($5 one-time), listing and privacy disclosures. For self-hosted or testing use, the script packs a CRX with `CHROME_BIN` + `CHROME_CRX_KEY_PATH` (keep that key; it fixes the extension id). Off-store CRX installs are blocked for normal Chrome users outside enterprise policy.
- **Edge**: no off-store signing. Microsoft signs on Partner Center submission (`EDGE_PRODUCT_ID`, `EDGE_CLIENT_ID`, `EDGE_API_KEY` from Troy's Partner Center account). The script only reports.
