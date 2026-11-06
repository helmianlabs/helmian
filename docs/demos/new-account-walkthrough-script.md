# New-Account Walkthrough — Screen-Record Script

**Purpose:** one honest film of the exact road a brand-new person
travels: land on helmian.cloud, create an account, sign in, connect
seats on the Integrations page, open a channel, send a first message,
and watch seats answer. Nothing staged that a real new account would
not see. Nothing faked: if a beat does not happen on camera, the film
does not claim it happened.

**Product:** Helmian — helmian.cloud
**Target length:** 3–4 minutes, one continuous take per beat, cut
between beats only.
**Voice:** narration over the recording, recorded after the picture is
locked. No branding in the picture, the narration, the title, the
description, or the file metadata beyond the business itself: the film
is Helmian's, full stop.

---

## Before anyone presses record — gates

Do not record until every gate below is green. A walkthrough filmed
over a broken beat teaches the viewer a lie and has to be thrown away.

- [ ] **GATE A — API-seat first answer proven live (HOLD).** The four
  API seats (Groq, NVIDIA, Cloudflare, OpenRouter) are Connected on the
  Integrations page, but on 2026-11-05 their first answers in a channel
  failed within seconds — the server logs showed the runner-side key
  store empty while the website store held the keys (the key-sync
  break). **Beats 6 and 9 below MUST NOT be recorded until the key-sync
  fix is deployed and a live roll call in a real channel shows the API
  seat answering.** Proof standard: the seat's own reply text visible
  in the channel, in the same session, not a status line.
- [ ] **GATE B — Account-seat first answer proven in a fresh workspace.**
  The account seat used on camera (Beat 5 / Beat 8) answers a `@name`
  message in a newly created workspace, proven in a rehearsal run with
  the same demo account the film will use.
