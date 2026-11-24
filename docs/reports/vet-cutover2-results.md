# Vet Cutover — Road A + Resume: COMPLETE. The Guard gate is live end to end

**Date:** 2026-11-23 (America/Denver) · **Spec:** `VET-CUTOVER-RESULTS.md` (the stopped pass) + Main's Road A ruling — teach the Guard the `vet-submission` kind properly; vet asks are never filed under a wrong label. Troy's ruling stands throughout: the recorded decider is the **Auto Approver** (principal `auto-approve`), never a human tap.
**Outcome in one line:** Phase 1 taught the Executive Guard the kind (one line in `action.mjs`, one rule in the live policy, new Guard image) with all controls proven unchanged; Phase 2 then ran the original cutover to completion — 4a files in, bite 4b landed in all three box trees, a `vet-cli` device token issued, the Auto Approver's vet class added, the vet image rebuilt, and the flag flipped **last**. The real-path verification passed on both fixtures: the benign candidate went through CLI → Guard → Auto Approver → vet and came back `vetted-clean-awaiting-human`; the poisoned candidate was consumed-and-blocked by the service (`blocked-by-code-read`). **Final flag state: ON** (`VET_REQUIRE_GUARD_DECISION=1`), and the service has never been left flag-on-and-broken at any point.

---

## PHASE 1 — the Guard learns the kind

### Source of truth (named, per the brief)

The Guard's image is built from the **box tree** `/opt/executive-guard/src/` (repo layout; `executive-guard/deploy/Dockerfile`, compose at `executive-guard/deploy/docker-compose.yml`, context `../..`). It is **not** a git checkout. Backup discipline applied to every file changed.

**Drift finding that shaped the build:** the host tree carries substantial *undeployed* changes vs the running image (`MAX_SUMMARY_CHARS` 4000 vs the live 500; auditor tokens; approver signing keys — the "auditability fixes"). Building the new Guard image from the host tree would have smuggled all of that into production untested. The new image was therefore built from a staging context copied **out of the live container** (`/opt/executive-guard/build-vetkind/context/` — the exact bytes the fleet is running), with the single kind line patched in. The host source tree received the identical patch (backup `action.mjs.bak-20261123-vetkind`) so the source of truth carries the change for future builds; the pre-existing drift is unchanged and remains the fleet's to reconcile.

### The two changes

1. **`action.mjs`** — `ACTION_KINDS` gains one entry, nothing else:
   ```
   'vet-submission', // foreign code submitted to the vet sandbox for examination
   ```
   Applied to both the staging context (what the image was built from) and the host source tree. Post-build diff of the staging context against the live container's code: **only `action.mjs` differs, only that line.**
