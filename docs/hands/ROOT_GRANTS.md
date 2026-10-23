# Hands workspace root grants

How a folder **outside** the PC spoke's built-in workspace roots becomes
reachable — one folder at a time, read-only, only after a human approval, and
revocable at any moment. Spoke side built 2026-10-23 (branch
`feat/bridge-root-grants`); the grant signer below was added on
`feat/bridge-grant-signer`.

## The two tiers

| Tier | Where it lives | Access |
|---|---|---|
| Default roots | `roots` in `%APPDATA%\Helmian\hands-spoke.json` (set at `pair` time) | Read tools, plus mutating tools with a human-approved Guard decision — unchanged from before |
| Granted roots | Signed entries in `%APPDATA%\Helmian\roots.grants.json` | **Read-only**: `list_files`, `read_file`, `search_files`. Every mutating tool refuses under a granted root, even with a valid Guard approval, and refuses *before* the single-use Guard decision is consumed |

There is no mechanism here that grants a whole drive, and none that grants
write access outside the default roots.

## The grant envelope

A grant is a signed envelope in the same shape as an Executive Guard decision
— `{ payload, signature, keyId }`, Ed25519 over the canonical-JSON payload
string — verified on the PC against the **same Guard public key** pinned by
`pin-guard`. The claims differ from an action decision on purpose:

```json
{
  "aud": "helmian-executive-guard-root-grant-v1",
  "grantType": "root",
  "grantId": "<unique id>",
  "verdict": "allow",
  "approvalId": "<the human approval that created it>",
  "decidedBy": "<the human>",
  "rootPath": "F:\\AutoVector",
  "scope": "read-only",
  "spokeDeviceId": "pc-troy",
  "requestId": "<optional root-request id>",
  "iat": 1790000000,
  "exp": 1795000000
}
```

Rules the spoke enforces on **every load** (`verifyRootGrant` in
`hands-mcp/src/shared/protocol.mjs`):

- signature must verify against the pinned key — no pinned key, no grants;
- audience must be the root-grant audience (an action decision cannot be
  replayed as a grant, and a grant cannot be replayed as an action decision:
  action verification requires the decision audience, a nonce, and an action
  hash binding to one tool call);
- `approvalId` + `decidedBy` are required — no human, no grant;
- `rootPath` must be one absolute folder path; `scope` must be `read-only`;
- `spokeDeviceId` must equal this spoke's device id — a grant file copied to
  another PC opens nothing there;
- `exp` is optional: with one, the grant dies at expiry; without one, the
  grant lasts **until revoked** (its entry is removed from the grants file).
  The executor reloads the file per file operation, so revocation takes
  effect immediately, with no restart.

### Why this is not just a Guard decision

Executive Guard's current decision contract cannot issue a standing grant:
decisions are bound to one tool call's arguments hash, carry a single-use
nonce, and are intentionally short-lived (the spoke records each decision id
as spent before running). Reusing `verifyApproval` for a folder grant would
either expire in minutes or require replaying a spent decision. The grant
envelope therefore reuses the decision's **cryptography and pinned key** —
the parts that make the PC independent of the hub — with claims shaped for
standing access. **Issuance:** the grant signer
(`src/hands/root-grant-signer.mjs`, CLI `bin/hands-grant-signer.mjs`) mints
these envelopes — see "Issuing a grant" below. Executive Guard's decision
endpoint still cannot issue one (a decision is the wrong instrument), and
nothing in the hub, a client, or the spoke can mint one: the signer is a
separate program that runs only where the Guard signing key lives.

## Issuing a grant (the signer)

`src/hands/root-grant-signer.mjs` is the issuer, with a CLI in the same
style as the spoke's:

```powershell
# On the machine that holds the Guard signing key — never on the PC:
node bin\hands-grant-signer.mjs sign <request.json> `
  --key <guard-private-key file> --key-id <id> `
  --approval-id <id> --decided-by <name> `
  [--expires-at <ISO time>] [--out <grant.json>]
