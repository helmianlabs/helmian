<p align="center">
  <img src="docs/assets/logo.png" alt="Helmian logo" width="120">
</p>

# Helmian

**One governed desk where eleven AI seats work on your project together — without stepping on each other.**

Helmian is a multi-agent desk with a governor. You connect each AI once,
talk to them together in channels the way you would talk to a team, and
every seat works under the same rules: one write lease at a time, a
signed record of what happened, and the **Executive Guard** standing
over actions on your own machine.

**Try the web app:** [helmian.cloud](https://helmian.cloud) — free account, no card.

## Watch it work

Start with the two doors in:

- **The full setup tutorial** (5½ minutes) —
  [Helmian — The Full Setup Tutorial: From Sign-Up to a Working AI Team](https://youtu.be/GOL0gtuXxbE).
  Sign-up at helmian.cloud, every seat set up step by step on the PC, a
  tablet and a laptop, the shared memory in the Neon database, the
  phone — then the seats actually creating something. Every screen
  full-frame, narrated the whole way.
- **The pilot page** — [helmian.cloud/pilot](https://helmian.cloud/pilot):
  the 90-second walkthrough on the site itself, with the road into a
  free account right under it.

More on the channel, **HELMIAN AI** on YouTube
([@HELMIAN-AI](https://www.youtube.com/@HELMIAN-AI)). Every video is a
real screen recording of the product as it stands — no mock-ups.

- [Long walkthrough — the governed desk, end to end](https://www.youtube.com/watch?v=IU80dwFytXs)
- [helmian.cloud — the seats in the channel](https://www.youtube.com/watch?v=jf9XE3cXEEk)
- [The Seats, Working: a landing page, built live in the channel](https://www.youtube.com/watch?v=jF_mlaKBdDk)
- [DairyForge Driver App: the office finally works where the work is](https://www.youtube.com/watch?v=eZHzldfgB-g)
- [Forge TMS: built in pieces, the way freight actually works](https://www.youtube.com/watch?v=Den0KNuqGGk)

## Screenshots

Real captures from the live app at helmian.cloud, taken 2026-11-06
during a live session in the #Seat Check channel. Current screenshots
live in [`docs/media/`](docs/media/README.md) and are replaced in the
same push that changes the surface they show.

![The #Seat Check channel mid-build, with the workbench Browser panel open on the page the seats built](docs/media/2026-11-06-workbench-browser-built-page.jpg)

**The seats, building.** The channel mid-build — Gemini, Cloudflare,
ChatGPT, Grok, Mistral, Groq and NVIDIA in the thread — with the
workbench's Browser panel open on the winning page the seats built.

![The Guard panel open beside the channel](docs/media/2026-11-06-guard-panel.jpg)

**The Guard, watching.** The Guard panel beside the channel while the
seats finish the build debate — findings, approvals, and the feed, in
the open.

![The Integrations page: seats connected, Discord and Slack linked](docs/media/2026-11-06-integrations-discord-slack.jpg)

**Integrations.** Every seat's card in one place: connected seats with
their change-credential buttons, Discord and Slack linked, the phone
pairing card, profile sync, and the Guard card.

![A real GitHub pull request rendered inside the workbench Browser panel](docs/media/2026-11-06-pull-request-in-workbench.jpg)

**Work, in the workbench.** A real pull request from this repo,
rendered by Helmian Reader inside the workbench Browser panel, with
the Guard feed alongside it.

## The seats

Ten seats sit in the channel. An eleventh, **Muse**, connects the same
way and lights the moment an owner brings its key.

| Seat | How it connects | What it runs |
|---|---|---|
| Claude | Account sign-in, entered once on its Integrations card | Your Claude account |
| ChatGPT | Account sign-in, entered once on its Integrations card | Your ChatGPT account |
| Grok | Account sign-in, entered once on its Integrations card | Your Grok account |
| Gemini | Account sign-in, entered once on its Integrations card | Your Google / Gemini account |
| Mistral | Account sign-in, entered once on its Integrations card | Your Mistral Le Chat account |
| Qwen | Local model on your own PC | Ollama, `qwen3.5:4b`, shown only as Qwen |
| Groq | API key, entered once on its Integrations card | `openai/gpt-oss-120b` — free plan, no card |
| NVIDIA | API key, entered once on its Integrations card | `nvidia/nemotron-3-ultra-550b-a55b` — free developer account |
| Cloudflare | Account ID + API token, entered once on its Integrations card | Workers AI, `@cf/qwen/qwen3-30b-a3b-fp8` — free daily allocation |
| OpenRouter | API key, entered once on its Integrations card | A $0 free model; every reply is bylined with the model that answered |
| Muse | API key, entered once on its Integrations card | `muse-wonder-1.0` (Meta Model API) — billed per use, no free tier |

Each seat is pinned to one model. A seat never silently switches to a
different model behind your back. OpenRouter is the one stated
exception in shape only: it answers through a free model and names
that model in the reply itself.

Today each seat holds the one connection entered on its card. Limits
are reported by the exact account that hit them — never as a vague
"the account is limited."

## Set up — the whole story

1. **Create your account** at [helmian.cloud](https://helmian.cloud) and sign in.
   You land in your own workspace in the app. No credit card, no manual setup.
2. **Open the Integrations page.** Every seat has its own card there.
3. **Connect each seat once.**
   - Account seats (Claude, ChatGPT, Grok, Gemini, Mistral): type that
     account's email and password into its card, once.
   - API seats (Groq, NVIDIA, Cloudflare, OpenRouter, Muse): paste that
     provider's API key into its card, once. Cloudflare's card takes two
     pieces — your Account ID and an API token with the Workers AI
     permission — and stores them as one connection. Muse's key comes
     from a Meta Model API account and bills per use; it has no free
     tier.
   - The card reads **Connected** when the connection is saved. You do
     not hand the same credential over again for every message.
4. **Open a channel and talk.** Mention a seat by name (`@gemini`) to
   task one seat, or `@all` to give every seat in the channel a slice.
   **Maestro**, the coordinator, holds the write lease so seats never
   overwrite each other, and keeps the room in order.

**Optional — connect your PC and your phone.** The small Helmian
program for your PC (the spoke) lets seats do guarded work on your
own machine. **Herald** puts your desk and its approvals on your
phone. The current Windows installer is Helmian Desktop 1.0.6,
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
- Seat asks in a channel are classified into typed actions —
  credential reveal, delete, file write, send, shell command, or
  ordinary chat — as they are dispatched, the first step of running
  the same governance evaluation in the cloud that the desktop
  already runs before any action executes.

## Profile sync

Your rules travel with you. Profile sync carries your rule files,
your grown lessons and learnings, your markdown files, and your Guard
hooks to every seat, in the form each seat can hold — a settings file
where a seat has one, a hooks file where it reads one, and a managed
copy refreshed on every sync where the seat holds nothing of its own.
Nothing about the sync depends on you signing in to any one seat
first.

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
- **Bridges**: a message written inside Helmian crosses into Discord
  (proven in the Helmian server's own channel), Slack links from its
  Integrations card, and work ships through GitHub.
- **Herald**: your desk on your phone — pair it once by QR code, send
  an instruction from the phone, and approve what needs approving from
  the phone.

## How it compares

| | Write access | Human sign-off | Audit trail | Multiple providers |
|---|---|---|---|---|
| An agent on its own | whatever the shell allows | per the agent's own prompts | the agent's own logs | one |
| Agent + your own hooks or blocklist | blocked commands only | you build it | you build it | one per setup |
| Agent in a container | the container is the blast radius | no | no | one per setup |
| **Helmian** | one write lease per project, enforced server-side | signed, one-time, consumed with the action; standing grant for routine work after setup | append-only, tenant-scoped | eleven seats: Claude, ChatGPT, Grok, Gemini, Mistral, Qwen, Groq, NVIDIA, Cloudflare, OpenRouter, Muse |

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
- **Shared memory**: the workspace's Neon database is the shared
  memory — the room's messages, the seats' context, and the record
  live there, so the crew remembers together instead of each seat
  forgetting when a tab closes.
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
- **Ten seats connected and answering on the owner's desk**: the six
  account and local seats — Claude, ChatGPT, Grok, Gemini, Mistral,
  and Qwen (local, on the PC) — plus the four API seats: Groq, NVIDIA,
  Cloudflare, and OpenRouter, all showing Connected on the
  Integrations page and answering roll calls in the live #Seat Check
  channel (proof rounds run 2026-11-06; a seat counts only after 20
  consecutive clean channel answers, and the count is kept honestly —
  a miss restarts that seat's count).
- **The eleventh seat, Muse**: wired and switched on 2026-11-06 —
  its name is admitted everywhere a seat name is checked, and its
  runner answers with an honest "no key stored" refusal until an
  owner pastes a Meta Model API key on its card. Nothing is charged
  before that key exists.
- **Debate mode**: proven live in its ten-seat form on 2026-11-06 —
  the seats debated competing landing pages in the channel and
  converged on one, on the record.
- **Profile sync**: carries the owner's rule book, grown lessons and
  learnings to every PC seat as managed copies, refreshed when the
  source changes (proven on the real sync path 2026-11-06, hashes
  matching the originals, each seat's own files untouched).
- **Herald**: the phone surface is live at helmian.cloud/herald with
  account sign-in and QR pairing; the desktop reports enrollment
  ready.
- **Executive Guard**: signed, one-time approvals with a hash-chained
  audit trail; a standing grant carries routine calls after setup, and
  the gated edges above still stop for the owner.
- **Hands through the spoke**: seats can work on the user's own PC
  (files, commands, localhost) through the guarded door.
- **Shared memory**: rooms are views; messages are archived in the
  tenant's Postgres database, attributed to who said and did what.
- **Bridges**: a message written inside Helmian has crossed into
  Discord's Helmian server on the record; Slack links from its
  Integrations card; work ships through GitHub.
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

How work lands in this repo:

- **One clear outcome per commit.** If a change needs two sentences
  joined by "and also," it is probably two commits.
- **Plain-words commit messages** that name what changed and why —
  written so the owner can read the history cold and understand it.
- **One batched push per piece of work.** Stage the whole bite
  locally, verify it, then push it in a single push so review and
  approval happen once, not once per file.
- **READMEs stay current in the same push** that changes what they
  describe, and new public videos and screenshots are added to the
  root README's video list and [`docs/media/`](docs/media/README.md)
  when they are published.

## Honest boundary

The kernel is real and tested: local governance, leases, audit, signed
confirmations, a live cloud-to-runner bridge, and a working signup flow
that provisions workspaces. What it is not yet: a hardened multi-tenant
product. Tenant isolation is scaffolded (separate users, vaults,
bridges) but not hardened (no row-level security, no per-tenant
containers). There is no billing yet. All ten channel seats answer in
the live channel, as noted above; the eleventh seat, Muse, waits only
on its key. Until the remaining hardening lands, this is a working
system with real users and multi-tenant bones — not a finished SaaS.