2. **Live policy** `/opt/executive-guard/policy/author-policy.json` (backup `author-policy.json.bak-20261123-vetkind`) — one rule added after `destructive-needs-approval`, mirroring its shape:
   ```json
   { "id": "vet-submission-needs-approval",
     "when": { "kinds": ["vet-submission"], "sites": ["helmian-vet-sandbox"],
               "anySignal": ["vet:execute-foreign-code"] },
     "verdict": "ask",
     "reason": "Foreign code is about to be executed in the vet sandbox. A recorded approval must decide it." }
   ```
   **Policy reload semantics (the stopped pass's open question, now answered by code read):** the policy is read **once at startup** (`bin/executive-guard.mjs` does `readFileSync(EXEC_GUARD_POLICY)` before constructing the server) — no live re-read. The rule therefore rode the recreate below, as the brief anticipated.

### Image + recreate

- Built `executive-guard:vetkind-20261123` from the staging context with the fleet's own deploy Dockerfile. **Rollback tag = the previous image `executive-guard:provenance-20261121`**, and the previous container is retained, stopped, as `executive-guard-pre-vetkind` (instant rollback, §Rollback).
- Recreated `executive-guard` with the compose-pinned parameters exactly (user `10001:10001`, env file `/opt/executive-guard/app.env`, `127.0.0.1:8787`, volumes `eg-keys`/`eg-audit`, policy bind, network `helmian-net`, restart `unless-stopped`). Healthy; startup log shows the **same signing keyId `cef0581fd39613f2`** (the key volume was never touched — the vet pin in Phase 2 is against the same key the fleet already trusts).

### Phase 1 proofs (all passed)

Pure functions, the **new container's own** `policy.mjs` + `action.mjs`, the live policy file, bite 4a's exact `buildVetGuardAction` descriptor (benign fixture fingerprint `b02bb843…`):

| Probe | Result |
|---|---|
| vet descriptor → `normalizeAction` | OK, `kind: "vet-submission"` (previously: refused `unknown action kind`) |
| vet descriptor → `evaluatePolicy` | **`{"verdict":"ask","ruleId":"vet-submission-needs-approval"}`** |
| control: identical action, `kind: "agent.tool"` | `{"verdict":"ask","ruleId":"destructive-needs-approval"}` — unchanged |
| control: benign `prompt.send`, no signals | `{"verdict":"allow","ruleId":"clean-prompt"}` — unchanged |

Live probe against the recreated Guard (`POST /v1/decisions`, an existing device token, read in-script and never printed):

- Vet descriptor → **HTTP 202**, `verdict: "ask"`, signed decision payload carrying `ruleId: "vet-submission-needs-approval"`, `approvalId: 77d07c20-b8ed-492e-ac05-09604fff7089`. (That probe approval was filed under the probing device, is outside every Auto Approver class, and was correctly left pending — it expires on the Guard's 12 h approval TTL.)
- Benign `prompt.send` → **HTTP 200, verdict `allow`**.
- **Auto Approver service: untouched by Phase 1 and healthy** — it logged `auto-approve.skipped-out-of-scope` for the probe approval (device/rule not yet in its list at that point: correct fail-closed), proving it polls the recreated Guard normally. Its only errors all night were two lines during the seconds the Guard container was being swapped.

No control regressed → no rollback; Phase 2 proceeded.

---

## PHASE 2 — the cutover, resumed at Step 2

### Step 2 — 4a files into the vet tree + Guard key pinned

- `/opt/helmian-vet-sandbox/app/server.mjs` backed up (`.bak-20261123-vetcutover2`) and replaced with the 4a scratch copy (pre-deploy diff vs production confirmed as exactly the gate: the header block, imports, env consts, the `guardDecision` parameter, its two call sites, and the 403 status mapping — nothing else). `app/guard-decision.mjs` copied in new. Deployed md5s: server.mjs `fe07c497…`, guard-decision.mjs `7a805223…` (= the proven scratch values).
- Guard key pin (public key, from the live Guard's `GET /v1/keys`): keyId `cef0581fd39613f2`, `publicKeyJwk.x` written into the vet service env as `VET_GUARD_PUBLIC_KEY_X` + `VET_GUARD_KEY_ID` at the Step 6 recreate. Flag still off at this step.

### Step 3 — bite 4b code (commit `71fcf9e`) to the box trees

Base-md5 gates first (every tree file had to equal `451adc2`'s version — all did: mcp-vet `573e8ff3…`, pipeline `a29f21fa…`, test `3e96b4e8…`; the two `bin/helmion.mjs` files carried their bite-3 merged variants, as expected). Every file backed up to `.bak-20261123-vetcutover2` before overwrite; modes preserved.

- **Whole-file deploys** (deployed md5 = `71fcf9e` md5): `src/core/mcp-vet.mjs` (`d8a00a35…`) and `src/core/mcp-install-pipeline.mjs` (`a08852a4…`) into the hands tree (`/opt/helmian-hands-mcp/src`), the cloud-agents tree (`/opt/helmian-cloud-agents/src/app`), and the vet tree (`/opt/helmian-vet-sandbox/app/core/`); `test/mcp-install-security.test.mjs` (`352d4587…`) into the hands tree (the other trees don't carry it, as in prior bites).
- **`bin/helmion.mjs` surgical merges** (anchor-checked, one occurrence each, refuse-if-present): bite 4b's exact delta — the 5-line Guard comment block, the 9-line `HELMION_GUARD_URL`/`HELMION_GUARD_DEVICE_TOKEN` pairing block, the one usage-line replacement — applied onto each tree's own variant. Merged-vs-original diff = exactly 15 lines (the bite's delta), tree-specific text untouched. Merged md5s: hands `f2d0d073…`, cloud-agents `2a1d56f2…`. `package.json` needed no change (4b adds no files; the `mcp-vet.mjs` check entry landed in bite 2's merge).
- Verification on the box: `node --check` passes on both bins and the deployed `server.mjs`; dynamic `import()` load tests pass for all seven deployed library files. (`server.mjs` itself refuses a bare import without its token env — its designed startup behaviour, not a load failure.)

### Step 4 — the requester device token

The Guard's existing provisioning road is its env: `EXEC_GUARD_DEVICE_TOKENS` in `/opt/executive-guard/app.env` (the same road that provisioned `hands-mcp`, `credential-service`, `troy-laptop`, `author-core`).

- `app.env` backed up (`app.env.bak-20261123-vetcutover2`); a new device **`vet-cli`** was appended to `EXEC_GUARD_DEVICE_TOKENS` with a freshly generated 32-byte urlsafe token. **The token value was generated and written inside the box-side script and has never been printed.**
- The CLI side landed at `/opt/helmian-vet-sandbox/vet-cli.env` (mode `600`, root): `HELMION_GUARD_URL=http://127.0.0.1:8787`, `HELMION_GUARD_DEVICE_TOKEN=<the token>`, plus the vet pair (`HELMION_VET_URL` / `HELMION_VET_TOKEN`, the latter read from the live vet container's env in-script, never printed) so one file carries the whole `--vet` + Guard configuration for the box CLI road.
- The Guard was recreated once more (same image, same parameters) to pick up the env; healthy, same keyId, startup log's device list now reads `[hands-mcp, credential-service, troy-laptop, author-core, vet-cli]`.

### Step 5 — the Auto Approver's vet class

`/opt/executive-guard/bin/auto-approve.mjs` (backup `.bak-20261123-vetcutover2`) gained exactly the briefed entry:

```js
{ deviceId: "vet-cli", ruleId: "vet-submission-needs-approval",
  site: "helmian-vet-sandbox", signal: "vet:execute-foreign-code",
  reason: "auto-approve helper: vet sandbox submission (per-run Guard gate, wiring bite 4)" }
```

One deliberate refinement, recorded here: the helper previously stamped **one global reason** (the credential class's text) on every decision. Stamping "credential-service password resolve" on vet decisions would have falsified the audit trail, so each allowlist entry now carries its own `reason` (the credential entry's is byte-identical to the old global string — its behaviour is unchanged) and `decide()` uses the matched class's reason. The header comment now names both classes. Service restarted; its start event lists both classes: `["credential-service/credential-password-resolve-needs-approval", "vet-cli/vet-submission-needs-approval"]`.

### Step 6 — vet image rebuild + recreate (flag still off)

- Built `helmian-vet-sandbox:0.2.5` from `/opt/helmian-vet-sandbox/Dockerfile` (bakes the updated `app/` tree, 4a files included). Previous image `0.2.4` retained; previous container retained, stopped, as `helmian-vet-sandbox-pre-vetkind`.
- Recreated with the original parameters (publish `127.0.0.1:8197→8097`, docker.sock + evidence/ledger/runs binds, network `vet-sandbox-net`) and env from a new root-only `/opt/helmian-vet-sandbox/run.env` (mode `600`): the original four values, `VET_IMAGE` advanced to `helmian-vet-sandbox:0.2.5`, plus the Step 2 key pin. Startup log: `per-run Guard decision gate: off (standing token only)`.
- **Flag-off proof:** a token-only git-mode run of the benign fixture behaved exactly as production did before the pass — run `7d508acf-1fff-40ef-a2f9-75782bda6e9e`, `vetted-clean-awaiting-human`, fingerprint `b02bb843…`, run container destroyed.

### Step 7 — flag flip + real-path verification

`VET_REQUIRE_GUARD_DECISION=1` appended to `run.env`; container recreated. Startup log: `per-run Guard decision gate: REQUIRED (decider principal "auto-approve", key pinned)`. Immediate negative control: a token-only submission with no envelope → **HTTP 403** (the gate is live and fail-closed).

**Benign — the full live chain** (box CLI, hands tree, env from `vet-cli.env`):
`node bin/helmion.mjs mcp-install review <benign-unit-converter> --vet` →
```
vet: vetted-clean-awaiting-human (cloud vet run 48f2dff3-eac5-4a64-96de-2b110134e608)
```
(the pipeline then stopped at its own stage-5 human install approval — NOT-A-TTY, nothing installed; that is the install gate, a separate human decision by design, not part of this chain). The Guard's hash-chained audit trail records the whole decision:

| seq | event | evidence |
|---|---|---|
| 23385 | `approval.requested` | `approvalId beea1bc9-e5c7-4984-97c7-4e4a75b48800`, `deviceId: "vet-cli"`, `kind: "vet-submission"`, `site: "helmian-vet-sandbox"` |
| 23386 | `approval.approved` | `approverId: "auto-approve"`, reason = the vet class's own reason |
| 23387 | `decision.issued` | `decisionId 8a92d437-3425-4080-995b-7a690d0a06bc`, `verdict: "allow"`, `ruleId: "vet-submission-needs-approval"` |

And the vet service's spent store contains exactly `8a92d437…` — the real 4a verifier consumed this client's envelope, single-use, before the run.

**Poisoned — two proofs:**
1. *Through the pipeline:* `mcp-install review <poisoned-note-keeper> --vet` → `BLOCKED-BY-CODE-READ` (critical 8, high 3, medium 2), nothing installed. The pipeline's own code read halts before stage 3, so no Guard ask was made and no envelope burned — the chain stayed intact by not being needed.
2. *Through the service* (the deployed `submitCandidateToVet` called directly, so the candidate reaches the vet stage): client and service fingerprints agree (`0c075f92…` both sides); the Auto Approver approved `57ca3c6e-dbce-4fe6-a71f-c8d48cbb54e4` under `vet-submission-needs-approval`; the service consumed decision `5c17bb3d-4a90-4367-bbc3-cbc24779aea9` (second entry in the spent store) and returned run `9c1c711b-0040-4e58-a9c6-8091721b9277`, **`finalDecision: "blocked-by-code-read"`** (critical 8, high 3, medium 2), run container destroyed.

**Verification hygiene, stated plainly:** my first two direct-submission attempts mis-called the fingerprint API from the test script (wrong argument shape, then the object instead of its string). Both times the Guard chain worked — the Auto Approver approved (`3c7be37f…`, `b7e2a697…`) — and the service **refused 403 on action-hash mismatch**, fail-closed, exactly as designed; those two decisions were never spent and expire on the 300 s decision TTL. The corrected third attempt is proof 2 above. The bugs were in the throwaway script, never in deployed code; the production pipeline path (proof 1 and the benign run) never hit them.

**Final state (verified at the end):** `executive-guard` healthy on `executive-guard:vetkind-20261123`; `helmian-vet-sandbox` up on `helmian-vet-sandbox:0.2.5`, `/health` ok, gate REQUIRED; `executive-guard-auto-approve` active with both classes; no other container was rebuilt or restarted at any point in either phase.

---

## Rollback points (all armed, none invoked)

- **Guard image/policy:** `docker stop executive-guard && docker rm executive-guard && docker rename executive-guard-pre-vetkind executive-guard`, restore `author-policy.json.bak-20261123-vetkind` over the policy file, `docker start executive-guard`. (Restoring the policy backup matters: the old image's `validatePolicy`/intake predates the kind.)
- **Guard device token:** restore `app.env.bak-20261123-vetcutover2` and recreate the Guard as in Step 4 — this also revokes `vet-cli`.
- **Auto Approver:** restore `auto-approve.mjs.bak-20261123-vetcutover2`, `systemctl restart executive-guard-auto-approve`.
- **Vet service:** `docker stop helmian-vet-sandbox && docker rm helmian-vet-sandbox && docker rename helmian-vet-sandbox-pre-vetkind helmian-vet-sandbox && docker start helmian-vet-sandbox` (the old container carries its own complete env: image `0.2.4`, no gate vars — token-only behaviour returns whole). Or, flag-only rollback: remove `VET_REQUIRE_GUARD_DECISION` from `run.env` and recreate on `0.2.5`.
- **Box trees:** restore the `.bak-20261123-vetcutover2` siblings (14 files: 2 vet app files' predecessor + 7 core/test files + 2 bins + the vet app `server.mjs` counted in the 2) — on-disk only, no service impact (host CLI reads at call time).
- **Host Guard source:** restore `action.mjs.bak-20261123-vetkind`. The staging build context is retained at `/opt/executive-guard/build-vetkind/` as the exact record of what the running Guard image was built from.

## UNVERIFIED

- **Spent-store durability across a vet container recreate:** `VET_BASE` resolves to a container-local path, so `guard-spent.json` lives in the vet container's writable layer and does **not** survive a recreate (it was reset by the Step 7 recreate; the two decisions spent since are the ones recorded above). A spent decision therefore cannot be replayed after a recreate only within its 300 s TTL and only with the original envelope in hand — the exposure is narrow and pre-existing in the 4a design (its own §8 named restart behaviour unexercised), but it is real and named here for Main: pointing `VET_BASE`'s spent store at one of the bind-mounted dirs would close it.
- **The Author lane's own vet client** still does not present envelopes (4b §5): if the Author submits to the vet service with the gate on, it will be refused 403 until that lane adopts the envelope flow. Fail-closed, but a real integration note for the Author lane.
- **`helmian-cloud-agents` / hands containers** still run image-baked pre-4b code inside their containers (the host trees they share are updated; container pickup needs their own rebuild pass — outside this pass's hard limits, as in every prior bite).
- **Git-mode submissions through the gate** were proven at the service level in 4a's scratch proofs and the flag-off git run in Step 6; the flag-on live-chain proofs above are archive (upload) mode, which is the mode the CLI road uses.
- **The credential class after the Auto Approver edit:** its allowlist entry and reason string are byte-identical to before and the service start event lists it first, but no live credential-password-resolve ask happened during this pass to re-prove it end to end.