```

Inputs are the spoke's root-request record and the Guard private key, loaded
from the file named by `--key` (PKCS#8 PEM or JWK — the contents are never
printed or copied). Issuance fails closed, before anything is signed:

- **No recorded human approval, no grant.** `approvalId` + `decidedBy` are
  required inputs; there is no flag combination that mints without them.
- The request record must hash to its own `actionHash`. A record edited
  after it was written — re-aimed at another folder, another device, a wider
  scope — no longer hashes to it and is refused, so what gets signed is
  exactly what was approved.
- Only the record's own claims are issuable: one absolute folder, `read-only`
  scope, the record's spoke device. The envelope also carries the request's
  `actionHash`, binding the grant to the approved request.
- An `--expires-at`, when given, must be in the future; omitting it mints an
  until-revoked grant.

The output is the bare envelope `{ payload, signature, keyId }`, written
mode 0600. Before returning, the signer verifies its own envelope with the
spoke's `verifyRootGrant` against the key's public half, so a signer/verifier
drift fails at issuance instead of on the PC. The CLI also prints the key's
public `x`, so the operator can confirm it matches the `x` pinned on the PC.

## Operator flow (works today, manual grant file)

```powershell
cd E:\Helmion
# 1. Ask (records the request; grants nothing):
node bin\hands-spoke.mjs request-root "F:\AutoVector" --reason "read the new autovector build"
#    -> %APPDATA%\Helmian\root-requests\<requestId>.json
# 2. A human approves the request (see "Hub flow" below); the operator then
#    signs it with the Guard key and a signed grant envelope comes back:
#    node bin\hands-grant-signer.mjs sign <request.json> --key <guard key file> `
#      --key-id <id> --approval-id <id> --decided-by <name> --out grant.json
# 3. Activate (verifies signature, device binding, and that the folder exists):
node bin\hands-spoke.mjs add-root-grant grant.json
# 4. Inspect / revoke at any time:
node bin\hands-spoke.mjs list-root-grants
node bin\hands-spoke.mjs revoke-root-grant <grantId>
```

Restarting the HelmianBridge service after activation is only needed to see
the granted roots in the spoke's startup log line; access itself is live
immediately because grants reload per operation.

## Hub flow (partly spec — the issuer is built, the plumbing is not)

The signer above is step 3's grant issuer, built. Still deliberately **not**
built: the hub plumbing around it — there is no new approval surface in this
branch, the spoke's request record does not yet travel to the hub on its own,
and no Guard endpoint mints grants. The intended flow, using machinery that
already exists:

1. The spoke's root-request record (`request-root` above, or an MCP-side
   equivalent) reaches the hands hub with `rootPath`, `requester`,
   `spokeDeviceId`, `reason`, and `actionHash` — the hash of
   `buildRootGrantAction(...)` from the shared protocol.
2. The hub stores the request (pending) and calls Executive Guard's existing
   `/v1/decisions` with that action. Guard's human-approval rule puts it in
   front of Troy, exactly like a mutating hands call today; deny or expiry
   closes the request with nothing granted.
3. On approval, the grant signer (`src/hands/root-grant-signer.mjs`, run
   wherever the Guard signing key lives — an Executive Guard extension or a
   small signer service) mints the grant envelope above — claims copied from
   the request, `approvalId`/`decidedBy` from the Guard approval, `exp` per
   policy (or none = until revoked).
4. The envelope travels back to the PC (operator hand-off as in step 3 of the
   manual flow, or a future spoke poll message type) and `add-root-grant`
   activates it. The hub never touches the PC's grants file directly.
5. Revocation stays local and instant (delete the entry). A hub-side
   revocation list is a possible later addition; it is not required for the
   local kill switch to work.

## Tests

`hands-mcp/test/root-grants.test.mjs` (9 tests): signature/tamper/unsigned/
wrong-device/expired/write-scope rejection, grants-file loading (one bad
entry poisons nothing), activation refusing to write unverifiable grants,
ungranted → granted read access for list/read/search on one running executor,
mutating refusal under a grant (decision not consumed; default-root approved
writes still run), revocation by id and by path closing access immediately,
expired grants opening nothing, spoke startup loading device-bound grants,
and the root-request record shape.

`hands-mcp/test/root-grant-signer.test.mjs` (7 tests): issue→verify round
trip through the spoke's own `activateRootGrant`/`loadRootGrants`, tampered
envelope rejected, wrong-device and wrong-key rejection, issuance refused
without `approvalId` or without `decidedBy`, a request record edited after
it was written refused (actionHash mismatch, scope widening, device swap),
expiry must be future at issuance and the spoke rejects the grant once it
passes, and key loading (PEM and JWK load and sign; an RSA key is refused).