- [ ] **GATE C — Fresh demo accounts ready.** A brand-new Helmian
  account (created for this film, not the owner's working account) and
  demo sign-ins for the seats being connected, whose credentials are
  never shown on camera (see Privacy below). Do not film the owner's
  real accounts, real channels, or real work.
- [ ] **GATE D — Clean screen.** Fresh browser profile, no bookmarks
  bar clutter, no notifications, no other tabs, window at 1280×720 or
  larger, system clock and desktop out of frame.

## Privacy and safety rules for the recording

- Passwords and API keys are **never visible on camera**. When a beat
  reaches a password or key field: cut away, or paste while the field
  is off-screen / masked, then cut back to the filled card after
  **Connect** is pressed. The viewer sees the card and the button —
  never the secret.
- No real email addresses of real people on camera; the demo accounts
  are made for this film.
- No approval popups mid-take by design: stage any connector or system
  prompts before the take, and record in one sitting per beat so
  nothing interrupts the person narrating.

---

## Shot list

### Beat 1 — The front door (0:00–0:20)

- **Picture:** Open `https://helmian.cloud`. Slow scroll of the landing
  page: what Helmian is, the seats, the Guard.
- **Narration (draft):** "This is Helmian. One desk where your AI seats
  work together — under a governor, with a record of everything they
  do. Here's the whole setup, starting from nothing."

### Beat 2 — Create the account (0:20–0:45)

- **Picture:** Press the create-account / get-started control. Fill the
  sign-up form with the demo email. Enter the emailed code if the flow
  asks for one.
- **Narration:** "Create an account. No card. Helmian makes your
  workspace for you."
- **Note:** If the live flow's sign-up link sits on the sign-in page on
  recording day, film the road exactly as it is that day — do not
  describe a button that is not on screen.

### Beat 3 — First sign-in, landing in the app (0:45–1:00)

- **Picture:** Sign in. The app opens in the new workspace. Pause two
  seconds on the empty desk so the viewer sees the starting state.
- **Narration:** "Sign in, and you're in your own workspace. No seats
  connected yet — that's the next minute."

### Beat 4 — The Integrations page (1:00–1:20)

- **Picture:** Open **Integrations**. Slow pass down the seat cards:
  Claude, ChatGPT, Grok, Gemini, Mistral, Qwen, Groq, NVIDIA,
  Cloudflare, OpenRouter — each card showing its connect fields and
  its not-connected state.
- **Narration:** "Every seat connects here, on its own card, exactly
  once. Account seats take the account's sign-in. API seats take a
  key. After that, the seats work — you don't hand anything over
  again."

### Beat 5 — Connect one account seat (1:20–1:50) — needs GATE B

- **Seat on camera: Gemini** (the account road proven answering in
  rehearsal; ChatGPT is the alternate if rehearsal says so).
- **Picture:** On the Gemini card: type the demo account's email,
  paste the password off-camera (cutaway rule), press **Connect**.
  Hold on the card flipping to **Connected**.
- **Narration:** "Gemini connects with its account sign-in, entered
  once, right on the card. Connected."

### Beat 6 — Connect one API-key seat (1:50–2:20) — **HOLD: needs GATE A**

- **Seat on camera: Groq** — one key field, the simplest API road, and
  its free plan needs no card. (Cloudflare is *not* the filmed example:
  its card takes two pieces — Account ID plus API token — and is named
  in narration instead, so the film stays simple.)
- **Picture:** Before the take, create the demo key at
  console.groq.com under API Keys. On camera: open the Groq card,
  paste the key while masked / off-screen, press **Connect** (the
  pasted value is never readable in any frame). Hold on **Connected**.
- **Narration:** "Groq is an API seat. One key, pasted once. Cloudflare
  works the same way with two pieces — its account ID and a token.
  NVIDIA and OpenRouter are one key each. All four are free to start,
  and OpenRouter's seat runs a free model that costs nothing."

### Beat 7 — Open a channel and add the seats (2:20–2:40)

- **Picture:** Open a channel in the new workspace. Add the two
  connected seats (Gemini and Groq) to the channel from the channel's
  agent list. Maestro is present in the room.
- **Narration:** "Open a channel, add your seats, and talk to them
  like a team. Maestro — the coordinator — is in every room, holding
  the order."

### Beat 8 — First message, account seat answers (2:40–3:05) — needs GATE B

- **Picture:** Type, on camera:
  `@gemini roll call — one line: your name and what you are.`
  Wait for the real reply. Hold on it.
- **Narration:** "First message. One line back — that's the house
  style here. Short answers in the channel; long work only when you
  ask for it."
- **Honesty rule:** the take is the real wait, sped up in the edit only
  if the on-screen clock/edit makes that plain (a visible cut is fine;
  a silent speed-up presented as real-time is not).

### Beat 9 — First message, API seat answers (3:05–3:30) — **HOLD: needs GATE A**

- **Picture:** Type, on camera:
  `@groq roll call — one line: your name and the model you are running.`
  Wait for the real reply — the pinned model named in its own line is
  the proof this beat exists for. Hold on it.
- **Narration:** "And the API seat answers for itself — its name, and
  the one model it is pinned to. No silent model-switching, ever."

### Beat 10 — Close: what just happened, and the Guard (3:30–3:55)

- **Picture:** Back to the channel with both replies on screen. If the
  demo workspace offers a clean Guard surface without exposing real
  work, a two-second pass over it; otherwise stay on the channel.
- **Narration:** "From nothing to two seats answering in one room —
  that's the whole road: account, Integrations, connect once, talk.
  Everything they do from here runs under the Executive Guard, with a
  signed record. Helmian — helmian.cloud."

---

## Beats on hold, in one place

| Beat | What it shows | Held until |
|---|---|---|
| 6 | Groq API key pasted on its card → Connected | Key-sync fix deployed **and** a live channel roll call proves the API seat answers (Gate A) |
| 9 | `@groq` first message answered in-channel | Same Gate A proof — Connected alone is not proof |

Beats 1–5, 7, 8, and 10 can be rehearsed now; the film is not finished
until 6 and 9 are recorded for real. Do not publish a cut that ends at
Beat 8 and implies the API road was shown.

## After the recording

1. Watch the full cut end to end before it goes anywhere — check every
   frame for a visible secret, a stray notification, or any branding
   that is not Helmian's.
2. Strip file metadata from the exported video before upload.
3. The film's public home (GitHub README link and/or helmian.cloud
   media) is one batched publish step, released by main on the owner's
   word — not uploaded piecemeal from the recording session.
