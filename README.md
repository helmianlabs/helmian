<p align="center">
  <img src="docs/assets/logo.png" alt="Helmian logo" width="120">
</p>

# Helmian

**Run Claude, ChatGPT, Grok and Gemini on one project without them stepping on each other.**

One agent holds write access to a project at a time, a human signs off on
risky steps, and every action lands in an audit trail. Supporting pieces:
**Guard** flags destructive commands and unsourced claims, **Maestro**
coordinates the agents, and **Herald** puts approvals on your phone.

![Helmian workbench: four seats answering in one room](docs/assets/desktop-4panel.jpg)

![The Helmian cockpit on helmian.cloud: four seats linked under the Maestro coordinator, Guard armed](https://workspace.5-78-222-178.sslip.io/readme-assets/shot-landing-cockpit.png)

*The cockpit at [helmian.cloud](https://helmian.cloud), captured 2026-11-04 — the
same four seats (Claude, ChatGPT, Grok, Gemini) that answer together in the
Maestro desk below.*

**Judge it in two minutes** (Node.js 20+, no database, no API key, no network):

```bash
git clone https://github.com/helmianlabs/helmian && cd helmian
npm install
npm run verify
```

`npm run verify` runs `node --check` over every module and then the test suite.
If it passes, the kernel is sound on your machine.

**Try the web app:** [helmian.cloud](https://helmian.cloud) (free account, no
card). The Windows installer (Helmian-Setup-1.0.3) is available after sign-up.

![Create your free account — the get-started page at helmian.cloud, captured 2026-11-04](https://workspace.5-78-222-178.sslip.io/readme-assets/shot-get-started.png)

**Watch it:** [Guard review, 43 s](https://helmian.cloud/media/helmian-guard-review.mp4) ·
[Desktop overview, 5 min](https://helmian.cloud/media/helmian-desktop-overview.mp4) ·
[Four providers on one project, 7 min](https://helmian.cloud/media/helmian-project-flow.mp4)

**Recorded with the capture rig, 2026-11-04:**
[Landing page tour, 34 s](https://workspace.5-78-222-178.sslip.io/readme-assets/demo-landing-tour.mp4) ·
[Get-started page, 16 s](https://workspace.5-78-222-178.sslip.io/readme-assets/demo-get-started.mp4) —
the public pages exactly as a visitor sees them.

What it does **not** do yet is stated plainly in [Honest boundary](#honest-boundary).

## What it does

- **Envoy chat**: team, direct, and agent channels. Agents appear as members,
  like Slack or Discord — but with governance. Chat from the web app or your
  phone; the bridge answers even with your PC off.
- **Maestro**: the coordinator. Dispatch work with `@all` (every agent gets a
  slice) or `@name` (target one agent). The Maestro holds the write lease so
  agents never step on each other.
- **Guard**: watches AI output for destructive commands and unsourced claims.
  Severity-ranked findings with ack, quarantine, and per-finding actions.
  Acked criticals stay visible — a re-sighting clears the ack.
- **Bring your own everything**: your AI subscriptions (OAuth or API key),
  your Neon database, your runner. The cloud never holds provider keys —
  presence-only. Your keys live in an AES-256-GCM vault on your runner.


## How it compares

| | Write access | Human sign-off | Audit trail | Multiple providers |
|---|---|---|---|---|
| An agent on its own | whatever the shell allows | per the agent's own prompts | the agent's own logs | one |
| Agent + your own hooks or blocklist | blocked commands only | you build it | you build it | one per setup |
| Agent in a container | the container is the blast radius | no | no | one per setup |
| **Helmian** | one write lease per project, enforced in Postgres | signed, one-time, consumed with the action | append-only, tenant-scoped | Claude, ChatGPT, Grok, Gemini |

Containers and hooks are good ideas and combine fine with Helmian. Helmian adds
who-may-change-what, the sign-off, and the record.

## Demo videos

The recordings above are also on [helmian.cloud](https://helmian.cloud/#demos).
Scripts and post copy live in [`docs/demos/`](docs/demos/).

## Architecture

Hub and spoke. Your phone talks only to the cloud (the hub). A bridge (the
spoke) connects the cloud to compute — your PC, a Hetzner box, or both.

```text
Phone / Browser ──→ Cloud (Vercel + Neon) ──→ Bridge ──→ Your compute
                        │                        │
                   chat, approvals,         Ably realtime
                   audit, leases             (HTTPS fallback)
                   tenant-scoped
```

- **Cloud**: Vercel (web app + API) + Neon Postgres (AWS US West 2). Chat
  history, audit trail, leases, agent sessions — all tenant-scoped. The
  cloud never holds provider API keys.
- **Bridge** (`bin/pc-bridge.mjs`): pairs once, subscribes to cloud chat over
  Ably with HTTPS polling fallback, runs a local agent to answer. Live on a
  Hetzner box (Hillsboro OR, next to Neon) — replies land in about a second,
  PC off.
- **Credential vault** (`src/runner/vault.mjs`): per-user AES-256-GCM on the
  runner. Key derives from the bridge's device token. Provider keys never
  transit the cloud.
- **Signup** (`src/cloud/signup.mjs`): `POST /api/signup` creates a trial
  tenant + owner membership for a new Clerk user, then the app redirects to
  `/app`. No manual provisioning.
- **Provider OAuth** (`src/cloud/user-oauth.mjs`): user-level OAuth (Gemini
  via Google today). The token goes to the browser — the user stores it in
  their runner vault. The cloud never persists it.


## Current status (November 2026)

Live in production at [helmian.cloud](https://helmian.cloud):

- **Signup → trial → app**: new users sign up at `/get-started`, get a trial
  workspace auto-created, land in `/app`. No credit card, no manual setup.
- **Four of the five seats are live in the room** (proven 2026-11-04):
  Grok, ChatGPT and Gemini answer from the server; Claude answers from the
  user's own PC through the spoke, invisibly — no windows, no per-call
  consent prompts. The fifth seat (Mistral) is in progress.
- **Free-Willy debate mode**: proven live 2026-11-04. Turn it on in a
  channel and the seated agents jump in on a message, debate and critique
  each other's replies, and converge — capped by a per-round turn limit
  that stops the round on its own.
- **Executive Guard**: agent actions on a user's machine ride signed,
  one-time approvals with a hash-chained audit trail. A standing grant can
  carry routine calls; anything destructive still stops for the owner.
- **Hands through the spoke**: agents can work on the user's own PC
  (files, PowerShell, localhost) through the guarded door — proven live
  2026-11-04 with a page built on the server and served from the PC.
- **Shared memory**: rooms are views; messages are archived in the
  tenant's Postgres database, attributed to who said and did what.
- **Bridges**: the same conversation is mirrored to Discord and Slack
  (two-way, proven), and work ships through GitHub.
- **Provider connections**: seats run on the customer's own subscriptions
  and sign-ins; API keys are an option, never the default. The cloud shows
  presence only and never holds provider passwords in the clear — the
  credential vault is envelope-encrypted.
- **Auth**: Clerk sign-in with GitHub social login.

## Quick start

```bash
npm install
npm run verify          # no database, no API key, no network
npm link                # optional: puts the CLI on your PATH
helmion --help
helmion init <path-to-workspace>
```

`helmion init` writes only inside the directory you name (a `.helmion/` folder
with config, autonomy rules, and a PreToolUse hook). Database commands are
opt-in and refuse to run without an explicitly named endpoint.

The Windows desktop Pilot additionally needs the .NET SDK:
`npm run desktop:verify`, then `npm run desktop:run`.

Everything else (what is in the box, what writes outside the repo, Maestro
phases, signed confirmations, Herald, the cloud runner, Agent OS, database
migrations, and the Codex MCP adapter) is in
[`docs/REFERENCE.md`](docs/REFERENCE.md).

## Names

The product is **Helmian**. The CLI command, npm package, environment
variables (`HELMION_*`), and some folder names use the original spelling
`helmion`. They are kept as-is so existing installs and scripts keep working.

## License

Source-available under the [Business Source License 1.1](LICENSE). You can
read, run, and modify the code; the Additional Use Grant is currently "None",
so production use needs a license from DairyForge LLC. Each version converts
to the Mozilla Public License 2.0 on its Change Date (2030-07-29 for 0.1.0).

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Issues and questions are welcome.

## Honest boundary

The kernel is real and tested: local governance, leases, audit, signed
confirmations, a live cloud-to-runner bridge, four of the five agent seats
answering in one room, and a working signup flow that provisions trial
workspaces. What it is not yet: a hardened multi-tenant product. Tenant
isolation is scaffolded (separate users, vaults, bridges) but not hardened
(no row-level security, no per-tenant containers). The fifth seat (Mistral)
is not live yet. There is no billing yet. Until those land, this is a
working system with real users and multi-tenant bones — not a finished
SaaS.
