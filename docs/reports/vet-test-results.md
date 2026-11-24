# Helmian Vet Sandbox — Live Test Results

**Date:** 2026-11-23 (America/Denver), ~21:58–22:10 MT · **Test of:** `helmian-vet-sandbox` on the Hetzner box, `POST http://127.0.0.1:8197/vet` (loopback only), per the 3-sample plan in `VET-AUDIT.md` §3.
**Method:** the audit's three samples submitted as `.tar.gz` uploads with the service token + `X-Vet-Intent: execute-foreign-code` header, token used server-side from the service's own env file and never printed. Nothing was installed anywhere; no config was changed; no container was restarted; the Author service was not touched.
**Service state before and after:** `GET /health` → `{"ok":true,"service":"helmian-vet-sandbox","version":"0.1.0","busy":false}`. Idle at the end, exactly as found.

## Verdict summary

| # | Sample | Expected | Got | Match |
|---|---|---|---|---|
| 1 | Benign fixture (`unit-converter-mcp`) | `vetted-clean-awaiting-human` | `vetted-clean-awaiting-human` | ✅ |
| 2 | Poisoned fixture (`note-keeper-mcp`) | `blocked-by-code-read`, never executed | `blocked-by-code-read`, sandbox stage `null` (never executed) | ✅ |
| 3a | Behavioural fixture, first submission | `flagged-in-sandbox` | `vetted-clean-awaiting-human` — **invalid sample** (see below) | ❌ sample defect |
| 3b | Behavioural fixture, corrected | `flagged-in-sandbox` | `flagged-in-sandbox` | ✅ |

**The end-to-end vet path works today.** First runs since 2026-11-07, and the full cycle — fetch → static code read → observed run in a disposable container → evidence persisted → run container destroyed and verified — executed correctly on every submission.

---

## Sample 1 — Benign (negative control)

- **Source:** `/opt/helmian/test-support/mcp-candidates/benign-unit-converter`, tarred as-is.
- **Run id:** `5e94228c-1c89-4496-a85a-4241f2636f70`
- **Response:** HTTP 200 · `finalDecision: vetted-clean-awaiting-human` · service exit code 0 · `runContainerDestroyed: true`
- **Code read:** clean — 0 critical / 0 high / 0 medium / 1 low / 2 info.
- **Observed run:** candidate exit code 0, 11 observer events, evidence complete. `networkAttempts: 1` to the declared host `rates.unit-converter-example.org`; `undeclaredHosts: []`; `writesOutsideSandbox: []`; env reads recorded by name (`UNIT_CONVERTER_CACHE_TTL` among them); no subprocess attempts, no credential-path reads, no canary leaks.
- **Fingerprint:** `b02bb8436184308d889fc101dba0ae6eaac8a573883dd929e423a469fd470ddc`
- **Evidence:** `/opt/helmian-vet-sandbox/evidence/5e94228c-1c89-4496-a85a-4241f2636f70/` (`vet-report.json`, `ledger.jsonl`, `runner.log`).

## Sample 2 — Poisoned (static bad sample)

- **Source:** `/opt/helmian/test-support/mcp-candidates/poisoned-note-keeper`, tarred as-is.
- **Run id:** `50a06c84-b99a-45f6-9dfe-4c2ac42fc4d0`
- **Response:** HTTP 200 · `finalDecision: blocked-by-code-read` · service exit code 2 · `runContainerDestroyed: true`
- **Code read:** blocked — **8 critical + 3 high + 2 medium**, identical counts to the historical run recorded in the audit. The sandbox stage is `null` in the report: **the candidate was never executed.**
- **Critical findings (file:line, from the persisted report):**
  - `env/enumeration` — index.mjs:26, index.mjs:27
  - `obfuscation/eval` — index.mjs:32
  - `network/undeclared-host` — index.mjs:42
  - `process/command-execution` — index.mjs:53
  - `credential/reads-secret-file` — index.mjs:60
  - `filesystem/write-outside-own-directory` — index.mjs:68
  - `package/install-hook` — package.json:8
- **High findings:** `process/child-process-import` — index.mjs:15 · `obfuscation/base64-blob` — index.mjs:30 · `obfuscation/hex-escaped-string` — index.mjs:38
- **Fingerprint:** `0c075f92405febdb3357de1f16f474b8ce192269f6980d5da58a86fce28fddf2`
- **Evidence:** `/opt/helmian-vet-sandbox/evidence/50a06c84-b99a-45f6-9dfe-4c2ac42fc4d0/`.

## Sample 3 — Behavioural (passes the code read, misbehaves when run)

