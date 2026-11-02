# New user setup (helmian.cloud)

Plain steps for a new person (for example a demo partner) who already has
accounts with Claude, ChatGPT, Grok, Gemini and/or Mistral. Every AI
connects the same one way: with its account email and password, entered
right on its card in Helmian's Integrations page (or in the Create
Custom Agent dialog). The pair is stored in the tenant's credential
vault behind the Guard approval gate, and the seat then works off that
sign-in. There are no API keys, device codes, or CLI sign-ins as
connect roads.

## 1. Make an account

1. Open <https://helmian.cloud/app>.
2. Press **Sign in**, then the sign-up link on the sign-in page (the front
   page "Create account" button is being fixed on a separate branch).
3. Enter the email code.

## 2. Set up this PC (the spoke)

1. In Helmian, open **Settings** and press **Set up this PC**.
2. The Windows download starts and an 8-letter pairing code appears
   (works once, for 10 minutes). Press **Copy code**.
3. Open the downloaded file. Windows asks you to allow it; press **Yes**.
4. On the **Pair this PC** page, paste the code. Press **Next** until **Finished**.
5. The spoke now starts by itself whenever you sign in to Windows.

If the page says pairing codes are not switched on yet, type the hands
passphrase on that installer page instead (the owner gives it to you in
person, never in chat). macOS and Linux spokes are coming; Windows is ready.

Browsers cannot install software silently. One download plus one Windows
"allow" prompt is the shortest legitimate path.

## 3. Connect each AI

There is one road for every AI:

1. Open **Integrations**. The "Sign in to your AI" cards each carry an
   email field and a password field, right on the card. (The same two
   fields appear in the Create Custom Agent dialog when you connect an
   AI while building an agent.)
2. Type the account's email and password and press **Connect**.
3. The pair is stored in your tenant's credential vault — every read
   of it passes the Guard approval gate — and Helmian's seat for that
   AI works off that sign-in from then on. The card shows "Connected"
   once the connection is saved.

Notes per AI:

| AI | What the fields take | Notes |
| --- | --- | --- |
| Claude | Your Claude account email and password | If your account was created with Google, the fields hold your Google identity email and password; the seat performs the provider's Continue-with-Google sign-in inside the held session. |
| ChatGPT | Your ChatGPT account email and password | Same Google note, if your account is Google-born. |
| Gemini | Your Google account email and password | Gemini's sign-in is Google's sign-in; there is no separate Gemini form. |
| Grok | Your Grok account email and password | Sign in on grok.com with your account — not an X sign-in. |
| Mistral Le Chat | Your Mistral account email and password | |
| Antigravity | — | Google does not allow other apps to use Antigravity sign-in. Use Antigravity in its own app; Helmian only shows its status. |

A first connect can meet a verification step only you can pass — a
device check, a 2-Step prompt, or an emailed sign-in link. That step
belongs to the provider's own sign-in defenses; it happens once, in
the sitting, and the session is kept afterwards so you are not asked
again and again.

Settings > AI Providers shows the same connection status as the
Integrations page. It has no connect buttons of its own — connecting
happens on the cards above.

### The exposure this road carries (sources, checked Oct 29, 2026)

Signing a seat into a provider's consumer web app with the account's
own credentials is the design the owner chose; it is not hidden that
the providers' published terms were written against credential
collection and automated access by third parties. The record:

- Anthropic: third parties may not offer Claude.ai login or
  collect/route Free/Pro/Max credentials.
  <https://code.claude.com/docs/en/legal-and-compliance>
- OpenAI: "Sign in with ChatGPT" plan usage is for participating apps;
  Helmian is not a registered partner.
  <https://help.openai.com/en/articles/20001542-using-your-chatgpt-plan-in-other-apps-and-sites>
- Google: other software piggybacking on Gemini CLI / Antigravity
  OAuth is a violation and can suspend the account.
  <https://geminicli.com/docs/resources/tos-privacy/>, <https://antigravity.google/terms/>
- xAI: no published permission for third-party apps to use Grok
  sign-in; the acceptable use policy bars unauthorized automated
  access. <https://x.ai/legal/acceptable-use-policy>

The earlier roads are retired: the PC-spoke CLI sign-ins (Claude Code,
Codex, Grok CLI, Gemini CLI), the runner-vault API keys, and the cloud
OAuth pages under `/api/provider-oauth/` (Gemini, ChatGPT, and the
Grok device-code flow) — the cloud routes answer 410 since the
one-road removal pass (Bite 12, 2026-11-02).

**Governance:** Guard's human-in-the-loop Allow/Deny still gates every
credential read and every mutating PC action. That is intended.

## 4. Link Slack and Discord (Envoy)

1. Open **Team** chat and pick the channel.
2. Press **Link Discord** or **Link Slack** and follow the prompts.
3. Messages then mirror both ways. Details: `docs/TEAM_CONNECTORS.md`.

## 5. Shared memory (Scribe connector)

1. In Claude (or another app that supports custom connectors), add a custom
   connector with URL **https://connect.helmian.cloud/mcp**.
2. Sign in when it opens the Scribe page and type **your own passphrase**
   there. Never paste it into a chat.
3. Allow the tools it asks for.

## Operator settings for one-time pairing codes

| Where | Name | What |
| --- | --- | --- |
| hands server | `PAIR_CODE_ISSUER_TOKEN` | random, 32+ chars. Unset = codes off (404). |
| Vercel (helmian.cloud) | `HELMIAN_PAIR_CODE_ISSUER_TOKEN` | same value |
| Vercel (helmian.cloud) | `HELMIAN_HANDS_URL` | `https://hands.5-78-222-178.sslip.io` |

Also needed: a `spoke-v1.0.3` release with `Helmian-Spoke-Setup-1.0.3-win-x64.exe`
(the download button falls back to the newest spoke `.zip`, then the releases page).
