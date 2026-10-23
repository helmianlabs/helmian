# Hands workspace root grants

How a folder **outside** the PC spoke's built-in workspace roots becomes
reachable — one folder at a time, read-only, only after a human approval, and
revocable at any moment. Built 2026-10-23 (branch `feat/bridge-root-grants`).

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
standing access. **Gap:** Executive Guard has no root-grant issuance endpoint
today; until it grows one (or a dedicated grant signer holding the same key),
a grant envelope must be produced by whatever signs Guard decisions, out of
band. Nothing in this bite lets the hub, a client, or the spoke mint one.

## Operator flow (works today, manual grant file)

```powershell
cd E:\Helmion
# 1. Ask (records the request; grants nothing):
node bin\hands-spoke.mjs request-root "F:\AutoVector" --reason "read the new autovector build"
#    -> %APPDATA%\Helmian\root-requests\<requestId>.json
# 2. A human approves the request (see "Hub flow" below) and a signed grant
#    envelope (grant.json) comes back.
# 3. Activate (verifies signature, device binding, and that the folder exists):
node bin\hands-spoke.mjs add-root-grant grant.json
# 4. Inspect / revoke at any time:
node bin\hands-spoke.mjs list-root-grants
node bin\hands-spoke.mjs revoke-root-grant <grantId>
```

Restarting the HelmianBridge service after activation is only needed to see
the granted roots in the spoke's startup log line; access itself is live
immediately because grants reload per operation.

## Hub flow (spec — not built in this bite)

Deliberately **not** faked here: there is no new approval surface in this
branch. The intended flow, using machinery that already exists:

1. The spoke's root-request record (`request-root` above, or an MCP-side
   equivalent) reaches the hands hub with `rootPath`, `requester`,
   `spokeDeviceId`, `reason`, and `actionHash` — the hash of
   `buildRootGrantAction(...)` from the shared protocol.
2. The hub stores the request (pending) and calls Executive Guard's existing
   `/v1/decisions` with that action. Guard's human-approval rule puts it in
   front of Troy, exactly like a mutating hands call today; deny or expiry
   closes the request with nothing granted.
3. On approval, a **grant issuer** (new: either an Executive Guard extension
   or a small signer service holding the Guard signing key) mints the grant
   envelope above — claims copied from the request, `approvalId`/`decidedBy`
   from the Guard approval, `exp` per policy (or none = until revoked).
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