**Fixture (created for this test, left in place):** `/opt/helmian-vet-sandbox/evidence-test/behavioural-fixture/` (`index.mjs`, `package.json`, `helmion-candidate.json`; a copy of `index.mjs` is also at `~/workspace/helmian-vet/behavioural-fixture-index.mjs`). It declares one host (`api.behavioural-fixture-example.org`) and one env var, contains no literal undeclared URL and no literal outside path, and at startup it (1) assembles the undeclared host `telemetry.behavioural-fixture-example.net` from string parts and fetches it, and (2) writes a marker to the system temp directory via `os.tmpdir()`.

### 3a — First submission: invalid sample, and a verdict-logic observation

- **Run id:** `b1a934e0-406b-4bf0-893b-ae27ef551aaf` · verdict `vetted-clean-awaiting-human`.
- **Cause (my error, not the sandbox's):** the fixture's first copy was written to the box through a shell heredoc nested inside the SSH command's quoting; the quote characters around its module specifiers were stripped in transit, so the file on the box was syntactically invalid (`node --check` → `SyntaxError` at the first import). The candidate died at parse time: candidate exit code 1, 3 observer events, zero attempts of any kind.
- **Observation worth keeping:** a candidate that crashes at parse (exit 1, no observed behaviour at all) still receives `vetted-clean-awaiting-human`. The report does record `candidateExitCode: 1`, but the verdict logic does not treat a dead-on-arrival candidate as a failure. Whether that is intended is UNVERIFIED (see below) — a candidate that cannot even start arguably proves nothing about its behaviour.

### 3b — Corrected fixture: flagged, as expected

- **Run id:** `361e2cdc-113d-4f22-85f8-7b68fe07249a`
- **Response:** HTTP 200 · `finalDecision: flagged-in-sandbox` · service exit code 3 · `runContainerDestroyed: true`
- **Code read:** clean — 0 critical / 0 high / 0 medium / 1 low / 1 info. The static read passed it, exactly as the fixture was designed to do; the catch happened at runtime.
- **Observed run:** sandbox verdict `misbehaved` · candidate exit code 0 · 12 observer events · evidence complete. Recorded attempts:
  - `networkAttempts: 1` — `contactedHosts: ["telemetry.behavioural-fixture-example.net"]`, `undeclaredHosts: ["telemetry.behavioural-fixture-example.net"]`
  - `writesOutsideSandbox: ["/tmp/vet-behavioural-fixture-marker.txt"]`
  - env read by name recorded (`BEHAVIOURAL_FIXTURE_MODE`); no subprocess attempts, no credential-path reads, no canary leaks.
- **Containment check:** no marker file exists in the host's `/tmp` — the write attempt was recorded inside the disposable run container (tmpfs) and died with it.
- **Fingerprint:** `5c94f37bb78806cb6e6a4f895c5a21be0bc75e496865653e9bae81c851c6a94c`
- **Evidence:** `/opt/helmian-vet-sandbox/evidence/361e2cdc-113d-4f22-85f8-7b68fe07249a/`.

## Container destruction and evidence persistence (all runs)

- Every response carried `runContainerDestroyed: true` (the service verifies before answering).
- Independent check: `docker ps -a` name list taken before the first submission and after the last — **byte-identical (32 containers)**; the only container on the vet image is the `helmian-vet-sandbox` service itself; no vet volumes exist.
- Evidence directory count went 36 → 40 (one new dir per run, each holding `vet-report.json` + `ledger.jsonl` + `runner.log`); the central ledger `/opt/helmian-vet-sandbox/ledger/ledger.jsonl` grew 104 → 116 lines (3 lines per run × 4 runs).

## UNVERIFIED

- **Workspace-page candidates** (`X-Vet-Candidate-Kind: workspace-page`, the Author's kind) were not exercised in this test — only `mcp-server` candidates were submitted.
- **Git-URL submissions** were not exercised; all three samples went in as tarball uploads.
- **The parse-crash verdict (3a):** the fact is recorded above; whether `vetted-clean` for a candidate that exits 1 before doing anything is intended behaviour or a verdict-logic gap was not determined — no code was changed and the service was not probed further.
- **Other escape shapes** (raw sockets to a runtime-assembled host, worker threads, re-imported clean builtins, native addons) were not tested; the observer's own report text names several of these as known non-protections of the process-level layer (the container is the OS boundary).
- **Watch coverage** — whether anything would notice the vet service dying — remains unchecked, as in the audit.
- **No second behavioural variant** (e.g. subprocess attempt or credential-path read at runtime) was run; the static layer already blocks those shapes on sight, and the one behavioural sample covered the two runtime-only shapes (network + write) the audit plan named.
