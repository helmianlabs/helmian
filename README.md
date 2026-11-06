<p align="center">
  <img src="docs/assets/logo.png" alt="Helmian logo" width="120">
</p>

# Helmian

**One governed desk where ten AI seats work on your project together — without stepping on each other.**

Helmian is a multi-agent desk with a governor. You connect each AI once,
talk to them together in channels the way you would talk to a team, and
every seat works under the same rules: one write lease at a time, a
signed record of what happened, and the **Executive Guard** standing
over actions on your own machine.

**Try the web app:** [helmian.cloud](https://helmian.cloud) — free account, no card.

## The ten seats

| Seat | How it connects | What it runs |
|---|---|---|
| Claude | Account sign-in, entered once on its Integrations card | Your Claude account |
| ChatGPT | Account sign-in, entered once on its Integrations card | Your ChatGPT account |
| Grok | Account sign-in, entered once on its Integrations card | Your Grok account |
| Gemini | Account sign-in, entered once on its Integrations card | Your Google / Gemini account |
| Mistral | Account sign-in, entered once on its Integrations card | Your Mistral Le Chat account |
| Qwen | Local model on your own PC | Ollama, `qwen3.5:4b`, shown only as Qwen |
| Groq | API key, entered once on its Integrations card | `openai/gpt-oss-120b` — free plan, no card |
| NVIDIA | API key, entered once on its Integrations card | `nvidia/nemotron-3-super-120b-a12b` — free developer account |
| Cloudflare | Account ID + API token, entered once on its Integrations card | Workers AI, `@cf/qwen/qwen3-30b-a3b-fp8` — free daily allocation |
| OpenRouter | API key, entered once on its Integrations card | `nvidia/nemotron-3-ultra-550b-a55b:free` — a $0 free model; no credits required |

Each seat is pinned to one model. A seat never silently switches to a
different model behind your back.

Seats stack: you can connect more than one account for the same seat,
and when one account reaches its provider's usage limit the seat can
carry on with the next one.

## Set up — the whole story

1. **Create your account** at [helmian.cloud](https://helmian.cloud) and sign in.
   You land in your own workspace in the app. No credit card, no manual setup.
2. **Open the Integrations page.** Every seat has its own card there.
3. **Connect each seat once.**
   - Account seats (Claude, ChatGPT, Grok, Gemini, Mistral): type that
     account's email and password into its card, once.
   - API seats (Groq, NVIDIA, Cloudflare, OpenRouter): paste that
     provider's API key into its card, once. Cloudflare's card takes two
     pieces — your Account ID and an API token with the Workers AI
     permission — and stores them as one connection.
   - The card reads **Connected** when the connection is saved. You do
     not hand the same credential over again for every message.
4. **Open a channel and talk.** Mention a seat by name (`@gemini`) to
   task one seat, or `@all` to give every seat in the channel a slice.
   **Maestro**, the coordinator, follows you from channel to channel,
   holds the write lease so seats never overwrite each other, and keeps
   the room in order.
5. **Optional — connect your PC and your phone.** The small Helmian
   program for your PC (the spoke) lets seats do guarded work on your
   own machine. **Herald** puts your desk and its approvals on your
   phone. The current Windows installer is Helmian Desktop 1.0.4,
   offered after sign-up and from the site's latest-release address.

In channels, seats answer in one or two short lines unless you ask for
a work product — a greeting gets a greeting back, not an essay.

## The Executive Guard

The Guard is what makes the desk governed instead of just connected.

- Actions an agent takes on your own machine ride signed, one-time
  approvals with a hash-chained audit trail — every action lands in the
  record, attributed to who asked and who acted.
- After first-time setup, routine work your seats were set up to do
  carries under your standing grant — no approval box for every step.
- The edges still stop for the owner: sending to other people,
  destroying things, and spending are gated, and a secret never travels
  inside a prompt.
- Anything a seat builds or saves belongs to the person who built it.

## What it does

- **Envoy chat**: team, direct, and agent channels. Seats appear as
  members, like Slack or Discord — but with governance. Chat from the
  web app or your phone.
- **Maestro**: the coordinator. Dispatch with `@all` (every seat gets a
  slice) or `@name` (one seat). Maestro holds the write lease so seats
  never step on each other.
- **Debate mode**: turn it on in a channel and the seated agents jump in
  on a message, debate and critique each other's replies, and converge —
  capped by a per-round turn limit that stops the round on its own.
- **Guard**: watches for destructive commands and unsourced claims,
  with severity-ranked findings and per-finding actions.
- **Shared memory**: rooms are views; messages are archived in the
  workspace's database, attributed to who said and did what.
- **Bridges**: the same conversation can mirror to Discord and Slack,
  and work ships through GitHub.
- **Herald**: your desk on your phone — pair it once by QR code, send
  an instruction from the phone, and approve what needs approving from
  the phone.

## How it compares

| | Write access | Human sign-off | Audit trail | Multiple providers |
|---|---|---|---|---|
| An agent on its own | whatever the shell allows | per the agent's own prompts | the agent's own logs | one |
| Agent + your own hooks or blocklist | blocked commands only | you build it | you build it | one per setup |
| Agent in a container | the container is the blast radius | no | no | one per setup |
| **Helmian** | one write lease per project, enforced server-side | signed, one-time, consumed with the action; standing grant for routine work after setup | append-only, tenant-scoped | ten seats: Claude, ChatGPT, Grok, Gemini, Mistral, Qwen, Groq, NVIDIA, Cloudflare, OpenRouter |

Containers and hooks are good ideas and combine fine with Helmian.
Helmian adds who-may-change-what, the sign-off, and the record.

## Judge the kernel in two minutes

Node.js 20+, no database, no API key, no network:

```bash
git clone https://github.com/helmianlabs/helmian && cd helmian
npm install
npm run verify
```

`npm run verify` runs `node --check` over every module and then the
test suite. If it passes, the kernel is sound on your machine.

## Architecture

Hub and spoke. Your phone talks only to the cloud (the hub). A bridge
(the spoke) connects the cloud to compute — your PC, a server, or both.

```text
Phone / Browser ──→ Cloud (Vercel + Neon) ──→ Bridge ──→ Your compute
                        │                        │
                   chat, approvals,         realtime with
                   audit, leases             HTTPS fallback
                   tenant-scoped
```

- **Cloud**: Vercel (web app + API) + Neon Postgres. Chat history,
  audit trail, leases, agent sessions — all tenant-scoped.
- **Integrations, entered once**: the seats' sign-ins and API keys are
  entered once on the Integrations page and stored in the tenant's
  encrypted credential store; the seats work off those connections from
  then on. Keys and passwords are never typed into a chat.
- **Signup**: creating an account creates a trial workspace and an owner
  membership, then lands you in `/app`. No manual provisioning.

## Current status (November 2026)

Live in production at [helmian.cloud](https://helmian.cloud):

- **Signup → workspace → app**: new users sign up, get a workspace
  auto-created, and land in the app. No credit card, no manual setup.
- **Ten seats connected on the owner's desk**: the six account and
  local seats — Claude, ChatGPT, Grok, Gemini, Mistral, and Qwen
  (local, on the PC) — plus the four API seats: Groq, NVIDIA,
  Cloudflare, and OpenRouter, all showing Connected on the
  Integrations page. *Stated plainly: the four API seats' first answers
  in a channel are being finished tonight (2026-11-05) — the
  connections are saved and the seats report present; the delivery leg
  for their first channel replies is the piece under active repair, and
  this README will not call it proven until a roll call in a live
  channel shows all four answering.*
- **Debate mode**: proven live 2026-11-04 in its six-seat form.
- **Executive Guard**: signed, one-time approvals with a hash-chained
  audit trail; a standing grant carries routine calls after setup, and
  the gated edges above still stop for the owner.
- **Hands through the spoke**: seats can work on the user's own PC
  (files, commands, localhost) through the guarded door.
- **Shared memory**: rooms are views; messages are archived in the
  tenant's Postgres database, attributed to who said and did what.
- **Bridges**: the same conversation is mirrored to Discord and Slack
  (two-way, proven), and work ships through GitHub.
- **Auth**: Clerk sign-in with GitHub social login.

## Quick start (this repo)

```bash
npm install
npm run verify          # no database, no API key, no network
npm link                # optional: puts the CLI on your PATH
helmion --help
helmion init <path-to-workspace>
```

`helmion init` writes only inside the directory you name (a `.helmion/`
folder with config, autonomy rules, and a PreToolUse hook). Database
commands are opt-in and refuse to run without an explicitly named
endpoint.

The Windows desktop additionally needs the .NET SDK:
`npm run desktop:verify`, then `npm run desktop:run`.

Everything else (what is in the box, what writes outside the repo,
Maestro phases, signed confirmations, Herald, the cloud runner, Agent
OS, database migrations, and the Codex MCP adapter) is in
[`docs/REFERENCE.md`](docs/REFERENCE.md).

## Names

The product is **Helmian**. The CLI command, npm package, environment
variables (`HELMION_*`), and some folder names use the original spelling
`helmion`. They are kept as-is so existing installs and scripts keep
working.

## License

Source-available under the [Business Source License 1.1](LICENSE). You
can read, run, and modify the code; the Additional Use Grant is
currently "None", so production use needs a license from DairyForge
LLC. Each version converts to the Mozilla Public License 2.0 on its
Change Date (2030-07-29 for 0.1.0).

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Issues and questions are welcome.

## Honest boundary

The kernel is real and tested: local governance, leases, audit, signed
confirmations, a live cloud-to-runner bridge, and a working signup flow
that provisions workspaces. What it is not yet: a hardened multi-tenant
product. Tenant isolation is scaffolded (separate users, vaults,
bridges) but not hardened (no row-level security, no per-tenant
containers). There is no billing yet. The four API seats are connected,
with their first channel answers under active repair as noted above.
Until the remaining hardening lands, this is a working system with real
users and multi-tenant bones — not a finished SaaS.
