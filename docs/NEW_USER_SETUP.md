# New user setup (helmian.cloud)

Plain steps for a new person (for example a demo partner) who already pays for
Claude, ChatGPT, SuperGrok, Gemini and/or Antigravity and does not want to buy
API keys. Every subscription sign-in happens through the provider's **own**
app on the user's **own** PC. Helmian never sees, stores or relays the
subscription password or token.

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

## 3. Connect each AI plan

Open the Start menu, find **Helmian Spoke**, and click the entry for each plan.
Each one opens that company's official tool in its own window; sign in there.
If the tool is missing, the window prints the one install command.

| Plan | Start menu entry | Official tool it runs | Notes |
| --- | --- | --- | --- |
| Claude Pro/Max | Sign in to Claude (your plan) | Claude Code (`claude`, then `/login`) | Allowed: you sign in to Anthropic's unmodified Claude Code. Helmian must never ask you to paste a Claude token. |
| ChatGPT Plus/Pro | Sign in to ChatGPT (your plan) | Codex CLI (`codex login`) | OpenAI's own "Sign in with ChatGPT". |
| SuperGrok | Sign in to SuperGrok (your plan) | Grok CLI (`grok login`, or `--device-auth`) | xAI's own sign-in. See the caution below. |
| Gemini | Sign in to Gemini (your Google account) | Gemini CLI (`gemini`, choose Login with Google) | Or a free Gemini API key from Google AI Studio (no charge). |
| Antigravity | none | none | Google does not allow other apps to use Antigravity sign-in. Use Antigravity in its own app. |

Same thing from a terminal in the spoke folder:
`node bin/hands-spoke.mjs providers` (shows installed / signed in) and
`node bin/hands-spoke.mjs login claude|chatgpt|grok|gemini`.

**API key fallback:** every card in Settings > AI Providers keeps **Use API key**.

### Why it is built this way (sources, checked Oct 29, 2026)

- Anthropic: third parties may not offer Claude.ai login or collect/route
  Free/Pro/Max credentials; an end user signing in to the unmodified Claude
  Code binary is allowed. <https://code.claude.com/docs/en/legal-and-compliance>
- OpenAI: "Sign in with ChatGPT" plan usage is for participating apps;
  Helmian is not a registered partner, so we run the official Codex CLI.
  <https://help.openai.com/en/articles/20001542-using-your-chatgpt-plan-in-other-apps-and-sites>
- Google: other software piggybacking on Gemini CLI / Antigravity OAuth is a
  violation and can suspend the account.
  <https://geminicli.com/docs/resources/tos-privacy/>, <https://antigravity.google/terms/>
- xAI: no published permission for third-party apps to use SuperGrok sign-in;
  the acceptable use policy bars unauthorized automated access.
  <https://x.ai/legal/acceptable-use-policy>. The older cloud "Connect Grok"
  page (`/api/provider-oauth/grok/start`) and "ChatGPT" page
  (`/api/provider-oauth/openai/start`) reuse those vendors' CLI client IDs;
  their buttons were removed from Settings and the routes should be retired
  unless the vendor approves.

**Governance:** Claude Code and Codex still show their own "allow this tool?"
prompts, and Guard's human-in-the-loop Allow/Deny still gates every mutating
PC action. That is intended.

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
