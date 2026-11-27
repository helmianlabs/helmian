# New user setup (helmian.cloud)

Plain steps for a new person who wants to use Helmian. The AI seats
are free-account seats unless a section below says otherwise.

You sign up for each AI with a username and password at that AI's
own site. How Helmian then uses the account depends on the seat, and
on whether its Integrations card already says **Connected**.

API keys are optional for a seat that is already Connected, and for
someone who already pays for a plan and wants to use that plan's
key. A brand-new connect on the website today uses the key form on
the card, described in section 3.

## 1. Make a Helmian account

1. Open <https://helmian.cloud/get-started>.
2. Create your account. There is no card and no payment. If you
   already have an account, use the **Sign in** link in the form.
3. Your workspace opens in the web app at
   <https://helmian.cloud/app>.

## 2. Install Helmian on your PC

Seats that run on your computer answer once the PC is linked.

1. On the Get started page, download **Helmian for Windows** (the
   current installer is Helmian-Setup-1.0.6-win-x64.exe). If the
   download did not start, get the same file from the Get started
   page or from the site's latest-release address.
2. Open the installer. Windows asks you to allow it; press **Yes**.
3. Sign in with the same Helmian account you just created.
4. Leave Helmian running. In the web app, open **Integrations**. The
   **Your PC** card (Devices tab) turns **Online** by itself.

macOS and Linux installs are not offered yet; Windows is ready.

If you install the Helmian Spoke instead, open **Settings**, press
**Set up this PC**, and paste the 8-letter pairing code (it works
once, for 10 minutes) into the installer. Owners can type the hands
passphrase on that page instead. The current spoke installer is
`Helmian-Spoke-Setup-1.0.10-win-x64.exe`.

## 3. Connect your AI

Open <https://helmian.cloud/app#integrations>. The page title is
**Integrations**. Under it: "Connect the things Helmian works with.
Passwords and keys are never shown here."

The tabs are **Agents**, **Devices**, **Chat and code**, and
**Account**. The AI cards live on the **Agents** tab, under the
heading **Connect your AI**.

A card that already says **Connected** has a **Manage** button. A
card that is only stamped from your PC, with no saved connection,
says **Synced · Not connected** and has a **Connect** button.

**Connected** means a saved row in the workspace connections store.
The word does not say whether that row is a username and password
saved earlier, an API key, or a Google sign-in.

### If the card already says Connected

You do not need to add a key to keep using that seat.

From 2 November 2026 through 20 November 2026 (America/Boise), the
same Integrations cards took the free account's username (email) and
password and stored them in the workspace credential vault as a
`password_session`. That is how many existing Connected seats were
first saved, including **Mistral Le Chat**.

The live app still shows those cards. The password form on the card
was removed on 20 November 2026 (commit `9ce1a8a1a1ff`). The connect
route refuses a new username or password (it answers 410). Stored
passwords were not deleted by that change. The connect route says
the box executor can still read them until a separate per-tenant
revocation.

### To connect a seat that is not yet Connected, on the website today

1. On the Agents tab, press **Connect** on the card.
2. The card opens in place. The form asks you to paste a key from
   that provider's account (Cloudflare asks for an Account ID and an
   API token). Press **Save key**.
3. Gemini's card can also offer **Connect with Google** when that
   road is switched on for the site.
4. The card does not take a username and password today.

**Manage** on a Connected card opens the same card in place and
offers **New API key** (Cloudflare: **New account number and API
key**). That is the way to replace a saved connection with a key.
It does not offer **New username and password**.

The Settings page still has leftover wording that tells you to
connect some seats with "email and password, right on its card."
That sentence is out of date. The live card form is the key form
above.

### Official account sign-in on the Windows app or Spoke (username and password on the AI's own page)

For Claude, ChatGPT, Gemini, and Grok, you can also sign in on your
PC through that AI's official login. You type your username and
password there (or use Google), not into a Helmian form. Helmian
never sees the password.

Do this in the Helmian desktop app under Settings, or from the Spoke
Start menu. You only need to sign in to the AIs you want to use.

