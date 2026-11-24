# Helmian Vet Sandbox — Audit

**Date:** 2026-11-23 (America/Denver) · **Mode:** read-only audit. Nothing was submitted to the sandbox, nothing installed, no config, container, or file on the box was changed. The only live probes were the service's own read-only endpoints (`GET /health`, `GET /runs/:id`).
**Design reference:** `~/workspace/your_files/hetzner-sandbox-design.md` (the build's own design doc, §9 records its Oct 22 proof runs).

**Troy's design, in his words (2026-11-23):** anything coming into an agent or into Helmian — GitHub, GitLab, anywhere on the internet, any MCP server, any download meant for AIs — lands in a sandbox first; Helmian goes through it for anything harmful or bad and any code that needs tweaking; only then can it be installed.

---

## 1. What the vet sandbox is

A small, dependency-free Node HTTP service whose only job is to execute foreign code safely and return a verdict with evidence. It **never approves and never installs anything** (server.mjs header comment, and the code has no install path).

**Container (verified by `docker inspect`, 2026-11-23):**

| Fact | Value |
|---|---|
| Container | `helmian-vet-sandbox`, image `helmian-vet-sandbox:0.2.4` |
| Command | `node /app/server.mjs`, workdir `/app` |
| State | running since 2026-11-07T08:36Z, **0 restarts** |
| Publish | container 8097 → host **127.0.0.1:8197 only** (no Caddy route; not on the public surface) |
| Network | dedicated Docker network `vet-sandbox-net` — verified sole member is the vet container itself |
| Mounts | `/opt/helmian-vet-sandbox/{evidence,ledger,runs}` (rw), and `/var/run/docker.sock` (rw — this is how it spawns disposable sibling containers; also the named worst-case risk, §6 of the design doc) |
| Env keys | `VET_SANDBOX_TOKEN`, `VET_PORT` (=8097), `VET_BASE` (=/opt/helmian-vet-sandbox), `VET_IMAGE` (=helmian-vet-sandbox:0.2.4). Values never printed in this audit. |

**Source (on the box, read-only):** `/opt/helmian-vet-sandbox/app/` — `server.mjs` (283 lines), `runner.mjs` (MCP candidates), `runner-page.mjs` (workspace-page candidates), `apparatus-harness.mjs`, `fetch.sh`, `Dockerfile`, and `app/core/` holding the MCP install pipeline's own modules copied unmodified: `mcp-install-pipeline.mjs`, `mcp-code-audit.mjs`, `mcp-sandbox.mjs`, `mcp-sandbox-observer.mjs`, `mcp-install-ledger.mjs`, `mcp-approval.mjs`.

**API (from server.mjs):**

- `GET /health` — no auth; returns `{ok, service, version, busy}`.
- `POST /vet` — requires `Authorization: Bearer <VET_SANDBOX_TOKEN>` (constant-time compare) **and** header `X-Vet-Intent: execute-foreign-code`. Accepts either JSON `{"gitUrl": "https://…"}` (https only; `file://` confined to the box testdata dir) or a raw `.tar.gz` upload (max 25 MB). Header `X-Vet-Candidate-Kind` selects `mcp-server` (default) or `workspace-page`. One run at a time; a second submission gets `409`.
- `GET /runs/:id` — Bearer-gated; returns the stored `vet-report.json` for a past run.

**How a run works (server.mjs + fetch.sh + runner.mjs):**

1. **Fetch** in a disposable, network-enabled container that executes no candidate code: `git clone --depth 1 --no-recurse-submodules` with `.git` stripped, or tar extraction that rejects absolute/`..` entries before unpacking. Fetched trees get permissions normalized (`chmod -R a+rX`, contents untouched) so an unreadable tree can never audit as "clean over zero files."
2. **Vet** in a second disposable container: `--network none`, read-only rootfs, tmpfs `/tmp`, uid `node` (1000), `--cap-drop ALL`, `no-new-privileges`, 512 MB / 1 CPU / 128 pids, 120-second wall clock, candidate mounted read-only at `/candidate`, environment contains only the run id and `HOME=/tmp`.
3. Inside it, the pipeline's stages 1–3 run unmodified:
   - **Stage 1 — declared manifest + fingerprint.** Reads `helmion-candidate.json` (what the candidate declares: purpose, allowed hosts, allowed env, tools) and computes a SHA-256 fingerprint over file contents + permission surface. Zero fingerprintable files = the runner **refuses to issue any verdict**.
   - **Stage 2 — code read.** Static audit (`mcp-code-audit.mjs`); rule families seen in code include `credential/`, `env/`, `network/`, `obfuscation/`, `package/`, `process/`, `coverage/`. Any CRITICAL finding halts the run **before execution** → `blocked-by-code-read`.
   - **Stage 3 — observed run.** The candidate actually runs, watched by the pipeline's in-process observer (a second, independent layer inside the container). The report records network attempts, contacted/undeclared hosts, subprocess attempts, writes outside the sandbox, credential-path reads, env enumeration, and a per-run canary token. Misbehaviour → `flagged-in-sandbox`. For `workspace-page` candidates, stage 3 instead executes the page under a pinned "apparatus harness" baked into the image; the candidate's own harness copy is hash-compared and never trusted as judge.
4. **Evidence out, then destruction verified.** The runner writes only `vet-report.json` + `ledger.jsonl` lines; the service copies them to `/opt/helmian-vet-sandbox/evidence/<runId>/`, appends the lines to the central ledger (`/opt/helmian-vet-sandbox/ledger/ledger.jsonl`), destroys every container carrying the run's label, and **verifies** no container or volume with that label remains before answering. The response includes `runContainerDestroyed` only after that check passes.

**Final verdicts:** `vetted-clean-awaiting-human` (explicitly *not* an approval), `blocked-by-code-read`, `flagged-in-sandbox`, `evidence-missing`, `runner-error`.

---

## 2. What triggers it — which inbound flows route through it today

### Live wiring: exactly one production caller

**The Helmian Author service** (`helmian-author.service`, systemd, active) is the only caller on the box.

- Client: `/opt/helmian-author/src/vet.mjs` — POSTs the build's tarball to `http://127.0.0.1:8197/vet` with the Bearer token, intent header, and `X-Vet-Candidate-Kind: workspace-page`; retries `409` with backoff inside the build deadline; fetches the full report via `GET /runs/:id`.
- Call site: `/opt/helmian-author/src/author.mjs` — the build flow is *lease → engine → package → **vet** → deliver*. The vet submission itself is Guard-gated (`guardGate(build, 'author.vet.submit', …)`). Verdict handling is a **hard gate**:
  - `vetted-clean-awaiting-human` → delivery proceeds;
  - `blocked-by-code-read` → build terminated ("it never executed");
  - `flagged-in-sandbox` → build terminated ("executed and misbehaved in the sandbox");
  - `evidence-missing` / `runner-error` → one retry, then build terminated.
- Token distribution confirms exclusivity: across all of `/opt`, only two env files name the vet token/URL — `/opt/helmian-vet-sandbox/service.env` (the service's own) and `/opt/helmian-author/author.env` (filenames verified; values never read).
- The Author lane's scratch regression scripts (`/opt/helmian-author/scratch/vet-regression4/5/6.mjs`) also call the service — test traffic, part of the Nov 7 run history.

So what actually gets vetted today is narrow and specific: **workspace pages the Helmian Author builds itself**, before the Author delivers them. That is a real, enforced gate — but it covers Helmian's own output, not inbound third-party material.

### Flows that do NOT route through it (grep-verified)

- **MCP server installs.** The five-stage install pipeline (`src/core/mcp-install-pipeline.mjs`: discovery → code read → sandbox → human approval → install, plus drift checks) runs **locally** via the `helmion mcp-install` CLI (`/opt/helmian-hands-mcp/src/bin/helmion.mjs`, mirrored in `/opt/helmian-cloud-agents/src/app/bin/helmion.mjs`) on whatever machine performs the install. Its stage-3 sandbox is the in-process observer — monkey-patching whose own source header states "WHAT THIS IS NOT: containment… The process still runs as the invoking user with that user's full filesystem permissions." A box-wide grep for `8197`, `helmian-vet`, `cloud-vet`, `execute-foreign-code`, `VET_SANDBOX` across `/opt/helmian`, `/opt/helmian-cloud-agents`, `/opt/helmian-hands-mcp`, `/opt/helmian-door*`, `/opt/helmian-exchange`, `/opt/helmian-feed-receiver`, `/opt/helmian-credential-service`, and `/opt/toolconn-live` found **zero references to the cloud vet service** outside the Author and the vet sandbox's own tree.
- **Cloud agent plugin installs.** `/opt/helmian-cloud-agents/src/app/src/agent/plugins.mjs` refuses remote candidates outright and redirects to `helmion mcp-install --root <cloned-path>` — i.e., back to the local pipeline, not to the sandbox.
- **Repo imports (GitHub/GitLab), file downloads, agent/tool installs, connector catalog.** No call sites exist. The catalog sync (`/opt/helmian-catalog-sync`) has no vet references. The vet service's own git-URL submission path has **no production caller** — it was exercised only by the Oct 23 proof runs (fixtures under `/opt/helmian-vet-sandbox/testdata/`, `benign.git` + `benign-src`, still present).
- The design doc said this plainly at build time (§8.7: "Not wired anywhere — no Caddy route, no Helmian cloud surface, no EXE integration, no change to the local pipeline. Deliberate, per the build brief."). Since then, exactly one wire was added: the Author's.

---

## 3. Does it work?

**Read-only probes run today (2026-11-23):**

- `GET http://127.0.0.1:8197/health` → `{"ok":true,"service":"helmian-vet-sandbox","version":"0.1.0","busy":false}` — service up and idle. (Version string in code says 0.1.0; image tag is 0.2.4 and the page runner reports 0.2.0 — cosmetic drift, noted in §4.)
- `GET /runs/2a209618-fb6e-49fa-99b6-86ad00ddf7f0` with the service token → the full stored `vet-report.json` was returned. Without a token → `401`. Both read paths and the credential gate work.
- `docker network inspect vet-sandbox-net` → sole member `helmian-vet-sandbox`. The isolation claim in the design checks out.
- No submission was made (per audit limits), so today's end-to-end execution path is **UNVERIFIED** — see the test plan below. Everything else in this section is persisted evidence from real past runs.

**Persisted evidence (read from disk):**

- 35 run reports in `/opt/helmian-vet-sandbox/evidence/`: **23 `vetted-clean-awaiting-human`, 10 `flagged-in-sandbox`, 1 `blocked-by-code-read`, 1 `runner-error`**. Kinds: 28 workspace-page, 7 mcp-server.
- Central ledger: 104 entries (`discovered` 69, `sandboxed` 33, `flagged` 1, `blocked` 1), spanning 2026-10-23 → 2026-11-07.
- Author ledger: 12 `vet.decided` events; real pages vetted include the Banyan evaluation pages and `dairyforge-water-cost-per-wash` (Nov 7).
- **Bad sample, proven:** the repo's poisoned fixture (`note-keeper-mcp`, the `poisoned-note-keeper` candidate) → `blocked-by-code-read` with **8 critical + 3 high + 2 medium** findings carrying file:line citations (`env/enumeration` index.mjs:26–27, `obfuscation/eval` index.mjs:32, `network/undeclared-host` index.mjs:42). It was never executed.
- **Benign sample, proven:** `unit-converter-mcp` and `fixture-hours-check` → `vetted-clean-awaiting-human`, with the observer recording the full behaviour surface (networkAttempts, contactedHosts, undeclaredHosts, subprocessAttempts, writesOutsideSandbox, credentialPathReads, envEnumerated). Per design doc §9, the benign fixture produced the identical fingerprint via git and archive transports.
- **Idle since Nov 7:** the last vet activity anywhere is 2026-11-07T12:56Z. The container has been up ~2 weeks with 0 restarts, but nothing has been submitted in ~16 days.

**Exact test plan for the next step (not run — needs its own go):**

1. *Benign:* tar the Helmian repo's benign fixture (`test-support/mcp-candidates/benign-unit-converter`) and POST it to `http://127.0.0.1:8197/vet` as `application/gzip` with the token + intent headers. Expect `vetted-clean-awaiting-human`, exit 0, `runContainerDestroyed: true`, and a new evidence dir + ledger lines.
2. *Bad, static:* the repo's `poisoned-note-keeper` fixture the same way. Expect `blocked-by-code-read`, exit 2, critical findings with citations, and no execution.
3. *Bad, behavioural:* a throwaway MCP server that passes the code read but, when run, attempts an undeclared outbound host and a write outside its working dir. Expect `flagged-in-sandbox` with the attempts recorded in the observed-behaviour summary.
4. After each: confirm zero containers/volumes carry the run label and the box's container totals are unchanged. All three stay confined by construction (loopback-only API, network-none run containers, verified destruction).

---

## 4. Gap list — what stands between what exists and Troy's design

1. **Coverage is one lane, not every inbound road.** Only Author-built workspace pages are vetted. MCP installs, repo imports, downloads, agent/tool installs, and catalog connectors have no route into the sandbox. Troy's design starts with "anything coming in"; today that's one self-produced content type.
2. **MCP installs — the highest-risk inbound flow — use the weaker sandbox.** The local pipeline's stage 3 is in-process observation, explicitly not containment, running as the installing user. The OS-level cloud sandbox exists on the same box and is never called by that pipeline (zero references, grep-verified).
3. **Verdicts bind nothing outside the Author.** The vet service never installs, and no install path consumes its reports. A candidate could be `flagged-in-sandbox` on the box and still be installed through the local pipeline, which keeps its own separate ledger and stages 4–5.
4. **No tweak/repair loop.** Troy's design includes Helmian fixing code that "needs tweaking" inside the sandbox and then installing it. The pipeline only issues verdicts (clean / blocked / flagged); there is no repair-and-re-vet path anywhere.
5. **No instruction scan.** READMEs, tool descriptions, and SKILL.md files are never scanned for prompt injection (design doc §8.4, still true in the code read). A code-clean candidate can still carry hostile instructions aimed at agents.
6. **Execution authority is a standing token, not a per-run Guard decision.** POST /vet is gated by a bearer token + intent header (design doc §5 calls this "a bridge, not the destination"; §8.1 names the signed per-run Guard approval as the designed next step). The Author's submission step is Guard-gated on the Author's side, but the vet service itself would accept any holder of the token.
7. **Runner and candidate share one container.** The candidate runs as the same uid as the runner and could theoretically write to `/evidence` directly (design doc §6/§8.2; the two-container split is designed, not built).
8. **Plain-Docker boundary, socket-holding service.** The run boundary is runc (shared host kernel); gVisor/Firecracker hardening is future work (§8.3). The service container holds the docker socket — host root if it were ever compromised; its only mitigations are loopback-only publish, the dedicated network, and the token gate. It must stay off the public surface until gap 6 closes.
9. **No public-path hygiene.** No per-user auth or quotas, no run queue (busy → 409), no SSRF allowlist beyond "https only," no AV/malware stage, no evidence retention policy, and the central ledger is local JSONL with no Neon mirror (design doc §8.5/§8.6).
10. **Private repos can't be vetted by URL.** server.mjs passes the git URL straight to `git clone` in the fetch container with no credential handling; private GitHub/GitLab repos would fail the fetch. Only public https repos or uploaded tarballs work.
11. **Idle and unwatched.** No runs since 2026-11-07. Whether any watch/heartbeat job monitors this service was not established (see UNVERIFIED). Version strings drift across the image (health 0.1.0, page runner 0.2.0, tag 0.2.4).

---

## UNVERIFIED

- **Today's end-to-end execution path.** No submission was made during this audit (by design). The fetch → vet → destroy cycle is proven by persisted evidence through 2026-11-07, not by a run today. The test plan in §3 closes this.
- **Local pipeline usage on Troy's PC / desktop.** The `helmion mcp-install` CLI and the desktop app's `McpSecurityRunner.cs` reference the pipeline; whether real MCP installs actually go through them today happens off-box and was not audited.
- **helmian.cloud web surface.** The cloud-agents tree was grepped for install/vet references; a full UI audit of every user-facing install surface was not performed.
- **Watch coverage.** Whether helmian-scribe-watch, the heartbeat, or any other job would notice the vet service dying was not checked.
- **All 10 flagged page reports.** One was sampled (its MCP-shaped `observed` slot is null; page runs store a `pageRun` summary instead). The full set was not enumerated finding-by-finding.
- **GitLab specifically.** Nothing in the code treats GitLab differently from any other https git remote; no GitLab submission appears in the evidence. Behaviour is inferred from the git path, not observed.
