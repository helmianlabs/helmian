# Helmian Guard: new user setup (free browser, 0.6.0 test build)

Plain steps for someone setting up Guard for the first time on a free browser
(Chrome, Edge, Brave, or Firefox). Nothing here needs a paid plan for Guard
itself. Lines marked **PLACEHOLDER** need a real value from Troy or Paul before
they work.

## 1. Install the Guard extension (unpacked test build)

Chrome / Edge / Brave:
1. Unzip `helmian-guard-chrome-0.6.0.zip` (or use the `unpacked/chrome` folder).
2. Open `chrome://extensions` (Edge: `edge://extensions`).
3. Turn on **Developer mode** (top right).
4. Click **Load unpacked** and pick the unzipped folder.
5. Pin the Guard icon (puzzle-piece menu → pin).

Firefox:
1. Open `about:debugging#/runtime/this-firefox`.
2. Click **Load Temporary Add-on…** and pick `manifest.json` inside the
   unzipped `helmian-guard-firefox-0.6.0` folder. (Temporary add-ons go away
   when Firefox restarts.)

Guard starts protecting claude.ai, chatgpt.com, gemini.google.com and grok.com
right away. Everything below is optional and **off by default**.

## 2. Connect Scribe to your AI chat (the "connector")

Each AI site reads mail through its own Scribe connector. Add it once per site:

- Scribe connector URL: **PLACEHOLDER: `https://<scribe-host>/mcp`**
- Sign-in / passphrase for the connector: **PLACEHOLDER: how the user signs in (passphrase or account)**

Where to add it (from each vendor's help pages; plans change):
- Claude: Settings → Connectors → Add custom connector (Free plan: one custom connector).
- ChatGPT: custom MCP connectors are for Business / Enterprise / Edu, and Pro with read/fetch only. Plus is not listed.
- Grok: grok.com/connectors → New Connector → Custom.
- Gemini: custom apps need age 18+, US, a personal account, Keep Activity on, English. Write actions need manual confirmation.

## 3. (Optional) The Spoke

- Spoke install: **PLACEHOLDER: download link and install steps for the spoke**

## 4. Let Guard watch for Scribe mail

1. Click the Guard icon → **Scribe letters**.
2. Scribe server URL: **PLACEHOLDER: `https://<scribe-host>`** (no trailing slash).
3. Click **Sign in to Scribe**. The browser asks for one permission (Chrome /
   Edge: "identity" plus access to that one server). Approve on the Scribe page.
   Guard asks only for `memory.read`.
4. Mailboxes to watch: **PLACEHOLDER: mailbox names, e.g. `claude.ai, grok`**
5. Turn on **Knock when I have Scribe mail** and save.

Fallback (Advanced, hidden by default), only if sign-in is not available:
- Unread-mail URL path: **PLACEHOLDER: `/mailbox/unread`** (current default; the
  live server answered 404 on 2026-10-29, so Guard shows "Not deployed yet").
- Mailbox token: **PLACEHOLDER: mailbox status token from Paul (never paste it into a chat)**

## 5. (Optional) Auto-nudge

Auto-nudge types one fixed line into an idle AI chat when that site's mailbox
has a new letter, telling the AI to check its Scribe inbox. It never pastes
letter content.

1. Guard icon → **Scribe letters** → **Auto-nudge (behind the scenes)**.
2. Turn on the master switch and only the sites you want.
3. Leave idle minutes at 3 and the daily cap at 20 unless you have a reason.
4. **Kill switch** stops every nudge at once.

It only nudges when the composer is empty, no reply is streaming and you have
not typed for the idle time. At most once per tab per 10 minutes, 20 per site
per day, never for receipts or acks, never twice for the same letter. If a
site's page looks different from what Guard expects, Guard types nothing and
pauses that site for 6 hours. The log in the popup shows every decision.

Note: some sites' terms forbid automated or scripted use (Anthropic and xAI
say so explicitly). Turn a site on only if you accept that.

## 6. Approval pill

When Guard needs a decision (for example, a message with personal details),
a small pill appears in the bottom-right corner. Click it to see details, then
press **Allow once** or **Deny**. No answer in 60 seconds means Deny. Guard
never allows by itself.
