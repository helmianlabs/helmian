<p align="center">
  <img src="docs/assets/logo.png" alt="Helmian logo" width="120">
</p>

# Helmian

**Run Claude, ChatGPT, Grok and Gemini on one project without them stepping on each other.**

One agent holds write access to a project at a time, a human signs off on
risky steps, and every action lands in an audit trail. Supporting pieces:
**Guard** flags destructive commands and unsourced claims, **Maestro**
coordinates the agents, and **Herald** puts approvals on your phone.
**Scribe** is the separate shared-memory companion: connected assistants can
leave and retrieve full messages for each other instead of starting from zero.

![Helmian desktop: Room, Console, Agents, and Guard panels](docs/assets/desktop-4panel.jpg)

**Judge it in two minutes** (Node.js 20+; the verify step needs no database,
API key, or network):

```bash
git clone https://github.com/helmianlabs/helmian && cd helmian
npm install
npm run verify
```

`npm run verify` runs `node --check` over every module and then the test suite.
If it passes, the kernel is sound on your machine.

**Try the web app:** [helmian.cloud](https://helmian.cloud) (free account, no
card). That is the start-here path today. The Windows desktop Pilot is a
source/developer run for now (see Quick start); a one-download Windows
installer has not been published yet.

**Watch it:** [Guard review, 43 s](https://helmian.cloud/media/helmian-guard-review.mp4) ·
[Desktop overview, 5 min](https://helmian.cloud/media/helmian-desktop-overview.mp4) ·
[Four providers on one project, 7 min](https://helmian.cloud/media/helmian-project-flow.mp4)

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
- **Scribe (separate companion)**: shared memory and a post office for
  connected AI assistants, so a handoff can carry the full message instead of
  a short summary.
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


## Current status (October 2026)

Live in production at [helmian.cloud](https://helmian.cloud):

- **Signup → trial → app**: new users sign up at `/get-started`, get a trial
  workspace auto-created, land in `/app`. No credit card, no manual setup.
- **Provider connections**: in the web app, Gemini offers OAuth ("Login with
  Google"); Claude, ChatGPT, and Grok currently connect by API key
  (`node bin/runner-vault.mjs store <name>`). Cloud shows presence only.
- **Bridge live on Hetzner**: cloud publishes over Ably, runner answers
  through Gemini, replies in ~1 second. Works with the PC off.
- **Cloud chat**: team/direct/agent channels, human approval gates, audit
  trail, leases, all tenant-scoped in Neon.
- **Auth**: Clerk sign-in with GitHub social login (the production Clerk
  instance is live on helmian.cloud).
- **Desktop ↔ web parity**: the web app matches the desktop Pilot panel by
  panel (Room, Console, Agents, Guard). Sliding panels, drag splitters,
  hover-expand sidebar — built from the actual EXE source.


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

The Windows desktop Pilot additionally needs the .NET 10 SDK:
`npm run desktop:verify`, then `npm run desktop:run`. See
[`desktop/README.md`](desktop/README.md) for the desktop layout and finish
lists.

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
confirmations, a live cloud-to-runner bridge answering chat through Gemini,
and a working signup flow that provisions trial workspaces. What it is not
yet: a hardened multi-tenant product. Tenant isolation is scaffolded
(separate users, vaults, bridges) but not hardened (no row-level security,
no per-tenant containers). Only Gemini has a working OAuth flow; Claude,
ChatGPT, and Grok are API-key only for now. There is no billing yet.
Discord, Slack, and GitHub integrations are not built. Until those land,
this is a working system with real users and multi-tenant bones — not a
finished SaaS.
