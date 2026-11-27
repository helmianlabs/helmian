# New user setup (helmian.cloud)

Plain steps for a new person who wants to use Helmian with free AI
accounts. You do not need an API key to get started.

The usual path is: create your Helmian account, install Helmian on
your Windows PC, then sign in to each AI on that AI's own sign-in
page. Helmian never asks for, and never stores, your AI account
password. API keys are optional, and only for someone who already
pays for a plan and wants to use that plan's key.

## 1. Make a Helmian account

1. Open <https://helmian.cloud/get-started>.
2. Create your account. There is no card and no payment. If you
   already have an account, use the **Sign in** link in the form.
3. Your workspace opens in the web app at
   <https://helmian.cloud/app>.

## 2. Install Helmian on your PC

Seats answer once your computer is linked and at least one AI is
signed in.

1. On the Get started page, download **Helmian for Windows** (the
   current installer is Helmian-Setup-1.0.6-win-x64.exe). If the
   download did not start, get the same file from the Get started
   page or from the site's latest-release address.
2. Open the installer. Windows asks you to allow it; press **Yes**.
3. Sign in with the same Helmian account you just created.
4. Leave Helmian running. In the web app, open **Integrations**. The
   **Your PC** card turns **Online** by itself.

macOS and Linux installs are not offered yet; Windows is ready.

If you install the Helmian Spoke instead, open **Settings**, press
**Set up this PC**, and paste the 8-letter pairing code (it works
once, for 10 minutes) into the installer. Owners can type the hands
passphrase on that page instead. The current spoke installer is
`Helmian-Spoke-Setup-1.0.10-win-x64.exe`.

## 3. Sign in to your AI accounts (the main path — no API key)

Do this in the Helmian desktop app on your PC, under Settings, or
from the Spoke Start menu. Each sign-in opens that AI's own official
sign-in. You type your email and password there, not into a Helmian
form. Helmian never sees the password or the token.

You only need to sign in to the AIs you want to use.

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

When the sign-in is finished, the PC reports that seat as present.
You do not hand the same account over again for every message.

A first sign-in can meet a verification step only you can pass — a
device check, a 2-Step prompt, or an emailed sign-in link. That step
belongs to the AI's own sign-in. Finish it in the official window.

Do not type your AI account email and password into the Integrations
cards in the web app or the desktop. That old form is retired: the
connect route refuses a username or password and nothing is saved.

### Other seats that use a free account key

These seats have no official account sign-in in Helmian. You create
a free account with the provider, then paste what they give you once
on the seat's Integrations card (or the same card in the desktop
app). This is not a paid-plan API key.

| Seat | What the card takes | Where it comes from |
| --- | --- | --- |
| Groq | API key | Sign up at <https://console.groq.com>, then create a key under API Keys. Free plan, no card. |
| NVIDIA | API key | Create a free NVIDIA Developer account at <https://build.nvidia.com>, then generate an API key. |
| OpenRouter | API key | Sign up at <https://openrouter.ai>, then create a key under Keys. Models ending in `:free` cost nothing. |
| Cloudflare | Account ID and API token | Create a free account at <https://dash.cloudflare.com>, open Workers AI, copy your Account ID, then create an API token with the Workers AI permission. |

The card fields are named `api_key` (Cloudflare uses `account_id` and
`api_token`). Press **Save key**. The card reads **Connected** (or
**API key saved** on the desktop) when the connection is saved. The
key is stored in your workspace vault, not in a file on your PC and
not as an environment variable.

## 4. Open a channel and talk

1. Confirm **Your PC** is **Online** and the seats you signed in
   show as present (Synced, Connected, or the desktop sign-in
   status, such as "Using ChatGPT subscription").
2. Open a channel and talk. Mention a seat by name (`@gemini`) to
   task one seat, or `@all` to give every signed-in seat a slice. A
   message with no name goes to every seat in the channel, the same
   as `@all`.
3. After a seat answers, its card can read **Answered**.

## 5. API keys (optional, for paid plans)

Skip this section unless you already pay for a plan and want to use
that plan's key. The account sign-in in section 3 is enough for the
usual free path.

In the desktop app, each of these is labelled as a **fallback**
under Settings:

- ChatGPT: **OPENAI API KEY (fallback)**
- Claude: **ANTHROPIC API KEY (sk-ant-…, fallback)**. For a paid
  Claude plan (Pro, Max, Team, or Enterprise), you can also run
  `claude setup-token` in a terminal and paste what it prints under
  **ANTHROPIC — USE YOUR CLAUDE SUBSCRIPTION**.
- Gemini: **GOOGLE GEMINI API KEY (fallback)**
- Grok: the xAI API key under the SuperGrok sign-in, as a fallback

On the web Integrations page, the same seats also have an API key
field on the card (**Save key**, or **New API key** to replace one).
Gemini's card can also offer **Connect with Google** when that road
is switched on for the site.

Muse connects only with a Meta Model API key from
<https://dev.meta.ai> (billed per use, no free tier). Runway
connects with a key from a Runway developer account, for video and
image generation.

A key you paste is stored in the workspace vault. You do not set
environment variables on your PC for the hosted app. If you run
Helmian yourself, operator settings are in
`docs/CONFIGURATION.md`.

## 6. Link Slack and Discord (Envoy)

1. Open **Team** chat and pick the channel.
2. Press **Link Discord** or **Link Slack** and follow the prompts.
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

## 9. Plugins — bundles from the catalog

A plugin bundles a connector and its skill together in one install:

1. Open **Integrations** and go to the **Plugins** tab.
2. The catalog lists what the workspace can install. Today it holds
   **Weather** (National Weather Service forecasts, alerts, and
   current conditions, with the reading-a-forecast skill) and
   **GitHub Review** (pull-request reviews over the workspace's
   GitHub connection, with the reviewing-a-pull-request skill).
3. Press **Install** on a bundle. Its skill lands on the seat's
   shelf. Uninstall from the same tab whenever you like.

Installing a plugin is not a connection — the connector it names
still connects the ordinary way, once, on the Integrations page.

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