| AI | What you press | What happens |
| --- | --- | --- |
| ChatGPT | **Login with ChatGPT** | Opens the official Codex CLI (`codex login`). Finish signing in with your ChatGPT account in that window, then press **Check again**. |
| Gemini | **Login with Google** | Opens the official Gemini CLI. Finish signing in with your Google account, then press **Check again**. |
| Grok | **Login with SuperGrok** | Opens the official Grok CLI. Press **Open browser** (or go to the address it shows), sign in with your Grok account, and enter the code. Your plan must include Grok Build. If you already signed in with the Grok CLI on this PC, press **Use existing Grok CLI session**. |
| Claude | Start menu **Sign in to Claude (your plan)**, or `hands-spoke login claude` | Opens the official Claude Code sign-in. Finish it in that window (type `/login` if it does not ask). |

The Spoke Start menu has the same official sign-ins for Claude,
ChatGPT, Gemini, and SuperGrok. From a terminal on the PC you can
also run:

```text
hands-spoke login chatgpt
hands-spoke login gemini
hands-spoke login grok
hands-spoke login claude
```

**Mistral Le Chat** is not in that official-CLI list. A new Mistral
connect on the website uses the key form on its Integrations card. A
card that already says Connected can be a username and password
saved before 20 November 2026, as described above.

A first official sign-in can meet a verification step only you can
pass — a device check, a 2-Step prompt, or an emailed sign-in link.
That step belongs to the AI's own sign-in. Finish it in the official
window.

When the sign-in is finished, the PC reports that seat as present.
Presence alone is not the same as **Connected**: a presence stamp
with no saved connection reads **Synced · Not connected**.

### Each seat

| Seat | How it signs in | Notes |
| --- | --- | --- |
| Helm | No external sign-in | Helmian-built. It is in the channel crew; it has no Integrations card. |
| Claude | Official CLI sign-in on the Windows app or Spoke (username and password on Anthropic's page), or a key on the Integrations card. A card already Connected may be a username and password saved before 20 November 2026. | Card name: Claude. |
| ChatGPT | Official CLI sign-in (**Login with ChatGPT**; username and password on OpenAI's page), or a key on the Integrations card. A card already Connected may be a username and password saved before 20 November 2026. | Card name: ChatGPT. |
| Gemini | Official CLI sign-in (**Login with Google**), or **Connect with Google** on the card when that road is on, or a key on the Integrations card. A card already Connected may be a username and password saved before 20 November 2026, or a Google sign-in. | Card name: Gemini. |
| Grok | Official CLI sign-in (**Login with SuperGrok**; username and password on xAI's page; plan must include Grok Build), or a key on the Integrations card. A card already Connected may be a username and password saved before 20 November 2026. | Card name: Grok. |
| Mistral Le Chat | No official CLI in Helmian. A new connect on the website is a key on the Integrations card. A card already Connected may be a username and password saved before 20 November 2026. | Card name: Mistral Le Chat. Channel name: Mistral. |
| Qwen | Local model on your own PC (Ollama). | In the channel crew. No Integrations card. |
| Groq | Create a free Groq account with your username and password at the provider's site, then paste an API key on the Integrations card. | Free to create, no card needed. |
| NVIDIA | Create a free NVIDIA Build account with your username and password at the provider's site, then paste an API key on the Integrations card. | Free to create. |
| Cloudflare | Create a free Cloudflare account with your username and password at the provider's site, then paste the Account ID and API token on the Integrations card. | Free daily allocation for Workers AI. |
| OpenRouter | Create a free OpenRouter account with your username and password at the provider's site, then paste an API key on the Integrations card. | Models ending in `:free` cost nothing. Replies byline the model that answered. |
| Runway | A key from a Runway developer account, on the Integrations card. | For video and image generation. If the PC has reported it but no connection is saved, the card reads **Synced · Not connected**. |
| Muse | A Meta Model API key from <https://dev.meta.ai>, on the Integrations card. | Bills by use, no free tier. If the PC has reported it but no connection is saved, the card reads **Synced · Not connected**. |

Where a new connect on the website uses a key, the card fields are
named `api_key` (Cloudflare uses `account_id` and `api_token`). The
key is stored in your workspace vault, not in a file on your PC and
not as an environment variable.

## 4. Open a channel and talk

The channel crew can include Helm, Claude, ChatGPT, Grok, Gemini,
Mistral, Qwen, Groq, NVIDIA, Cloudflare, and OpenRouter — the seats
that are in the room. Runway and Muse have Integrations cards as
well.

1. Confirm **Your PC** is **Online** if you are using official CLI
   sign-in or Qwen on that PC.
2. Open a channel and talk. Mention a seat by name (`@gemini`) to
   task one seat, or `@all` to give every signed-in seat a slice. A
   message with no name goes to every seat in the channel, the same
   as `@all`.
3. After a seat answers, its card can read **Answered**. Answered is
   not the same as Connected.

## 5. API keys (optional, for paid plans)

Skip this section unless you already pay for a plan and want to use
that plan's key, or you want to replace an earlier connection with a
key.

In the desktop app, each of these is labelled as a **fallback**
under Settings:

- ChatGPT: **OPENAI API KEY (fallback)**
- Claude: **ANTHROPIC API KEY (sk-ant-…, fallback)**. For a paid
  Claude plan (Pro, Max, Team, or Enterprise), you can also run
  `claude setup-token` in a terminal and paste what it prints under
  **ANTHROPIC — USE YOUR CLAUDE SUBSCRIPTION**.
- Gemini: **GOOGLE GEMINI API KEY (fallback)**
- Grok: the xAI API key under the SuperGrok sign-in, as a fallback

On the web Integrations page, press **Manage** on a Connected card
and then **New API key** (or **Connect** and **Save key** on a card
that is not connected). Gemini's card can also offer **Connect with
Google** when that road is switched on for the site.

A key you paste is stored in the workspace vault. You do not set
environment variables on your PC for the hosted app. If you run
Helmian yourself, operator settings are in
`docs/CONFIGURATION.md`.

## 6. Link Slack and Discord (Envoy)

1. Open **Integrations**, then the **Chat and code** tab.
2. Press **Link a channel** on Discord or Slack and follow the
   prompts. You can also start this from **Team** chat.
3. Messages then mirror both ways. Details: `docs/TEAM_CONNECTORS.md`.

## 7. Shared memory — nothing to connect

Shared memory is built into Helmian. There is no connector to add,
no passphrase, and nothing to install:

- Your workspace has its own shared notebook in Helmian's database
  (Neon Postgres). Every seat reads the same notebook in its prompt
  when it answers: at most 40 lines per section, at most 300
  characters per line, and at most 6,000 characters in total. Seats
  do not write the notebook themselves.
- **The Librarian** keeps it. It files a short record of every ask
  the desk is given, and files an ask the Guard refused as an open
  incident. The seats recall the notebook automatically when they
  answer. The Librarian's solve and re-file operations exist and
  are tested, but no shipped surface calls them yet, so fixes and
  solutions are not filed automatically today.
- This memory is Helmian's own. Scribe is a separate product and is
  not part of Helmian.

## 8. Voice — talk instead of typing

Press the **Voice** button in a channel and talk. Replies are spoken
aloud, each seat in its own voice, and the conversation is two-way:
stop talking and your message goes.

The voices are made by Kokoro, a speech model. The app first asks
Helmian's own Kokoro voice server (the reply text goes there and
audio comes back); if that is unavailable, Kokoro runs in your own
browser tab, and if the local model cannot load, the browser's
built-in speech covers as a labelled backup.

## 9. Plugins

Plugins are not an Integrations tab. They attach from the composer
(the **Plugins** group) and live on your PC bridge. Attaching one
gives the agent its approved tools for that turn. Installing or
connecting the underlying service still happens the ordinary way
(a GitHub link from Chat and code, and so on).

## Operator settings for one-time pairing codes

These are for the person who runs the hands server, not for a new
user on helmian.cloud.

| Where | Name | What |
| --- | --- | --- |
| hands server | `PAIR_CODE_ISSUER_TOKEN` | random, 32+ chars. Unset = codes off (404). |
| Vercel (helmian.cloud) | `HELMIAN_PAIR_CODE_ISSUER_TOKEN` | same value |
| Vercel (helmian.cloud) | `HELMIAN_HANDS_URL` | `https://<hands-host>` |

Also needed for the spoke path: a `spoke-v1.0.10` release with
`Helmian-Spoke-Setup-1.0.10-win-x64.exe` (the version the repo's
spoke installer script, `spoke-installer/HelmianSpoke.iss`, carries;
the download button falls back to the newest spoke `.zip`, then the
releases page).
